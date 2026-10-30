#!/usr/bin/env node
"use strict";

// Maintain the approved individual tide cache; historical rebuilding needs the
// audited archive/calibration pipeline, rather than this rolling live updater.
const fs = require("node:fs");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const {fetchObservations} = require("./usgs-observations");
const tides = require("./tide-cycle-events");
const CACHE_PATH = path.join(__dirname, "..", "data", "peaks_navd88.json");
const API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

function noaaTime(value) { return tides.secondsISO(value.includes("T") ? value : value.replace(" ", "T") + ":00Z"); }
function day(time) { return new Date(time).toISOString().slice(0, 10).replaceAll("-", ""); }
async function getJSON(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {headers: {"User-Agent": "shorelysafe-individual-tides-v3"}, signal: AbortSignal.timeout(45000)});
  if (!response.ok) throw new Error(`NOAA HTTP ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(`NOAA ${json.error.message || JSON.stringify(json.error)}`);
  return json;
}
async function fetchNOAA({product, startISO, endISO, datum, fetchImpl = fetch}) {
  const rows = new Map(), end = Date.parse(endISO);
  let cursor = Date.parse(new Date(startISO).toISOString().slice(0, 10) + "T00:00:00Z");
  while (cursor <= end) {
    const finish = Math.min(cursor + 29 * 86400000, end);
    const params = {product, application: "shorelysafe-individual-tides-v3", format: "json", station: tides.CLOCK_STATION,
      time_zone: "gmt", units: "english", datum, begin_date: day(cursor), end_date: day(finish)};
    if (product === "predictions") params.interval = "hilo";
    const json = await getJSON(`${API}?${new URLSearchParams(params)}`, fetchImpl);
    const data = product === "predictions" ? json.predictions : json.data;
    if (!Array.isArray(data)) throw new Error(`NOAA ${product} response has no data array`);
    for (const p of data) {
      if (product === "predictions" && p.type !== "H") continue;
      if (product !== "predictions" && (p.v == null || String(p.v).trim() === "" || !Number.isFinite(Number(p.v)) || Math.abs(Number(p.v)) >= 100 || String(p.f || "").split(",")[0] === "1")) continue;
      const t = noaaTime(p.t);
      if (Date.parse(t) < Date.parse(startISO) || Date.parse(t) > end) continue;
      rows.set(t, product === "predictions" ? {t} : {t, ft: Number(p.v)});
    }
    cursor = Date.parse(new Date(finish).toISOString().slice(0, 10) + "T00:00:00Z") + 86400000;
  }
  return [...rows.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}
async function fetchBackup({startISO, endISO, fetchImpl = fetch}) {
  // Maintain the same hourly donor resolution used in the flooding-high-tide
  // calibration. Unverified six-minute observations fill exact UTC hour slots.
  async function seriesFor(datum) {
    const responses = await Promise.allSettled(["hourly_height", "water_level"].map(product => fetchNOAA({product, startISO, endISO, datum, fetchImpl})));
    const byTime = new Map();
    if (responses[1].status === "fulfilled") for (const p of responses[1].value) {
      const t = new Date(p.t); if (t.getUTCMinutes() === 0 && t.getUTCSeconds() === 0) byTime.set(p.t,p);
    }
    if (responses[0].status === "fulfilled") for (const p of responses[0].value) byTime.set(p.t,p);
    if (!byTime.size) throw new Error("No qualified hourly donor observations in requested interval");
    return [...byTime.values()].sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  }
  try { return {series: await seriesFor("NAVD"), datum:"NAVD88", datumConversion:null}; }
  catch (directError) {
    const datumUrl = `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/${tides.CLOCK_STATION}/datums.json?units=english`;
    const json = await getJSON(datumUrl, fetchImpl);
    const value = name => { const d = json.datums?.find(d=>d.name===name); return d && d.value != null && String(d.value).trim()!=="" ? Number(d.value) : NaN; };
    const addFt = value("MLLW") - value("NAVD88");
    if (!Number.isFinite(addFt)) throw new Error("Donor NAVD datum conversion is unsupported: "+directError.message);
    return {series:(await seriesFor("MLLW")).map(p=>({...p,ft:p.ft+addFt})),datum:"NAVD88",datumConversion:{station:tides.CLOCK_STATION,from:"MLLW",to:"NAVD88",addFt,source:datumUrl}};
  }
}

function newest(series) { return series.reduce((latest, p) => Math.max(latest, Date.parse(p.t)), -Infinity); }
function atomicSave(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value) + "\n"); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
async function updateCache(cache, {now = new Date(), fetchPrimary = fetchObservations, fetchDonor = fetchBackup, fetchClock = fetchNOAA, warn = console.warn} = {}) {
  tides.validateCache(cache);
  const endISO = now.toISOString(), startISO = new Date(Date.parse(cache.lastProcessedISO) - 48 * tides.HOUR).toISOString();
  const [primaryResult, donorResult] = await Promise.allSettled([
    fetchPrimary({site: "01411360", parameter: "72279", startISO, endISO}), fetchDonor({startISO, endISO})
  ]);
  const primary = primaryResult.status === "fulfilled" ? primaryResult.value : [];
  const donor = donorResult.status === "fulfilled" ? donorResult.value : {series: []};
  if (primaryResult.status === "rejected") warn(`Primary unavailable: ${primaryResult.reason.message}`);
  if (donorResult.status === "rejected") warn(`Backup unavailable: ${donorResult.reason.message}`);
  const latest = Math.min(now.getTime(), Math.max(newest(primary), newest(donor.series)));
  if (!Number.isFinite(latest) || now.getTime() - latest > 6 * tides.HOUR) throw new Error("Both observed feeds are missing or stale by more than six hours; cache and cursor were not advanced.");
  const predictedHighs = await fetchClock({product: "predictions", datum: "MLLW",
    startISO: new Date(Date.parse(startISO) - 48 * tides.HOUR).toISOString(), endISO: new Date(now.getTime() + 48 * tides.HOUR).toISOString()});
  if (predictedHighs.length < 3) throw new Error("Insufficient neighboring predicted highs; cache was not updated.");
  const windows = tides.buildWindows(predictedHighs, {startISO, latestObservedISO: new Date(latest).toISOString()});
  const correction = Number(cache.backup?.biasCorrectionFt);
  if (!Number.isFinite(correction)) throw new Error("Missing approved Lewes bias correction; reviewed calibration rebuild required.");
  const p = tides.buildEvents({series: primary, windows});
  const b = tides.buildEvents({series: donor.series, windows, sourceRole: "backup", biasCorrectionFt: correction});
  const events = tides.mergeEvents(cache.events, p.events, b.events);
  const fullYearExpected = {};
  for (const year of new Set(windows.map(w => tides.localParts(w.crest).year))) {
    if (cache.coverage.find(r => r.year === year)?.fullYearExpectedCycles != null) continue;
    const clocks = await fetchClock({product: "predictions", datum: "MLLW", startISO: `${year}-01-01T00:00:00Z`, endISO: `${year + 1}-01-02T00:00:00Z`});
    fullYearExpected[year] = new Set(clocks.filter(c => tides.localParts(c.t).year === year).map(c => tides.cycleId(c.t))).size;
  }
  const completedEnd = windows.reduce((end, w) => Math.max(end, Date.parse(w.windowEnd)), Date.parse(cache.lastProcessedISO));
  const lastProcessedISO = tides.secondsISO(completedEnd);
  const coverage = tides.reconcileCoverage(cache, windows, events, lastProcessedISO, fullYearExpected);
  return {...cache, ...coverage, events, lastProcessedISO, generatedAt: endISO,
    liveUpdate: {checkedAt: endISO, observedThrough: tides.secondsISO(latest), overlapHours: 48, completedWindows: windows.length,
      qualifiedPrimaryCycles: p.events.length, qualifiedBackupCycles: b.events.length,
      primaryLatest: Number.isFinite(newest(primary)) ? tides.secondsISO(newest(primary)) : null,
      backupLatest: Number.isFinite(newest(donor.series)) ? tides.secondsISO(newest(donor.series)) : null,
      ...(donor.datumConversion ? {donorDatumConversion: donor.datumConversion} : {})}};
}
async function main() {
  if (process.argv.slice(2).length) throw new Error("Historical/backfill flags are disabled for the incremental v3 updater. Use the reviewed full historical archive and calibration rebuild, then regenerate tide statistics.");
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  const result = await updateCache(cache);
  atomicSave(CACHE_PATH, result);
  execFileSync("python3", [path.join(__dirname, "rebuild_tide_statistics.py")], {cwd: path.join(__dirname, ".."), stdio: "inherit"});
  console.log(`Updated individual high tides: ${result.events.length}; completed clock through ${result.lastProcessedISO}.`);
}
if (require.main === module) main().catch(error => {console.error(error); process.exitCode = 1;});
module.exports = {fetchNOAA, fetchBackup, updateCache, atomicSave};
