const fs = require("fs/promises");
const path = require("path");
const { execFileSync } = require("child_process");

const GAUGE_TYPE = "USGS";
const USGS_SITE = "01411360";
const USGS_PARAM = "72279";
const NOAA_STATIONS = ["8535581","8536110"];
const OUT = path.join("data", "sealevel.json");
const MIN_USGS_DAILY_VALUES_PER_MONTH = 20;
// Mantoloking September 2000 has a one-month station offset absent from neighboring gauges.
const EXCLUDED_USGS_MONTHS = new Set(USGS_SITE === "01408168" ? ["2000-09"] : []);

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function ymdCompact(date) {
  return ymd(date).replace(/-/g, "");
}

function monthKey(dateText) {
  return String(dateText || "").slice(0, 7);
}

function decimalYear(month) {
  const y = Number(String(month).slice(0, 4));
  const m = Number(String(month).slice(5, 7));
  return y + (m - 0.5) / 12;
}

function fetchJsonWithCurl(url) {
  const text = execFileSync(
    "curl",
    ["--retry", "2", "--retry-delay", "1", "--connect-timeout", "15", "--max-time", "75", "-fsSL", String(url)],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 32 }
  );
  return JSON.parse(text);
}

async function fetchJson(url, opts = {}) {
  let json;
  if (opts.preferCurl) {
    json = fetchJsonWithCurl(url);
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "shorelysafe-sealevel-cache/1.0" },
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      json = await res.json();
    } catch (fetchErr) {
      try {
        json = fetchJsonWithCurl(url);
      } catch (curlErr) {
        throw new Error(`${fetchErr.message || fetchErr}; curl fallback failed: ${curlErr.message || curlErr}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  if (json?.error?.message) throw new Error(json.error.message);
  return json;
}

async function fetchUSGSDailyValues() {
  const url = new URL("https://waterservices.usgs.gov/nwis/dv/");
  url.searchParams.set("format", "json");
  url.searchParams.set("sites", USGS_SITE);
  url.searchParams.set("parameterCd", USGS_PARAM);
  url.searchParams.set("statCd", "00003");
  url.searchParams.set("startDT", "2000-01-01");
  url.searchParams.set("endDT", ymd(new Date()));
  url.searchParams.set("siteStatus", "all");

  const json = await fetchJson(url);
  const values = json?.value?.timeSeries?.[0]?.values?.[0]?.value || [];
  return values
    .map((p) => ({ date: String(p.dateTime || "").slice(0, 10), ft: Number(p.value) }))
    .filter((p) => p.date && Number.isFinite(p.ft) && Math.abs(p.ft) < 100);
}

function noaaMonthlyMeanUrl(station, beginDate, endDate) {
  const url = new URL("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter");
  url.searchParams.set("station", station);
  url.searchParams.set("product", "monthly_mean");
  url.searchParams.set("datum", "MSL");
  url.searchParams.set("units", "english");
  url.searchParams.set("time_zone", "gmt");
  url.searchParams.set("format", "json");
  url.searchParams.set("begin_date", beginDate);
  url.searchParams.set("end_date", endDate);
  return url;
}

async function fetchNOAAMonthlyMeans() {
  const errors = [];
  const stations = [...new Set((NOAA_STATIONS || []).filter(Boolean).map(String))];
  for (const station of stations) {
    try {
      const rows = [];
      const currentYear = new Date().getUTCFullYear();
      const stationErrors = [];
      try {
        const fullUrl = noaaMonthlyMeanUrl(station, "20000101", ymdCompact(new Date()));
        const fullJson = await fetchJson(fullUrl, { preferCurl: true });
        rows.push(...(Array.isArray(fullJson?.data) ? fullJson.data : []));
      } catch (fullErr) {
        stationErrors.push(`2000-current: ${fullErr.message || fullErr}`);
        for (let startYear = 2000; startYear <= currentYear; startYear += 5) {
          const endYear = Math.min(startYear + 4, currentYear);
          try {
            const url = noaaMonthlyMeanUrl(
              station,
              `${startYear}0101`,
              endYear === currentYear ? ymdCompact(new Date()) : `${endYear}1231`
            );
            const json = await fetchJson(url, { preferCurl: true });
            rows.push(...(Array.isArray(json?.data) ? json.data : []));
          } catch (err) {
            stationErrors.push(`${startYear}-${endYear}: ${err.message || err}`);
          }
        }
      }
      const monthly = rows
        .map((r) => {
          const y = Number(r.year);
          const m = Number(r.month);
          const ft = Number(r.MSL);
          if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(ft) || Math.abs(ft) >= 100) return null;
          const month = `${y}-${String(m).padStart(2, "0")}`;
          return { month, ft: Number(ft.toFixed(4)), days: null };
        })
        .filter(Boolean)
        .sort((a, b) => a.month.localeCompare(b.month));
      if (monthly.length >= 24) return { station, monthly };
      if (monthly.length) return { station, monthly };
      errors.push(`${station}: no monthly means; ${stationErrors.join(" | ")}`);
    } catch (err) {
      errors.push(`${station}: ${err.message || err}`);
    }
  }
  throw new Error(errors.join(" | "));
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
    .filter((r) => r.count >= MIN_USGS_DAILY_VALUES_PER_MONTH && !EXCLUDED_USGS_MONTHS.has(r.month))
    .map((r) => ({ month: r.month, ft: Number((r.sum / r.count).toFixed(4)), days: r.count }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function linearRegression(points) {
  const n = points.length;
  if (n < 24) return null;
  const sx = points.reduce((a, p) => a + p.x, 0);
  const sy = points.reduce((a, p) => a + p.y, 0);
  const sxx = points.reduce((a, p) => a + p.x * p.x, 0);
  const sxy = points.reduce((a, p) => a + p.x * p.y, 0);
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slopeFtPerYear: slope, interceptFt: intercept, monthlyPoints: n };
}

function regression(monthly) {
  const points = monthly
    .map((p) => {
      const month = String(p.month || "").slice(0, 7);
      const monthNumber = Number(month.slice(5, 7));
      return { month, monthNumber, x: decimalYear(month), y: Number(p.ft) };
    })
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.y) < 100 && p.monthNumber >= 1 && p.monthNumber <= 12);
  const raw = linearRegression(points);
  if (!raw) return null;
  const seasonal = {};
  for (let month = 1; month <= 12; month += 1) {
    const vals = points
      .filter((p) => p.monthNumber === month)
      .map((p) => p.y - (raw.interceptFt + raw.slopeFtPerYear * p.x));
    seasonal[String(month).padStart(2, "0")] = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : 0;
  }
  const adjusted = points.map((p) => ({ x: p.x, y: p.y - seasonal[String(p.monthNumber).padStart(2, "0")] }));
  const deseasonalized = linearRegression(adjusted) || raw;
  return {
    ...deseasonalized,
    method: "deseasonalized_monthly_mean_linear_regression",
    rawRegression: raw,
    seasonalAdjustmentsFt: Object.fromEntries(Object.entries(seasonal).map(([k, v]) => [k, Number(v.toFixed(6))]))
  };
}

async function main() {
  let station = USGS_SITE;
  let daily = [];
  let monthly = [];
  let datum = "NAVD88";
  let source = "USGS daily mean";

  if (GAUGE_TYPE === "NOAA") {
    const noaa = await fetchNOAAMonthlyMeans();
    station = noaa.station;
    monthly = noaa.monthly;
    datum = "MSL";
    source = "NOAA monthly_mean MSL";
  } else {
    try {
      daily = await fetchUSGSDailyValues();
      monthly = monthlyMeans(daily);
    } catch (err) {
      daily = [];
      monthly = [];
    }
    if (monthly.length < 24 && NOAA_STATIONS.length) {
      const noaa = await fetchNOAAMonthlyMeans();
      station = noaa.station;
      daily = [];
      monthly = noaa.monthly;
      datum = "MSL";
      source = "NOAA monthly_mean MSL fallback";
    }
  }

  const payload = {
    station,
    gaugeType: GAUGE_TYPE,
    parameter: USGS_PARAM,
    datum,
    source,
    qualityControl: {
      minimumDailyValuesPerMonth: daily.length ? MIN_USGS_DAILY_VALUES_PER_MONTH : null,
      excludedMonths: daily.length ? [...EXCLUDED_USGS_MONTHS] : [],
      method: "Exclude incomplete USGS months and configured station discontinuities from trend analysis"
    },
    updated_utc: new Date().toISOString(),
    regression: regression(monthly),
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
