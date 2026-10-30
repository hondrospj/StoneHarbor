"use strict";

// Individual measured high tides, keyed by the predicted high that owns their
// disjoint midpoint window. Dates are never deduplication keys.
const HOUR = 3600000;
const CLOCK_STATION = "8557380";
const METHOD = "individual_high_tides_v3";
const COUNT_UNIT = "individual-high-tide";
const THRESHOLDS = {minorLow: 3.44, moderateLow: 4.44, majorLow: 5.44};
const localFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
});

function secondsISO(time) {
  const ms = typeof time === "number" ? time : Date.parse(time);
  if (!Number.isFinite(ms)) throw new Error(`Invalid tide time: ${time}`);
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}
function localParts(time) {
  const p = Object.fromEntries(localFormatter.formatToParts(new Date(time)).map(p => [p.type, p.value]));
  return {year: Number(p.year), month: Number(p.month), day: Number(p.day), localDate: `${p.year}-${p.month}-${p.day}`};
}
function cycleId(crest) { return `${CLOCK_STATION}@${secondsISO(crest)}`; }
function eventId(event) {
  if (event?.crest && String(event.cycleId || "").startsWith(`${CLOCK_STATION}@`)) return cycleId(event.crest);
  return String(event?.cycleId || "");
}
function role(event) {
  if (event?.officialCrestOverride || event?.sourceRole === "official-crest") return "official";
  return event?.sourceRole === "primary" ? "primary" : "backup";
}
function classify(ft, thresholds = THRESHOLDS) {
  return ft >= thresholds.majorLow ? "Major" : ft >= thresholds.moderateLow ? "Moderate" : ft >= thresholds.minorLow ? "Minor" : "Below";
}
function validateCache(cache) {
  const good = cache?.countUnit === COUNT_UNIT && cache?.method === METHOD && cache?.site === "01411360" &&
    cache?.parameterCd === "72279" && cache?.datum === "NAVD88" && cache?.clockStation === CLOCK_STATION &&
    Object.entries(THRESHOLDS).every(([key, value]) => cache?.thresholdsNAVD88?.[key] === value) &&
    Array.isArray(cache.events) && Array.isArray(cache.coverage) && Array.isArray(cache.monthlyCoverage) &&
    Number.isFinite(Date.parse(cache.lastProcessedISO));
  if (!good || cache.events.some(e => !["HighTide", "OfficialCrest"].includes(e?.kind) || e?.legacyDailyPeak || !e?.cycleId || typeof e.ft !== "number" || !Number.isFinite(e.ft) || Math.abs(e.ft) >= 100)) {
    throw new Error("Updater requires the approved Stone Harbor individual-high-tide v3 cache, station 01411360/72279, NOAA clock 8557380, NAVD88 thresholds 3.44/4.44/5.44. Perform a reviewed full historical rebuild; legacy caches cannot be incrementally migrated.");
  }
}

function buildWindows(predictedHighs, {startISO, latestObservedISO} = {}) {
  const centers = [...new Set(predictedHighs.map(h => Date.parse(typeof h === "string" ? h : h.t || h.crest)).filter(Number.isFinite))].sort((a, b) => a - b);
  const start = startISO ? Date.parse(startISO) : -Infinity;
  const latest = latestObservedISO ? Date.parse(latestObservedISO) : Infinity;
  const windows = [];
  for (let i = 1; i < centers.length; i++) {
    const gap = centers[i] - centers[i-1];
    if (gap < 8*HOUR || gap > 16*HOUR) throw new Error("Incomplete or nonphysical astronomical high-tide clock");
  }
  for (let i = 1; i < centers.length - 1; i++) {
    const center = centers[i], begin = (centers[i - 1] + center) / 2, end = (center + centers[i + 1]) / 2;
    if (begin < start || end > latest) continue;
    windows.push({cycleId: cycleId(center), crest: secondsISO(center), windowStart: secondsISO(begin), windowEnd: secondsISO(end)});
  }
  return windows;
}

function prepareSeries(series) {
  return (series || []).filter(p => p && p.ft != null && typeof p.ft !== "boolean" && String(p.ft).trim() !== "" &&
    Number.isFinite(Number(p.ft)) && Math.abs(Number(p.ft)) < 100 && Number.isFinite(Date.parse(p.t)))
    .map(p => ({...p, ms: Date.parse(p.t), ft: Number(p.ft)})).sort((a, b) => a.ms - b.ms);
}
function qualifyWindow(points, window) {
  const start = Date.parse(window.windowStart), end = Date.parse(window.windowEnd), center = Date.parse(window.crest);
  const latest = points.length ? points[points.length - 1].ms : -Infinity;
  if (end > latest) return {accepted: false, reason: "unfinished-window"};
  const part = points.filter(p => p.ms >= start && p.ms < end);
  if (!part.length) return {accepted: false, reason: "no-observations"};
  const occupied = new Set(part.map(p => Math.floor(p.ms / HOUR)));
  // Match the audited v3 archive: bins beginning inside [start,end).
  const hours = [];
  for (let h = Math.ceil(start / HOUR); h < Math.ceil(end / HOUR); h++) hours.push(h);
  const present = hours.filter(h => occupied.has(h)).length;
  const central = Array.from({length: 6}, (_, i) => Math.floor(center / HOUR) - 2 + i);
  const quality = {occupiedHours: present, expectedHours: hours.length, centralHours: central.filter(h => occupied.has(h)).length, observationCount: part.length};
  if (!hours.length || present / hours.length < 0.9) return {accepted: false, reason: "insufficient-hourly-coverage", quality};
  if (quality.centralHours !== 6) return {accepted: false, reason: "central-six-hour-coverage-gap", quality};
  // Preserve reported values and observation time; use the earliest tied max.
  const best = part.reduce((a, b) => b.ft > a.ft ? b : a);
  if (best.ms < start + HOUR || best.ms > end - HOUR) return {accepted: false, reason: "maximum-near-window-edge", quality};
  return {accepted: true, best, quality};
}
function buildEvents({series, windows, sourceRole = "primary", biasCorrectionFt = 0, thresholds = THRESHOLDS}) {
  const points = prepareSeries(series), events = [], rejected = [];
  for (const window of windows) {
    const result = qualifyWindow(points, window);
    if (!result.accepted) { rejected.push({...window, reason: result.reason}); continue; }
    const primary = sourceRole === "primary", p = localParts(result.best.ms);
    const ft = primary ? result.best.ft : Math.round((result.best.ft + biasCorrectionFt) * 1e6) / 1e6;
    events.push({...window, t: result.best.t, ft, type: classify(ft, thresholds), kind: "HighTide", sourceRole,
      historyAgency: primary ? "USGS" : "NOAA", source: primary ? "USGS 01411360" : "NOAA 8557380 calibrated gap fill",
      localDate: p.localDate, y: p.year, m: p.month, d: p.day, modelEligible: primary, quality: result.quality});
  }
  return {events, rejected};
}

