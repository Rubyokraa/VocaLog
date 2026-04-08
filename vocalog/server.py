import json
import os
import re
import time
import sqlite3
import hashlib
import secrets
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import parse_qs, urljoin, urlparse
from urllib.request import Request, urlopen


ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(ROOT_DIR, "public")
CUSTOM_LOGO_PATH = os.path.join(PUBLIC_DIR, "logo-custom.png")
DB_PATH = os.path.join(ROOT_DIR, "vocalog.db")
SESSION_TTL_SECONDS = 60 * 60 * 24 * 30  # 30 days


PLATFORM_MAP = {
    "reddit.com": "Reddit",
    "www.reddit.com": "Reddit",
    "open.spotify.com": "Spotify",
    "spotify.com": "Spotify",
    "www.open.spotify.com": "Spotify",
    "patreon.com": "Patreon",
    "www.patreon.com": "Patreon",
}


def db_connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = db_connect()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS cloud_state (
          user_id INTEGER PRIMARY KEY,
          state_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id)
        )
        """
    )
    conn.commit()
    conn.close()


def now_ms() -> int:
    return int(time.time() * 1000)


def hash_password(password: str, salt_hex: str) -> str:
    salt = bytes.fromhex(salt_hex)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return dk.hex()


def create_password_record(password: str):
    salt_hex = secrets.token_bytes(16).hex()
    pwd_hash = hash_password(password, salt_hex)
    return salt_hex, pwd_hash


def issue_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    conn = db_connect()
    cur = conn.cursor()
    created = now_ms()
    expires = created + SESSION_TTL_SECONDS * 1000
    cur.execute(
        "INSERT INTO sessions(token, user_id, expires_at_ms, created_at_ms) VALUES(?, ?, ?, ?)",
        (token, user_id, expires, created),
    )
    conn.commit()
    conn.close()
    return token


def get_user_by_token(token: str):
    if not token:
        return None
    conn = db_connect()
    cur = conn.cursor()
    ts = now_ms()
    cur.execute("DELETE FROM sessions WHERE expires_at_ms < ?", (ts,))
    cur.execute(
        """
        SELECT u.id, u.email
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at_ms >= ?
        """,
        (token, ts),
    )
    row = cur.fetchone()
    conn.commit()
    conn.close()
    return row


def _safe_str(x: str) -> str:
    if x is None:
        return ""
    return str(x).strip()


def platform_from_hostname(hostname: str) -> str:
    hostname = (hostname or "").lower()
    if hostname in PLATFORM_MAP:
        return PLATFORM_MAP[hostname]
    # Spotify can be subdomains; keep it simple by matching prefix.
    if hostname.endswith("open.spotify.com") or hostname.endswith("spotify.com"):
        return "Spotify"
    if hostname.endswith("reddit.com"):
        return "Reddit"
    if hostname.endswith("patreon.com"):
        return "Patreon"
    return "Other"


def normalize_author_key(name: str) -> str:
    name = (name or "").strip().lower()
    # Remove common punctuation; keep spaces.
    name = re.sub(r"[\u2019'\"`]+", "", name)  # quotes/apostrophes
    name = re.sub(r"[^a-z0-9\s-]", "", name)
    name = re.sub(r"\s+", " ", name).strip()
    # Compact spaces.
    return name.replace(" ", "-")


META_RE = re.compile(
    r"""<meta\s+(?P<attrs>[^>]+?)\s*/?>""",
    re.IGNORECASE | re.DOTALL,
)


def extract_meta_attributes(html: str) -> list[dict]:
    metas = []
    for m in META_RE.finditer(html):
        attrs = m.group("attrs")
        if not attrs:
            continue
        metas.append(parse_meta_attrs(attrs))
    return metas


ATTR_RE = re.compile(
    r"""(?P<key>[a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?P<quote>["'])(?P<val>.*?)(?P=quote)""",
    re.DOTALL,
)


def parse_meta_attrs(attrs: str) -> dict:
    out = {}
    for m in ATTR_RE.finditer(attrs):
        out[m.group("key").lower()] = m.group("val")
    return out


def pick_first_meta(meta_list: list[dict], prop: str, name: Optional[str] = None) -> str:
    prop = prop.lower()
    if name:
        name = name.lower()
    for meta in meta_list:
        if meta.get("property", "").lower() == prop:
            val = meta.get("content", "")
            if val:
                return _safe_str(val)
        if name and meta.get("name", "").lower() == name:
            val = meta.get("content", "")
            if val:
                return _safe_str(val)
    return ""


def extract_title_and_cover_and_author(html: str, base_url: str, page_url: str) -> dict:
    meta_list = extract_meta_attributes(html)

    og_title = pick_first_meta(meta_list, "og:title")
    tw_title = pick_first_meta(meta_list, "twitter:title")
    title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    title = og_title or tw_title or _safe_str(title_match.group(1) if title_match else "")

    # Cover extraction disabled by product decision.
    cover_url = ""

    og_audio = pick_first_meta(meta_list, "og:audio")
    tw_audio = pick_first_meta(meta_list, "twitter:audio")
    audio_url = og_audio or tw_audio or ""
    if audio_url:
        audio_url = urljoin(base_url, audio_url)
    else:
        # Best-effort: <audio src="..."> or <source src="...">.
        m = re.search(r"<audio[^>]*\s*src=[\"']([^\"']+)[\"']", html, re.I)
        if m:
            audio_url = urljoin(base_url, m.group(1).strip())
        else:
            m2 = re.search(r"<source[^>]*\s*src=[\"']([^\"']+)[\"']", html, re.I)
            if m2:
                audio_url = urljoin(base_url, m2.group(1).strip())

    # Author priority: music:creator > twitter:creator > author > byline hints.
    author_name = (
        pick_first_meta(meta_list, "music:creator")
        or pick_first_meta(meta_list, "twitter:creator")
        or pick_first_meta(meta_list, "og:site_name", name="author")  # unlikely but harmless
        or next(
            (m.get("content", "") for m in meta_list if m.get("name", "").lower() == "author" and m.get("content", "").strip()),
            "",
        )
    )

    # Fallback: try to parse "By X" from description/title.
    if not author_name:
        description = (
            pick_first_meta(meta_list, "og:description")
            or pick_first_meta(meta_list, "twitter:description")
            or ""
        )
        candidates = [title, description]
        for c in candidates:
            m = re.search(r"\bby\s+([A-Za-z0-9][A-Za-z0-9&'’.\- ]{1,60})\b", c or "", re.I)
            if m:
                author_name = m.group(1).strip()
                break

    # URL-based fallbacks for author name.
    # 1) Reddit user pages: /user/<name>/
    try:
        parsed = urlparse(page_url)
        hostname = (parsed.hostname or "").lower()
        if not author_name and hostname.endswith("reddit.com"):
            m = re.search(r"/user/([^/?#]+)/?", parsed.path)
            if m:
                author_name = m.group(1).replace("_", " ").strip()
    except Exception:
        pass

    # 2) Patreon: the title is often "CreatorName | Patreon"
    try:
        parsed = urlparse(page_url)
        hostname = (parsed.hostname or "").lower()
        if not author_name and hostname.endswith("patreon.com"):
            if title and "|" in title:
                author_name = title.split("|", 1)[0].strip()
    except Exception:
        pass

    author_name = author_name.lstrip("@").strip() if author_name else ""
    author_key = normalize_author_key(author_name) if author_name else "unknown"

    return {
        "title": title or "Untitled",
        "coverUrl": cover_url,
        "audioUrl": audio_url,
        "authorName": author_name,
        "authorKey": author_key,
    }


def fetch_html(url: str) -> str:
    # Use browser-like headers. Some sites behave differently for non-browser user agents.
    headers_a = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    headers_b = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    headers_c = {
        "User-Agent": "VocaLogMetadataProxy/0.1 (+local; no-auth)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    MAX_BYTES = 2_000_000
    last_err = None
    for headers in (headers_a, headers_b, headers_c):
        try:
            req = Request(url, headers=headers, method="GET")
            with urlopen(req, timeout=30) as resp:
                data = resp.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    data = data[:MAX_BYTES]
                encoding = getattr(resp, "headers", {}).get_content_charset() if hasattr(resp, "headers") else None
                if not encoding:
                    encoding = "utf-8"
                return data.decode(encoding, errors="ignore")
        except Exception as e:
            last_err = e

    raise last_err if last_err else Exception("fetch_html failed")


class Handler(BaseHTTPRequestHandler):
    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _get_bearer_token(self) -> str:
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return ""
        return auth[7:].strip()

    def _require_auth_user(self):
        token = self._get_bearer_token()
        return get_user_by_token(token)

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: str):
        # Minimal content-type mapping.
        ext = os.path.splitext(path)[1].lower()
        ctype = "application/octet-stream"
        if ext in [".html"]:
            ctype = "text/html; charset=utf-8"
        elif ext in [".js"]:
            ctype = "text/javascript; charset=utf-8"
        elif ext in [".css"]:
            ctype = "text/css; charset=utf-8"
        elif ext in [".png"]:
            ctype = "image/png"
        elif ext in [".jpg", ".jpeg"]:
            ctype = "image/jpeg"
        elif ext in [".svg"]:
            ctype = "image/svg+xml"

        with open(path, "rb") as f:
            data = f.read()

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/auth/me":
            user = self._require_auth_user()
            if not user:
                self._send_json(401, {"error": "Unauthorized"})
                return
            self._send_json(200, {"user": {"id": user["id"], "email": user["email"]}})
            return

        if self.path.split("?", 1)[0] == "/api/sync/pull":
            user = self._require_auth_user()
            if not user:
                self._send_json(401, {"error": "Unauthorized"})
                return
            conn = db_connect()
            cur = conn.cursor()
            cur.execute("SELECT state_json, updated_at_ms FROM cloud_state WHERE user_id = ?", (user["id"],))
            row = cur.fetchone()
            conn.close()
            if not row:
                self._send_json(200, {"state": None})
                return
            try:
                state_obj = json.loads(row["state_json"])
            except Exception:
                state_obj = None
            self._send_json(200, {"state": state_obj, "updatedAtMs": row["updated_at_ms"]})
            return

        if self.path.split("?", 1)[0] == "/logo-custom.png":
            if os.path.exists(CUSTOM_LOGO_PATH):
                self._send_file(CUSTOM_LOGO_PATH)
                return
            self._send_json(404, {"error": "Custom logo not found"})
            return

        if self.path.startswith("/api/metadata"):
            qs = parse_qs(urlparse(self.path).query)
            url = (qs.get("url", [""])[0] or "").strip()
            if not url:
                self._send_json(400, {"error": "Missing url"})
                return

            parsed = urlparse(url)
            if parsed.scheme not in ("http", "https"):
                self._send_json(400, {"error": "Only http/https URLs are supported"})
                return

            try:
                html = fetch_html(url)
                base_url = f"{parsed.scheme}://{parsed.netloc}"
                extracted = extract_title_and_cover_and_author(html, base_url=base_url, page_url=url)
                platform = platform_from_hostname(parsed.hostname or "")

                self._send_json(
                    200,
                    {
                        "platform": platform,
                        "title": extracted["title"],
                        "coverUrl": extracted["coverUrl"],
                        "authorName": extracted["authorName"],
                        "authorKey": extracted["authorKey"],
                        "url": url,
                    },
                )
            except Exception as e:
                self._send_json(
                    200,
                    {
                        "platform": platform_from_hostname(urlparse(url).hostname or ""),
                        "title": url,
                        "coverUrl": "",
                        "audioUrl": "",
                        "authorName": "",
                        "authorKey": "unknown",
                        "url": url,
                        "warning": str(e),
                    },
                )
            return

        # Static files
        rel = self.path.split("?", 1)[0]
        rel = rel.lstrip("/")
        if not rel:
            rel = "index.html"

        file_path = os.path.join(PUBLIC_DIR, rel)
        if os.path.isdir(file_path):
            file_path = os.path.join(file_path, "index.html")

        if os.path.exists(file_path):
            self._send_file(file_path)
            return

        # SPA fallback
        index_path = os.path.join(PUBLIC_DIR, "index.html")
        if os.path.exists(index_path):
            self._send_file(index_path)
            return

        self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]

        if path == "/api/auth/signup":
            body = self._read_json_body()
            email = str(body.get("email", "")).strip().lower()
            password = str(body.get("password", ""))
            if not email or "@" not in email:
                self._send_json(400, {"error": "Valid email is required"})
                return
            if len(password) < 8:
                self._send_json(400, {"error": "Password must be at least 8 characters"})
                return
            salt_hex, pwd_hash = create_password_record(password)
            conn = db_connect()
            cur = conn.cursor()
            try:
                cur.execute(
                    "INSERT INTO users(email, password_salt, password_hash, created_at_ms) VALUES(?, ?, ?, ?)",
                    (email, salt_hex, pwd_hash, now_ms()),
                )
                user_id = cur.lastrowid
                conn.commit()
            except sqlite3.IntegrityError:
                conn.close()
                self._send_json(409, {"error": "Email already exists"})
                return
            conn.close()
            token = issue_session(user_id)
            self._send_json(200, {"token": token, "user": {"id": user_id, "email": email}})
            return

        if path == "/api/auth/login":
            body = self._read_json_body()
            email = str(body.get("email", "")).strip().lower()
            password = str(body.get("password", ""))
            conn = db_connect()
            cur = conn.cursor()
            cur.execute("SELECT id, email, password_salt, password_hash FROM users WHERE email = ?", (email,))
            row = cur.fetchone()
            conn.close()
            if not row:
                self._send_json(401, {"error": "Invalid credentials"})
                return
            expected = row["password_hash"]
            actual = hash_password(password, row["password_salt"])
            if actual != expected:
                self._send_json(401, {"error": "Invalid credentials"})
                return
            token = issue_session(row["id"])
            self._send_json(200, {"token": token, "user": {"id": row["id"], "email": row["email"]}})
            return

        if path == "/api/auth/logout":
            token = self._get_bearer_token()
            if token:
                conn = db_connect()
                cur = conn.cursor()
                cur.execute("DELETE FROM sessions WHERE token = ?", (token,))
                conn.commit()
                conn.close()
            self._send_json(200, {"ok": True})
            return

        if path == "/api/sync/push":
            user = self._require_auth_user()
            if not user:
                self._send_json(401, {"error": "Unauthorized"})
                return
            body = self._read_json_body()
            state = body.get("state")
            if state is None:
                self._send_json(400, {"error": "Missing state"})
                return
            state_json = json.dumps(state, ensure_ascii=False)
            updated = now_ms()
            conn = db_connect()
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO cloud_state(user_id, state_json, updated_at_ms)
                VALUES(?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET state_json=excluded.state_json, updated_at_ms=excluded.updated_at_ms
                """,
                (user["id"], state_json, updated),
            )
            conn.commit()
            conn.close()
            self._send_json(200, {"ok": True, "updatedAtMs": updated})
            return

        self._send_json(404, {"error": "Not found"})


def main():
    init_db()
    port = int(os.environ.get("PORT", "3000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"VocaLog server running on http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()

