const fs = require("fs/promises");
const path = require("path");

const USGS_SITE = "01411360";
const USGS_PARAM = "72279";
const OUT = path.join("data", "sealevel.json");

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function monthKey(dateText) {
  return String(dateText || "").slice(0, 7);
}

async function fetchDailyValues() {
  const url = new URL("https://waterservices.usgs.gov/nwis/dv/");
  url.searchParams.set("format", "json");
  url.searchParams.set("sites", USGS_SITE);
  url.searchParams.set("parameterCd", USGS_PARAM);
  url.searchParams.set("statCd", "00003");
  url.searchParams.set("startDT", "2000-01-01");
  url.searchParams.set("endDT", ymd(new Date()));
  url.searchParams.set("siteStatus", "all");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`USGS daily sea-level request failed ${res.status}`);
  const json = await res.json();
  const values = json?.value?.timeSeries?.[0]?.values?.[0]?.value || [];

  return values
    .map((p) => ({ date: String(p.dateTime || "").slice(0, 10), ft: Number(p.value) }))
    .filter((p) => p.date && Number.isFinite(p.ft));
}

function monthlyMeans(daily) {
  const byMonth = new Map();
  for (const p of daily) {
    const key = monthKey(p.date);
    if (!key) continue;
    if (!byMonth.has(key)) byMonth.set(key, { month: key, sum: 0, count: 0 });
    const rec = byMonth.get(key);
    rec.sum += p.ft;
    rec.count += 1;
  }
  return Array.from(byMonth.values())
    .filter((r) => r.count)
    .map((r) => ({ month: r.month, ft: Number((r.sum / r.count).toFixed(4)), days: r.count }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

async function main() {
  const daily = await fetchDailyValues();
  const monthly = monthlyMeans(daily);
  const payload = {
    station: USGS_SITE,
    parameter: USGS_PARAM,
    datum: "NAVD88",
    updated_utc: new Date().toISOString(),
    daily,
    monthly
  };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Wrote ${OUT} with ${daily.length} daily values and ${monthly.length} monthly means.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