function mergeEvents(existing, primaryEvents, backupEvents) {
  const byId = new Map();
  for (const event of existing || []) {
    const id = eventId(event);
    if (!id) throw new Error("Cached tide has no stable cycle ID; full rebuild required.");
    const old = byId.get(id);
    const priority = e => ({primary:3,official:2,backup:1})[role(e)];
    if (!old || priority(event) >= priority(old)) byId.set(id, event);
  }
  // Backup fills gaps or revises backup; primary revisions may lower heights.
  for (const event of backupEvents || []) {
    const id = eventId(event), old = byId.get(id);
    if (!old || role(old) === "backup") byId.set(id, event);
  }
  for (const event of primaryEvents || []) {
    const id = eventId(event), old = byId.get(id);
    byId.set(id, event); // Qualified measured primary is authoritative, including downward revisions.
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.crest || a.t) - Date.parse(b.crest || b.t));
}

// Subtract/re-add only reprocessed clocks. Unknown cycles remain denominators.
function reconcileCoverage(cache, windows, mergedEvents, latestObservedISO, fullYearExpected = {}) {
  const oldCursor = Date.parse(cache.lastProcessedISO), end = Date.parse(latestObservedISO);
  const oldEvents = new Map(cache.events.map(e => [eventId(e), e]));
  const finalEvents = new Map(mergedEvents.map(e => [eventId(e), e]));
  const annual = new Map(cache.coverage.map(r => [r.year, {...r}]));
  const monthly = new Map(cache.monthlyCoverage.map(r => [`${r.year}-${r.month}`, {...r}]));
  const counters = ["expectedCycles", "acceptedCycles", "primaryCycles", "backupCycles", "officialCycles"];
  const rowFor = (map, key, initial) => {
    if (!map.has(key)) map.set(key, {...initial, ...Object.fromEntries(counters.map(k => [k, 0]))});
    return map.get(key);
  };
  function adjust(row, expected, event, sign) {
    for (const k of counters) row[k] = Number(row[k] || 0);
    if (expected) row.expectedCycles += sign;
    if (event) { row.acceptedCycles += sign; row[`${role(event)}Cycles`] += sign; }
  }
  for (const window of windows) {
    if (Date.parse(window.windowEnd) > end) continue;
    const p = localParts(window.crest), id = eventId(window);
    const rows = [rowFor(annual, p.year, {year: p.year}), rowFor(monthly, `${p.year}-${p.month}`, {year: p.year, month: p.month})];
    const wasExpected = Date.parse(window.windowEnd) <= oldCursor;
    for (const row of rows) {
      if (wasExpected) adjust(row, true, oldEvents.get(id), -1);
      adjust(row, true, finalEvents.get(id), 1);
    }
  }
  const nowYear = localParts(latestObservedISO).year;
  function finish(row, isAnnual) {
    for (const key of counters) row[key] = Number(row[key] || 0);
    for (const key of counters) {
      if (!Number.isInteger(row[key]) || row[key] < 0) throw new Error(`Coverage reconciliation would invalidate ${row.year}/${row.month || "annual"} ${key}; reviewed full rebuild required.`);
    }
    if (row.acceptedCycles > row.expectedCycles || row.primaryCycles + row.backupCycles + row.officialCycles !== row.acceptedCycles) {
      throw new Error(`Inconsistent tide coverage for ${row.year}/${row.month || "annual"}; reviewed full rebuild required.`);
    }
    row.missingCycles = row.expectedCycles - row.acceptedCycles;
    if (isAnnual) {
      if (fullYearExpected[row.year] != null) row.fullYearExpectedCycles = fullYearExpected[row.year];
      row.status = row.year >= nowYear ? "ytd" : row.acceptedCycles === 0 ? "unavailable" : row.acceptedCycles === row.fullYearExpectedCycles && row.expectedCycles === row.fullYearExpectedCycles ? "complete" : "partial";
    }
    return row;
  }
  return {coverage: [...annual.values()].map(r => finish(r, true)).sort((a, b) => a.year - b.year),
    monthlyCoverage: [...monthly.values()].map(r => finish(r, false)).sort((a, b) => a.year - b.year || a.month - b.month)};
}

module.exports = {HOUR, CLOCK_STATION, METHOD, COUNT_UNIT, THRESHOLDS, secondsISO, localParts, cycleId, eventId,
  classify, validateCache, buildWindows, prepareSeries, qualifyWindow, buildEvents, mergeEvents, reconcileCoverage};
