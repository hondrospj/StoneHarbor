"use strict";

// NOAA TWL90p is the 90% exceedance (lower) total-water-level curve.
// Keep NOAA's published values; do not estimate percentiles or add local bias.
function parseStationCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerIndex = lines.findIndex(line => {
    const fields = line.split(",").map(value => value.trim().toUpperCase());
    return fields.includes("TIME") && fields.includes("TWL90P");
  });
  if (headerIndex < 0) throw new Error("NOAA station CSV is missing TIME or TWL90p; no mean fallback is allowed.");
  const header = lines[headerIndex].split(",").map(value => value.trim().toUpperCase());
  const column = name => header.indexOf(name);
  const numeric = value => {
    if (value == null || String(value).trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) !== 9999 ? number : null;
  };
  const rows = [];
  const seen = new Set();
  for (const line of lines.slice(headerIndex + 1)) {
    const fields = line.split(",").map(value => value.trim());
    const rawTime = fields[column("TIME")];
    if (!/^\d{12}$/.test(rawTime || "")) continue;
    const iso = `${rawTime.slice(0,4)}-${rawTime.slice(4,6)}-${rawTime.slice(6,8)}T${rawTime.slice(8,10)}:${rawTime.slice(10,12)}:00.000Z`;
    const time = Date.parse(iso);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== iso) continue;
    const twl90 = numeric(fields[column("TWL90P")]);
    if (twl90 === null) continue;
    if (seen.has(iso)) throw new Error(`Duplicate NOAA forecast timestamp: ${iso}`);
    seen.add(iso);
    rows.push({
      t: iso,
      twl: twl90,
      source_twl90p: twl90,
      source_twl_mean: numeric(fields[column("TWL")]),
      tide: numeric(fields[column("TIDE")]),
      surge: numeric(fields[column("SURGE")]),
      src_time: rawTime
    });
  }
  if (!rows.length) throw new Error("NOAA station CSV has no usable TWL90p values.");
  return rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

function forecastCsv(rows) {
  const lines = ["time_utc_iso,twl_ft_mllw,tide_ft_mllw,surge_ft,src_time,source_mean_ft_mllw,source_twl90p_ft_mllw"];
  for (const row of rows) lines.push([row.t, row.twl, row.tide ?? "", row.surge ?? "", row.src_time, row.source_twl_mean ?? "", row.source_twl90p].join(","));
  return lines.join("\n") + "\n";
}

const forecastMetadata = Object.freeze({
  forecast_product: "TWL90p",
  exceedance_probability_percent: 90,
  non_exceedance_percentile: 10,
  custom_bias_correction: false,
  percentile_method: "NOAA-published-TWL90p",
  notes: "NOAA TWL90p: the lower 90% exceedance total-water-level curve. No custom observation alignment, local adjustment, or estimated percentile is applied."
});

module.exports = {parseStationCsv, forecastCsv, forecastMetadata};
