function pad2(n) {
  return String(n).padStart(2, "0");
}

function toISODateLocal(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

function toISOYearMonthLocal(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  return `${y}-${m}`;
}

function toShortLabel(label, rangeValue) {
  if (rangeValue.startsWith("daily")) {
    // YYYY-MM-DD -> Mon DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) return String(label);
    const [y, m, d] = label.split("-").map((x) => parseInt(x, 10));
    const date = new Date(y, m - 1, d);
    if (Number.isNaN(date.getTime())) return String(label);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  if (rangeValue.startsWith("monthly")) {
    // YYYY-MM -> Mon YYYY
    if (!/^\d{4}-\d{2}$/.test(label)) return String(label);
    const [y, m] = label.split("-").map((x) => parseInt(x, 10));
    const date = new Date(y, m - 1, 1);
    if (Number.isNaN(date.getTime())) return String(label);
    return date.toLocaleDateString("en-US", { month: "short" });
  }
  // yearly
  return label;
}

function durationMsToHoursMinutes(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return { hours, minutes };
}

function formatHours(durationMs) {
  const { hours, minutes } = durationMsToHoursMinutes(durationMs);
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}`;
  return `${minutes}m`;
}

function buildRangeBuckets(rangeValue, nowMs) {
  const now = new Date(nowMs);

  if (rangeValue === "daily14") {
    const buckets = [];
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    for (let i = 13; i >= 0; i--) {
      const d = new Date(end);
      d.setDate(d.getDate() - i);
      buckets.push(toISODateLocal(d.getTime()));
    }
    return { bucketType: "day", buckets };
  }

  if (rangeValue === "monthly12") {
    const buckets = [];
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(end);
      d.setMonth(d.getMonth() - i);
      buckets.push(toISOYearMonthLocal(d.getTime()));
    }
    return { bucketType: "month", buckets };
  }

  if (rangeValue === "yearly5") {
    const buckets = [];
    const y = now.getFullYear();
    for (let i = 4; i >= 0; i--) buckets.push(String(y - i));
    return { bucketType: "year", buckets };
  }

  if (rangeValue === "yearlyAll") {
    return { bucketType: "year", buckets: null }; // dynamic
  }

  return { bucketType: "day", buckets: [] };
}

function groupDurationMs(logs, { rangeValue, collectionId, authorKey }) {
  const filtered = logs.filter((l) => {
    if (!l.endedAtMs) return false;
    if (collectionId && l.collectionId !== collectionId) return false;
    if (authorKey && (l.authorKey || "") !== authorKey) return false;
    return true;
  });

  const now = Date.now();
  const range = buildRangeBuckets(rangeValue, now);
  const bucketToValue = new Map();

  if (range.bucketType === "year" && range.buckets === null) {
    // Dynamic buckets across all logs.
    filtered.forEach((l) => {
      const y = new Date(l.endedAtMs).getFullYear();
      const key = String(y);
      bucketToValue.set(key, (bucketToValue.get(key) || 0) + (l.durationOverrideMs ?? l.durationMs ?? 0));
    });
    const years = Array.from(bucketToValue.keys()).sort((a, b) => parseInt(a) - parseInt(b));
    const values = years.map((k) => bucketToValue.get(k) || 0);
    return { labels: years, values, totalMs: values.reduce((a, b) => a + b, 0) };
  }

  (range.buckets || []).forEach((b) => bucketToValue.set(b, 0));

  for (const log of filtered) {
    const key =
      range.bucketType === "day"
        ? toISODateLocal(log.endedAtMs)
        : range.bucketType === "month"
          ? toISOYearMonthLocal(log.endedAtMs)
          : String(new Date(log.endedAtMs).getFullYear());
    const dur = log.durationOverrideMs ?? log.durationMs ?? 0;
    bucketToValue.set(key, (bucketToValue.get(key) || 0) + dur);
  }

  const labels = range.buckets || [];
  const values = labels.map((k) => bucketToValue.get(k) || 0);
  const totalMs = values.reduce((a, b) => a + b, 0);
  return { labels, values, totalMs };
}

function computeBreakdown(logs, { dimension, collectionId, authorKey, rangeValue }) {
  const filtered = logs.filter((l) => {
    if (!l.endedAtMs) return false;
    if (collectionId && l.collectionId !== collectionId) return false;
    if (authorKey && (l.authorKey || "") !== authorKey) return false;
    if (!rangeValue) return true;

    const buckets = buildRangeBuckets(rangeValue, Date.now());
    if (rangeValue === "yearlyAll") return true;

    if (buckets.bucketType === "day") {
      const key = toISODateLocal(l.endedAtMs);
      return buckets.buckets.includes(key);
    }
    if (buckets.bucketType === "month") {
      const key = toISOYearMonthLocal(l.endedAtMs);
      return buckets.buckets.includes(key);
    }
    if (buckets.bucketType === "year") {
      const key = String(new Date(l.endedAtMs).getFullYear());
      return buckets.buckets.includes(key);
    }
    return true;
  });

  const bucket = new Map();
  for (const l of filtered) {
    let key = "Other";
    if (dimension === "platform") key = l.platform || "Other";
    else if (dimension === "author") key = l.authorName || l.authorKey || "Unknown";
    else if (dimension === "collection") {
      key = l.collectionName || l.collectionId || "Unsorted";
    }

    const dur = l.durationOverrideMs ?? l.durationMs ?? 0;
    bucket.set(key, (bucket.get(key) || 0) + dur);
  }

  const entries = Array.from(bucket.entries())
    .map(([k, v]) => ({ key: k, valueMs: v }))
    .sort((a, b) => b.valueMs - a.valueMs);

  return entries;
}

function renderBarChart(el, { labels, values, rangeValue, valueFormatter }) {
  el.innerHTML = "";
  if (!labels.length) {
    el.innerHTML = `<div class="text-sm text-neutral-500">No data.</div>`;
    return;
  }

  const max = Math.max(...values, 1);
  const height = 160;
  const width = 640;
  const pad = 18;
  const barGap = 6;
  const barW = Math.max(6, Math.floor((width - pad * 2 - barGap * (labels.length - 1)) / labels.length));
  const chartW = pad * 2 + labels.length * barW + (labels.length - 1) * barGap;
  const chartH = height;

  const bars = labels
    .map((label, i) => {
      const v = values[i] || 0;
      const barH = Math.round((v / max) * (chartH - 34));
      const x = pad + i * (barW + barGap);
      const y = chartH - 20 - barH;
      const short = toShortLabel(label, rangeValue);
      const title = `${short}: ${valueFormatter ? valueFormatter(v) : v}`;
      return `
        <g>
          <rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="4"
            fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.18)" />
          <title>${escapeHtml(title)}</title>
          <text x="${x + barW / 2}" y="${chartH - 4}" text-anchor="middle"
            fill="rgba(255,255,255,0.55)" font-size="10">
            ${escapeXml(short)}
          </text>
        </g>
      `;
    })
    .join("");

  el.innerHTML = `
    <div class="overflow-x-auto">
      <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="auto" role="img" aria-label="bar chart">
        <rect x="0" y="0" width="${chartW}" height="${chartH}" fill="transparent"></rect>
        ${bars}
      </svg>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeXml(str) {
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export { formatHours, groupDurationMs, computeBreakdown, renderBarChart };

