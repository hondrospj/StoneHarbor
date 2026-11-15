const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync("index.html", "utf8");
const paths = ["data/petss_forecast.json", "data/petss_forecast_8535581_mllw.json"];
const now = Date.parse("2026-11-15T16:00:00Z");
const validUntil = "2026-11-19T12:00:00Z";
const points = [{t:validUntil, twl:4, source_twl_mean:3.125}];
const meta = {
  run_dir:"petss.20261115", cycle:"t06z", stid:"8535581", datum:"MLLW",
  forecast_valid_until_utc:validUntil
};

class FixedDate extends Date {
  static now(){ return now; }
}

function reader(primary, {metadata=meta, fallback=null}={}){
  const requests = [];
  const payloads = new Map([["data/petss_meta.json", metadata], [paths[0], primary], [paths[1], fallback]]);
  const context = vm.createContext({
    Date:FixedDate, AbortSignal, PETSS_STATION:"8535581", PETSS_JSON_CANDIDATES:paths,
    async fetch(url){
      const path = url.split("?")[0];
      requests.push(path);
      const body = payloads.get(path);
      return {ok:body !== null, status:body === null ? 404 : 200, json:async()=>body};
    }
  });
  for(const name of ["dashboardGaugeNumber", "normalizePetssJsonToPoints", "validatePetssForecast", "fetchPETSSForecast_MLLW"]){
    const match = html.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\)\\{[\\s\\S]*?^}`, "m"));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
  return {result:context.fetchPETSSForecast_MLLW(), requests};
}

test("expired guidance is rejected, even with a recent issue in metadata", async()=>{
  await assert.rejects(reader([{t:"2020-01-01T00:00:00Z",twl:4}]).result, /expired/);
});

test("issued means retain their value and model cycle", async()=>{
  const result = await reader(points).result;
  assert.equal(result.points[0].ft, 3.125);
  assert.equal(result.issuedTime, "2026-11-15T06:00:00.000Z");
  assert.equal(result.urlUsed, paths[0]);
});

test("a successful HTTP response without usable points tries the station-specific fallback", async()=>{
  const {result,requests} = reader({points:[]}, {fallback:points});
  assert.equal((await result).urlUsed, paths[1]);
  assert.deepEqual(requests, ["data/petss_meta.json", ...paths]);
});

test("freshness is based on NOAA issuance, not remaining valid times or download time", async()=>{
  await assert.rejects(reader(points, {metadata:{...meta,run_dir:"petss.20261114",cycle:"t12z",updated_utc:new Date(now).toISOString()}}).result, /stale/);
  await assert.rejects(reader(points, {metadata:{...meta,cycle:"t18z"}}).result, /future-dated/);
  await assert.rejects(reader({points,fetched_utc:new Date(now).toISOString()}, {metadata:null}).result, /issue time unavailable/);
});

test("separate metadata must match the point coverage, station, and datum", async()=>{
  await assert.rejects(reader(points, {metadata:{...meta,forecast_valid_until_utc:"2026-11-19T06:00:00Z"}}).result, /different runs/);
  await assert.rejects(reader(points, {metadata:{...meta,stid:"8557380"}}).result, /station/);
  await assert.rejects(reader(points, {metadata:{...meta,datum:"NAVD88"}}).result, /not in MLLW/);
  await assert.rejects(reader([points[0],points[0]]).result, /duplicate forecast times/);
});
