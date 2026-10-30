#!/usr/bin/env node
"use strict";

// Public source/data only. These three existing applications are the complete
// publisher scope. Every other live file (including weather) retains its hash.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const {SITE, request, sha256} = require("./refresh_dashboard_petss");
const {fetchObservations} = require("./usgs-observations");
const {createEngine, HOUR} = require("./tide-cycle-events");
const DAY = 24 * HOUR, LOOKBACK_DAYS = 35;
const CACHE_PATH = "data/peaks_navd88.json", ANNUAL_PATH = "data/annual_flood_counts.json";
const FUTURE_PATH = "data/future_flood_counts.json", PROJECTIONS_PATH = "data/sea_level_projections.json";
const DATA_PATHS = Object.freeze([CACHE_PATH, ANNUAL_PATH, FUTURE_PATH, "index.html"]);
const INPUT_PATHS = Object.freeze([...DATA_PATHS, PROJECTIONS_PATH]);
const RECEIPT_PATH = "data/refresh_status.json";
const CONFIG = Object.freeze([
  {id:"flooddashboard--stone-harbor", town:"stone-harbor", primarySite:"01411360", primaryAgency:"USGS", parameter:"72279", clockStation:"8557380", backupSite:"8557380", isoMilliseconds:false, thresholds:{minorLow:3.44, moderateLow:4.44, majorLow:5.44}},
  {id:"flooddashboard--sandy-hook", town:"sandy-hook", primarySite:"8531680", primaryAgency:"NOAA", clockStation:"8531680", backupSite:null, isoMilliseconds:true, thresholds:{minorLow:3.88, moderateLow:4.88, majorLow:5.88}},
  {id:"flooddashboard--cape-may-harbor", town:"cape-may-harbor", primarySite:"01411390", primaryAgency:"USGS", parameter:"72279", clockStation:"8536110", backupSite:"8536110", isoMilliseconds:true, thresholds:{minorLow:3.43, moderateLow:4.43, majorLow:5.43}}
].map(c => Object.freeze({...c, thresholds:Object.freeze(c.thresholds)})));
const allowedConfig = config => {if (!CONFIG.includes(config)) throw new Error("Application is outside the selected high-tide scope."); return config;};
const iso = t => new Date(t).toISOString();
const newest = series => Math.max(-Infinity, ...series.map(p => Date.parse(p.t)).filter(Number.isFinite));
const stableJSON = value => Buffer.from(JSON.stringify(value) + "\n");

