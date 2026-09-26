"use strict";

// Parameter 72279 is tidal elevation in feet NAVD88; no vertical offset is applied.
async function fetchObservations({site, parameter, startISO, endISO, fetchImpl = fetch, warn = console.warn}) {
  const start = Date.parse(startISO), end = Date.parse(endISO);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error("Invalid USGS observation interval");
  const add = (rows, time, value) => {
    if (value == null || typeof value === "boolean" || String(value).trim() === "") return;
    const t = Date.parse(time), ft = Number(value);
    if (Number.isFinite(t) && t >= start && t <= end && Number.isFinite(ft) && Math.abs(ft) < 9999) {
      rows.set(t, {t: new Date(t).toISOString(), ft});
    }
  };
  const getJson = async url => {
    const res = await fetchImpl(url, {headers: {"User-Agent": "peaks-cache/2.1"}, signal: AbortSignal.timeout(30000)});
    if (!res.ok) throw new Error(`USGS observations HTTP ${res.status}`);
    return res.json();
  };
  const sorted = rows => [...rows.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  try {
    const url = new URL("https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items");
    url.search = new URLSearchParams({monitoring_location_id: `USGS-${site}`, parameter_code: parameter,
      datetime: `${new Date(start).toISOString()}/${new Date(end).toISOString()}`, limit: "10000", f: "json"}).toString();
    const rows = new Map(), visited = new Set();
    let next = url.toString();
    while (next) {
      if (visited.has(next) || visited.size >= 1000) throw new Error("Incomplete USGS pagination");
      visited.add(next);
      const json = await getJson(next);
      if (!Array.isArray(json.features)) throw new Error("Invalid USGS continuous response");
      for (const feature of json.features) {
        const p = feature.properties || {};
        if (p.monitoring_location_id !== `USGS-${site}` || p.parameter_code !== parameter || p.unit_of_measure !== "ft") continue;
        add(rows, p.time, p.value);
      }
      const link = json.links?.find(link => link.rel === "next")?.href;
      next = link ? new URL(link, next).toString() : null;
      if (next && new URL(next).origin !== url.origin) throw new Error("Unexpected USGS pagination origin");
    }
    if (!rows.size) throw new Error("No usable USGS continuous observations");
    return sorted(rows);
  } catch (modernError) {
    warn(`Current USGS feed unavailable; trying WaterServices: ${modernError.message}`);
    const url = new URL("https://waterservices.usgs.gov/nwis/iv/");
    url.search = new URLSearchParams({format: "json", sites: site, parameterCd: parameter,
      startDT: startISO, endDT: endISO, siteStatus: "all", agencyCd: "USGS"}).toString();
    try {
      const json = await getJson(url.toString()), rows = new Map();
      for (const series of json?.value?.timeSeries || []) {
        if (!series.sourceInfo?.siteCode?.some(code => code.value === site)) continue;
        if (!series.variable?.variableCode?.some(code => code.value === parameter) || series.variable?.unit?.unitCode !== "ft") continue;
        for (const group of series.values || []) for (const p of group.value || []) {
          if (Number(p.value) !== Number(series.variable.noDataValue)) add(rows, p.dateTime, p.value);
        }
      }
      if (!rows.size) throw new Error("No usable USGS WaterServices observations");
      return sorted(rows);
    } catch (legacyError) {
      throw new AggregateError([modernError, legacyError], "Both USGS observation feeds failed; cache was not updated");
    }
  }
}

module.exports = {fetchObservations};