function validateConnection(connection) {
  const expected = CONFIG.map(c => c.id).sort();
  if (!connection || connection.site !== SITE || !connection.tokens || typeof connection.tokens !== "object" ||
      JSON.stringify(Object.keys(connection.tokens).sort()) !== JSON.stringify(expected) ||
      expected.some(id => typeof connection.tokens[id] !== "string" || !/^[-_A-Za-z0-9]{43}$/.test(connection.tokens[id])))
    throw new Error("The selected high-tide connection requires the exact HTTPS site and exactly three approved application credentials.");
  return connection;
}
async function publicFetch(url, options = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      !["https://api.tidesandcurrents.noaa.gov", "https://api.waterdata.usgs.gov", "https://waterservices.usgs.gov"].includes(parsed.origin))
    throw new Error("Unapproved public observation destination.");
  return fetch(url, {...options, redirect:"error", signal:options.signal || AbortSignal.timeout(45000)});
}
async function publicJSON(url, fetchImpl = publicFetch) {
  const response = await fetchImpl(url, {signal:AbortSignal.timeout(45000)});
  if (!response.ok) throw new Error("Public observation service is unavailable.");
  const json = await response.json();
  if (json.error) throw new Error("Public observation product or datum is unavailable.");
  return json;
}
const day = t => iso(t).slice(0,10).replaceAll("-", "");
function noaaTime(t) {
  const text = String(t);
  return Date.parse(text.includes("T") ? (/Z$|[+-]\d\d:\d\d$/.test(text) ? text : text + "Z") : text.replace(" ", "T") + "Z");
}
async function fetchNOAA({station, product, datum = "NAVD", startISO, endISO, fetchImpl = publicFetch}) {
  const start = Date.parse(startISO), end = Date.parse(endISO), rows = new Map();
  if (!/^\d{7}$/.test(station) || !Number.isFinite(start) || !Number.isFinite(end) || start > end)
    throw new Error("Invalid approved NOAA interval or station.");
  // Inclusive calendar dates: at most 29 days for six-minute water levels.
  for (let cursor = Date.parse(iso(start).slice(0,10) + "T00:00:00Z"); cursor <= end;) {
    const finish = Math.min(cursor + 28 * DAY, end);
    const params = {product, application:"shorelysafe-selected-high-tides-v3", format:"json", station,
      time_zone:"gmt", units:"english", datum, begin_date:day(cursor), end_date:day(finish)};
    if (product === "predictions") params.interval = "hilo";
    const json = await publicJSON("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?" + new URLSearchParams(params), fetchImpl);
    if (json.metadata?.id && String(json.metadata.id) !== station) throw new Error("NOAA returned a different station.");
    const data = product === "predictions" ? json.predictions : json.data;
    if (!Array.isArray(data)) throw new Error("NOAA response is missing the requested data array.");
    for (const p of data) {
      const type = String(p.ty || p.type || "").toUpperCase();
      if (product === "predictions" && type !== "H") continue;
      if (product === "high_low" && !["H", "HH"].includes(type)) continue;
      const t = noaaTime(p.t), value = p.v;
      if (!Number.isFinite(t) || t < start || t > end) continue;
      if (product !== "predictions" && (value == null || typeof value === "boolean" || String(value).trim() === "" ||
          !Number.isFinite(Number(value)) || Math.abs(Number(value)) >= 100 || String(p.f || "").split(",")[0] === "1")) continue;
      rows.set(t, product === "predictions" ? {t:iso(t)} : {t:iso(t), ft:Number(value), ...(product === "high_low" ? {type} : {})});
    }
    cursor = Date.parse(iso(finish).slice(0,10) + "T00:00:00Z") + DAY;
  }
  return [...rows.values()].sort((a,b) => Date.parse(a.t) - Date.parse(b.t));
}
async function stationDatumOffset(station, fetchImpl = publicFetch) {
  const url = `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/${station}/datums.json?units=english`;
  const json = await publicJSON(url, fetchImpl);
  if (json.id != null && String(json.id) !== station) throw new Error("NOAA datum metadata identifies another station.");
  const value = name => {
    const row = json.datums?.find(d => d.name === name);
    return row?.value != null && String(row.value).trim() !== "" ? Number(row.value) : NaN;
  };
  const addFt = value("MLLW") - value("NAVD88");
  if (!Number.isFinite(addFt) || Math.abs(addFt) >= 20) throw new Error("Station-specific NAVD88 datum conversion is unavailable.");
  return {station, from:"MLLW", to:"NAVD88", addFt, source:url};
}
async function fetchNAVD({station, product, startISO, endISO, fetchImpl = publicFetch}) {
  const args = {station, product, startISO, endISO, fetchImpl};
  try {return {series:await fetchNOAA({...args, datum:"NAVD"}), datumConversion:null};}
  catch {
    // Obtain the donor's own offset, never the target gauge's conversion.
    const datumConversion = await stationDatumOffset(station, fetchImpl);
    return {series:(await fetchNOAA({...args, datum:"MLLW"})).map(p => ({...p, ft:p.ft + datumConversion.addFt})), datumConversion};
  }
}
async function fetchHourlyBackup({station, startISO, endISO, fetchImpl = publicFetch}) {
  const results = await Promise.allSettled(["water_level", "hourly_height"].map(product => fetchNAVD({station, product, startISO, endISO, fetchImpl})));
  const byTime = new Map(); let datumConversion = null;
  for (let i = 0; i < results.length; i++) {
    const result = results[i]; if (result.status !== "fulfilled") continue;
    datumConversion ||= result.value.datumConversion;
    for (const p of result.value.series) {
      const time = new Date(p.t);
      // The archive calibration used hourly maxima. Preliminary six-minute
      // values fill only exact UTC hours; verified hourly values win each slot.
      if (time.getUTCMinutes() === 0 && time.getUTCSeconds() === 0 && time.getUTCMilliseconds() === 0) byTime.set(Date.parse(p.t), p);
    }
  }
  if (!byTime.size) throw new Error("No usable hourly backup observations.");
  return {series:[...byTime.values()].sort((a,b) => Date.parse(a.t) - Date.parse(b.t)), datumConversion};
}
async function fetchRecent(config, cache, {now = Date.now(), fetchImpl = publicFetch} = {}) {
  allowedConfig(config);
  const engine = createEngine(config); engine.validateCache(cache);
  const start = Date.parse(cache.lastProcessedISO) - LOOKBACK_DAYS * DAY;
  if (Date.parse(cache.lastProcessedISO) > now + 5*60000 || now - Date.parse(cache.lastProcessedISO) > LOOKBACK_DAYS * DAY)
    throw new Error("History cursor requires a reviewed backfill.");
  const startISO = iso(start), endISO = iso(now);
  const clockPromise = fetchNOAA({station:config.clockStation, product:"predictions", datum:"MLLW", startISO:iso(start - 2*DAY), endISO:iso(now + 2*DAY), fetchImpl}).then(value => ({value}), () => ({failed:true}));
  let primary = [], verifiedHighs = [], hourly = [], backup = [], datumConversions = [];
  if (config.primaryAgency === "USGS") {
    const results = await Promise.allSettled([
      fetchObservations({site:config.primarySite, parameter:config.parameter, startISO, endISO, fetchImpl, warn:() => {}}),
      fetchHourlyBackup({station:config.backupSite, startISO, endISO, fetchImpl})
    ]);
    if (results[0].status === "fulfilled") primary = results[0].value;
    if (results[1].status === "fulfilled") {backup = results[1].value.series; if (results[1].value.datumConversion) datumConversions.push(results[1].value.datumConversion);}
  } else {
    const results = await Promise.allSettled(["high_low", "water_level", "hourly_height"].map(product => fetchNAVD({station:config.primarySite, product, startISO, endISO, fetchImpl})));
    for (let i = 0; i < results.length; i++) if (results[i].status === "fulfilled") {
      const result = results[i].value;
      if (i === 0) verifiedHighs = result.series;
      if (i === 1) primary = result.series;
      if (i === 2) hourly = result.series;
      if (result.datumConversion) datumConversions.push(result.datumConversion);
    }
  }
  const clockResult = await clockPromise;
  if (clockResult.failed) throw new Error("The public astronomical tide clock is unavailable.");
  const highs = clockResult.value;
  return {primary, verifiedHighs, hourly, backup, highs, startISO, datumConversions};
}
function verifiedHighEvents(engine, series, windows) {
  const events = [];
  for (const window of windows) {
    const start = Date.parse(window.windowStart), end = Date.parse(window.windowEnd);
    const points = engine.prepareSeries(series).filter(p => ["H", "HH"].includes(p.type) && p.ms >= start + HOUR && p.ms < end - HOUR);
    if (!points.length) continue;
    const best = points.reduce((a,b) => b.ft > a.ft ? b : a), local = engine.localParts(best.ms);
    events.push({...window, t:best.t, ft:best.ft, type:engine.classify(best.ft), kind:"HighTide", sourceRole:"primary",
      historyAgency:"NOAA", source:`NOAA ${engine.config.primarySite} verified high_low`, sourceStation:engine.config.primarySite,
      localDate:local.localDate, y:local.year, m:local.month, d:local.day, modelEligible:true, quality:{product:"high_low", verified:true, measuredHighType:best.type}});
  }
  return events;
}
function mergeRegistry(engine, existing, windows) {
  const registry = new Map((existing || []).map(w => [engine.eventId(w), w]));
  for (const w of windows) registry.set(engine.eventId(w), {crest:w.crest, windowStart:w.windowStart, windowEnd:w.windowEnd});
  return [...registry.values()].sort((a,b) => Date.parse(a.crest) - Date.parse(b.crest));
}
function alignPredictedHighs(engine, highs, cache) {
  const known = [...new Set([
    ...(cache.expectedCycleRegistry || []).map(w => Date.parse(w.crest)),
    ...(cache.expectedHighTideClocks || []).map(t => Date.parse(t)),
    ...cache.events.filter(e => String(e.cycleId).startsWith(engine.CLOCK_STATION + "@")).map(e => Date.parse(e.crest))
  ].filter(Number.isFinite))].sort((a,b) => a-b);
  const incoming = [...new Set((highs || []).map(h => Date.parse(typeof h === "string" ? h : h.t || h.crest)).filter(Number.isFinite))].sort((a,b) => a-b);
  const tolerance = 5*60000, used = new Set();
  return incoming.map(time => {
    let lo = 0, hi = known.length;
    while (lo < hi) {const mid = (lo+hi) >>> 1; if (known[mid] < time-tolerance) lo = mid+1; else hi = mid;}
    const matches = [];
    for (let i=lo; i<known.length && known[i]<=time+tolerance; i++) matches.push(known[i]);
    if (matches.length > 1 || matches.length === 1 && used.has(matches[0]))
      throw new Error("Ambiguous predicted high-tide anchor revision; cache and cursor were not advanced.");
    // Outside the supported five-minute revision range, a nearby old anchor
    // still identifies an existing tide. Never consume a missing denominator
    // by treating that revision as a new astronomical cycle.
    if (!matches.length && [known[lo-1], known[lo]].some(anchor => Number.isFinite(anchor) && Math.abs(anchor-time) < 8*HOUR))
      throw new Error("Unsupported nearby predicted high-tide anchor revision; cache and cursor were not advanced.");
    const anchor = matches.length ? matches[0] : time;
    used.add(anchor);
    return {t:engine.secondsISO(anchor)};
  });
}
async function updateCache(config, cache, recent, {now = Date.now(), fetchClock = fetchNOAA} = {}) {
  allowedConfig(config);
  const engine = createEngine(config); engine.validateCache(cache);
  const primary = recent.primary || [], backup = recent.backup || [], hourly = recent.hourly || [], verified = recent.verifiedHighs || [];
  const latest = Math.min(now, Math.max(newest(primary), newest(backup), newest(hourly), newest(verified)));
  if (!Number.isFinite(latest) || now - latest > 6*HOUR) throw new Error("Observed feeds are missing or stale by more than six hours; cache and cursor were not advanced.");
  const startISO = recent.startISO || iso(Date.parse(cache.lastProcessedISO) - LOOKBACK_DAYS*DAY);
  const alignedHighs = alignPredictedHighs(engine, recent.highs, cache);
  const clockTimes = alignedHighs.map(high => Date.parse(high.t));
  // A truncated successful prediction response must never advance the observed
  // cursor past clocks that have not entered expected exposure. Require the
  // entire reprocessing interval to be bracketed before building any updates.
  if (clockTimes.length < 3 || clockTimes[0] > Date.parse(startISO) || clockTimes.at(-1) < latest)
    throw new Error("The astronomical tide clock does not bracket the requested observation interval; cache and cursor were not advanced.");
  const windows = engine.buildWindows(alignedHighs, {startISO, latestObservedISO:iso(latest)});
  if (!windows.length || latest - Math.max(...windows.map(w => Date.parse(w.windowEnd))) > 16*HOUR)
    throw new Error("No recent complete neighboring astronomical tide window; cache and cursor were not advanced.");
  const p = engine.buildEvents({series:primary, windows});
  let primaryEvents = p.events, backupEvents = [], rejected = p.rejected;
  if (config.primaryAgency === "NOAA") {
    const h = engine.buildEvents({series:hourly, windows});
    const product = (event, name) => ({...event, quality:{...event.quality, product:name}});
    primaryEvents = engine.mergeEvents(h.events.map(e => product(e, "hourly_height")), p.events.map(e => product(e, "water_level")), []);
    primaryEvents = engine.mergeEvents(primaryEvents, verifiedHighEvents(engine, verified, windows), []);
    const rank = event => {
      const product = event.quality?.product || event.source || "";
      return /high_low/.test(product) ? 3 : /hourly/.test(product) ? 1 : 2;
    };
    const prior = new Map(cache.events.map(event => [engine.eventId(event), event]));
    primaryEvents = primaryEvents.filter(event => {
      const previous = prior.get(engine.eventId(event));
      return previous?.sourceRole !== "primary" || rank(event) >= rank(previous);
    });
  } else {
    const correction = Number(config.id === "flooddashboard--stone-harbor" ? cache.backup?.biasCorrectionFt : cache.calibration?.noaaBackup?.correctionFt);
    if (!Number.isFinite(correction) || Math.abs(correction) > 2) throw new Error("The approved flooding-high-tide backup calibration is unavailable.");
    const b = engine.buildEvents({series:backup, windows, sourceRole:"backup", biasCorrectionFt:correction});
    backupEvents = b.events;
    rejected = rejected.map(w => ({...w, backupReason:b.rejected.find(bw => bw.cycleId === w.cycleId)?.reason || null}));
  }
  const events = engine.mergeEvents(cache.events, primaryEvents, backupEvents);
  const completedEnd = Math.max(...windows.map(w => Date.parse(w.windowEnd)));
  const lastProcessedISO = engine.secondsISO(Math.max(Date.parse(cache.lastProcessedISO), latest)), fullYearExpected = {};
  for (const year of new Set(windows.map(w => engine.localParts(w.crest).year))) {
    if (cache.coverage.find(r => Number(r.year) === year)?.fullYearExpectedCycles != null) continue;
    const clocks = await fetchClock({station:config.clockStation, product:"predictions", datum:"MLLW", startISO:`${year}-01-01T00:00:00Z`, endISO:`${year+1}-01-02T00:00:00Z`});
    const count = new Set(clocks.filter(c => engine.localParts(c.t).year === year).map(c => engine.cycleId(c.t))).size;
    if (count < 690 || count > 720) throw new Error("Full-year astronomical tide table is incomplete.");
    fullYearExpected[year] = count;
  }
  const coverage = engine.reconcileCoverage(cache, windows, events, lastProcessedISO, fullYearExpected);
  for (const row of [...coverage.coverage, ...coverage.monthlyCoverage]) {
    if ("complete" in row) row.complete = row.acceptedCycles === row.expectedCycles;
    if ("coverage" in row) row.coverage = row.expectedCycles ? Math.round(row.acceptedCycles/row.expectedCycles*1e6)/1e6 : 0;
    if ("primaryCoverage" in row) row.primaryCoverage = row.expectedCycles ? Math.round(row.primaryCycles/row.expectedCycles*1e6)/1e6 : 0;
  }
  const result = {...cache, ...coverage, events, lastProcessedISO,
    ...(Object.hasOwn(cache, "annualCoverage") ? {annualCoverage:coverage.coverage} : {}),
    generatedAt:iso(now), observedThrough:engine.secondsISO(latest), updateCursor:lastProcessedISO, lastCompletedWindowEnd:engine.secondsISO(completedEnd),
    ...(Object.hasOwn(cache, "generatedUTC") ? {generatedUTC:iso(now)} : {}),
    liveUpdate:{checkedAt:iso(now), observedThrough:engine.secondsISO(latest), lastCompletedWindowEnd:engine.secondsISO(completedEnd), overlapDays:LOOKBACK_DAYS, completedWindows:windows.length,
      qualifiedPrimaryCycles:primaryEvents.length, qualifiedBackupCycles:backupEvents.length,
      primaryLatest:Number.isFinite(newest(primary)) ? engine.secondsISO(newest(primary)) : null,
      backupLatest:Number.isFinite(newest(backup)) ? engine.secondsISO(newest(backup)) : null,
      ...(recent.datumConversions?.length ? {datumConversions:recent.datumConversions} : {})}};
  if (Array.isArray(cache.expectedCycleRegistry)) {
    result.expectedCycleRegistry = mergeRegistry(engine, cache.expectedCycleRegistry, windows);
    const present = new Set(events.map(engine.eventId)), missing = new Map((cache.missingCycles || []).map(w => [engine.eventId(w), w]));
    for (const w of windows) {
      if (present.has(engine.eventId(w))) missing.delete(engine.eventId(w));
      else {
        const failure = rejected.find(r => r.cycleId === w.cycleId);
        missing.set(engine.eventId(w), {...w, localDate:engine.localParts(w.crest).localDate, primaryReason:failure?.reason || "no-observations", backupReason:failure?.backupReason || "no-observations"});
      }
    }
    result.missingCycles = [...missing.values()].sort((a,b) => Date.parse(a.crest) - Date.parse(b.crest));
  }
  if (Array.isArray(cache.expectedHighTideClocks)) result.expectedHighTideClocks = [...new Set([...cache.expectedHighTideClocks.map(t => engine.secondsISO(t)), ...windows.map(w => w.crest)])].sort((a,b) => Date.parse(a) - Date.parse(b));
  return result;
}
function mergeManifest(state, payloads) {
  const old = state?.manifest?.files;
  const allowedPaths = [...DATA_PATHS, ...(old?.[RECEIPT_PATH] ? [RECEIPT_PATH] : [])];
  if (!state?.published || !/^[a-f0-9]{64}$/.test(state.deployment || "") || !old ||
      JSON.stringify([...payloads.keys()].sort()) !== JSON.stringify(allowedPaths.sort())) throw new Error("Only the four selected tide-count paths and an existing refresh receipt may be replaced.");
  const files = new Map();
  for (const [name, value] of Object.entries(old)) {
    if (!/^[a-f0-9]{64}$/.test(value?.sha256 || "") || !Number.isSafeInteger(value.size) || value.size < 0) throw new Error("Invalid existing live manifest entry.");
    files.set(name, {path:name, sha256:value.sha256, size:value.size});
  }
  for (const name of INPUT_PATHS) if (!files.has(name)) throw new Error("The existing canonical tide input manifest is incomplete.");
  for (const [name, data] of payloads) files.set(name, {path:name, sha256:sha256(data), size:data.length});
  return [...files.values()].sort((a,b) => a.path.localeCompare(b.path));
}
async function serviceJSON(url, options) {try {return JSON.parse(await request(url, options));} catch {throw new Error("Selected high-tide publisher service is unavailable.");}}
async function loadSnapshot(config, state, {read = request} = {}) {
  const inputs = new Map();
  const names = [...INPUT_PATHS, ...(state?.manifest?.files?.[RECEIPT_PATH] ? [RECEIPT_PATH] : [])];
  await Promise.all(names.map(async name => {
    const entry = state?.manifest?.files?.[name];
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) throw new Error("Live canonical tide input is missing from the manifest.");
    const bytes = Buffer.from(await read(`${SITE}/shorelysafe/flooddashboard/${config.town}/${name}?v=${entry.sha256}`, {maxBytes:48*1024*1024}));
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw new ConcurrentPublication("Live tide inputs changed during snapshot capture.");
    inputs.set(name, bytes);
  }));
  const hash = sha256(inputs.get(CACHE_PATH));
  for (const name of [ANNUAL_PATH, FUTURE_PATH]) if (JSON.parse(inputs.get(name)).sourceSHA256 !== hash) throw new Error("Live tide count/model source binding is inconsistent.");
  return inputs;
}
function updateRefreshReceipt(raw, payloads) {
  const receipt = JSON.parse(raw);
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("The existing refresh receipt is invalid.");
  let changed = false;
  // This receipt can describe an older weather check. Change only existing
  // tide file fingerprints; no new weather check, timestamp, status or claim.
  for (const key of ["files", "payloads"]) {
    const entries = receipt[key];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const name of [CACHE_PATH, ANNUAL_PATH, FUTURE_PATH]) {
      if (!Object.hasOwn(entries, name)) continue;
      const entry = entries[name], data = payloads.get(name);
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || !/^[a-f0-9]{64}$/.test(entry.sha256 || "") ||
          !data || !(Object.hasOwn(entry,"size") || Object.hasOwn(entry,"bytes"))) throw new Error("The existing tide receipt fingerprint is invalid.");
      const hash = sha256(data);
      if (entry.sha256 !== hash || Object.hasOwn(entry,"size") && entry.size !== data.length || Object.hasOwn(entry,"bytes") && entry.bytes !== data.length) changed = true;
      entry.sha256 = hash;
      if (Object.hasOwn(entry,"size")) entry.size = data.length;
      if (Object.hasOwn(entry,"bytes")) entry.bytes = data.length;
    }
  }
  return changed ? Buffer.from(JSON.stringify(receipt,null,2) + "\n") : raw;
}
async function rebuildPayloads(inputs, cache, {run = execFileSync} = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "shorely-selected-tides-"));
  try {
    await fs.mkdir(path.join(temp, "data"));
    for (const [name, bytes] of inputs) await fs.writeFile(path.join(temp, name), bytes);
    const cacheBytes = stableJSON(cache); await fs.writeFile(path.join(temp, CACHE_PATH), cacheBytes);
    // The public shared count/model builder reads only this fresh public snapshot.
    run("python3", [path.join(__dirname, "rebuild_tide_statistics.py")], {cwd:temp, encoding:"utf8", maxBuffer:2*1024*1024, stdio:"pipe"});
    const payloads = new Map(await Promise.all(DATA_PATHS.map(async name => [name, await fs.readFile(path.join(temp, name))])));
    const hash = sha256(cacheBytes);
    for (const name of [ANNUAL_PATH, FUTURE_PATH]) if (JSON.parse(payloads.get(name)).sourceSHA256 !== hash) throw new Error("Rebuilt tide count/model source binding is inconsistent.");
    if (inputs.has(RECEIPT_PATH)) payloads.set(RECEIPT_PATH, updateRefreshReceipt(inputs.get(RECEIPT_PATH), payloads));
    return payloads;
  } finally {await fs.rm(temp, {recursive:true, force:true});}
}
class ConcurrentPublication extends Error {}
async function publishSnapshot(config, connection, state, payloads, {api = serviceJSON} = {}) {
  allowedConfig(config); validateConnection(connection);
  const base = `${SITE}/wp-json/shorelysafe/v1/apps/${config.id}/`, options = {token:connection.tokens[config.id], maxBytes:32*1024*1024};
  const files = mergeManifest(state, payloads), hashes = new Map([...payloads.values()].map(data => [sha256(data), data]));
  const plan = await api(base + "plan", {...options, method:"POST", body:{files, commit:"Public individual high tides and bound annual/future count models"}});
  if (!/^[a-f0-9]{64}$/.test(plan.deployment || "") || !Array.isArray(plan.missing) || plan.missing.some(hash => !hashes.has(hash))) throw new Error("Publisher plan requested a file outside the selected tide-count paths and existing receipt.");
  for (const hash of new Set(plan.missing)) {
    const bytes = hashes.get(hash);
    for (let offset = 0; offset < bytes.length;) {
      const chunk = bytes.subarray(offset, offset + 4*1024*1024);
      const result = await api(`${base}blobs/${hash}?deployment=${plan.deployment}&offset=${offset}`, {...options, method:"PUT", body:chunk});
      if (result.offset !== offset + chunk.length || !!result.complete !== (result.offset === bytes.length)) throw new Error("Tide-count upload offset or completion is invalid.");
      offset = result.offset;
    }
  }
  const before = await api(base + "state", options);
  if (before.deployment !== state.deployment) throw new ConcurrentPublication("Live deployment changed; retry from a new public snapshot.");
  await api(base + "commit", {...options, method:"POST", body:{deployment:plan.deployment}});
  const after = await api(base + "state?manifest=1", options);
  if (!after.published || after.deployment !== plan.deployment || Object.keys(after.manifest?.files || {}).length !== files.length ||
      files.some(f => after.manifest.files[f.path]?.sha256 !== f.sha256 || after.manifest.files[f.path]?.size !== f.size)) throw new Error("Published tide-count manifest did not preserve every live application file.");
  return {application:config.id, changed:true, publishedPaths:payloads.size, preservedFiles:files.length-payloads.size};
}
async function refreshApplication(config, connection, {api = serviceJSON, read = request, getRecent = fetchRecent, rebuild = rebuildPayloads, now = Date.now(), dryRun = false, retries = 2} = {}) {
  allowedConfig(config); validateConnection(connection);
  const base = `${SITE}/wp-json/shorelysafe/v1/apps/${config.id}/`, options = {token:connection.tokens[config.id], maxBytes:32*1024*1024};
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Every retry reloads and reprocesses all public live inputs; a stale payload
    // is never merged into a newer weather or application deployment.
    try {
      const state = await api(base + "state?manifest=1", options);
      const inputs = await loadSnapshot(config, state, {read}), cache = JSON.parse(inputs.get(CACHE_PATH));
      const recent = await getRecent(config, cache, {now}), updated = await updateCache(config, cache, recent, {now});
      const payloads = await rebuild(inputs, updated);
      const summary = {application:config.id, events:updated.events.length, lastProcessedISO:updated.lastProcessedISO, countUnit:updated.countUnit};
      if (dryRun) return {...summary, dryRun:true, changed:true};
      return {...summary, ...await publishSnapshot(config, connection, state, payloads, {api})};
    } catch (error) {if (!(error instanceof ConcurrentPublication) || attempt === retries) throw error;}
  }
}
async function main() {
  if (process.argv.slice(2).some(a => a !== "--dry-run")) throw new Error("Only --dry-run is supported.");
  let connection;
  try {connection = validateConnection(JSON.parse(process.env.SHORELYSAFE_HIGH_TIDE_CONNECTION || ""));}
  catch {throw new Error("SHORELYSAFE_HIGH_TIDE_CONNECTION must contain the approved three-app connection.");}
  const results = [];
  for (const config of CONFIG) {
    try {results.push(await refreshApplication(config, connection, {dryRun:process.argv.includes("--dry-run")}));}
    catch {results.push({application:config.id, error:"Selected high-tide refresh failed; live data and cursor were preserved unless publication already completed. Check public feed availability and rerun."});}
  }
  // Never print connection values, authenticated responses, HTML, or source.
  console.log(JSON.stringify({results}, null, 2));
  if (results.some(r => r.error)) process.exitCode = 1;
}
module.exports = {CONFIG, SITE, DATA_PATHS, INPUT_PATHS, CACHE_PATH, ANNUAL_PATH, FUTURE_PATH, PROJECTIONS_PATH, RECEIPT_PATH, LOOKBACK_DAYS,
  validateConnection, publicFetch, fetchNOAA, stationDatumOffset, fetchNAVD, fetchHourlyBackup, fetchRecent, verifiedHighEvents,
  alignPredictedHighs, updateCache, mergeManifest, loadSnapshot, updateRefreshReceipt, rebuildPayloads, publishSnapshot, refreshApplication, ConcurrentPublication};
if (require.main === module) main().catch(() => {console.error("The selected high-tide refresh could not start; verify its scoped connection and public inputs."); process.exitCode = 1;});
