const test = require("node:test");
const assert = require("node:assert/strict");
const {createHash, webcrypto} = require("node:crypto");
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

function loadFunctions(context, names){
  for(const name of names){
    const match = html.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\)\\s*\\{[\\s\\S]*?^}`, "m"));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
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
  loadFunctions(context, ["dashboardGaugeNumber", "normalizePetssJsonToPoints", "validatePetssForecast", "fetchPETSSForecast_MLLW"]);
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

const earlierIssue = "2026-11-15T00:00:00.000Z";
const laterIssue = "2026-11-15T06:00:00.000Z";
const hour = 3600000;
const v41 = "ShorelySafe V41";
const petss = "NOAA PETSS fallback";
const sameOrigin = "/north-wildwood/floodmapper/data/v41/";
const pages = "https://hondrospj.github.io/North-Wildwood-floodmapper/data/v41/";

function v41Bundle(issue, level){
  const start = new Date(issue);
  const horizon = start.getUTCHours() % 12 === 0 ? 360 : 144;
  const headers = ["issue_utc", "valid_time_utc", "lead_hours", "weighted_mean_ft_NAVD88",
    "weighted_p10_ft_NAVD88", "weighted_p90_ft_NAVD88"];
  const rows = Array.from({length:horizon}, (_, index)=>{
    const lead = index + 1;
    return [issue, new Date(start.getTime() + lead * hour).toISOString(), lead, level, level - 1, level + 1].join(",");
  });
  const csv = [headers.join(","), ...rows].join("\n");
  const manifest = {
    status:"passed", experimental:true, weather_paths:103, issue_utc:issue, forecast_hours:horizon,
    mapForecast:{sourceType:"SHORELYSAFE_V41_WEIGHTED_ECMWF_103_PATHS", stationId:"8535581",
      usgsGaugeId:"01411360", mapDatum:"NAVD88", sourceCycleUtc:issue},
    files:{"latest.csv":{sha256:createHash("sha256").update(csv).digest("hex"), bytes:Buffer.byteLength(csv)}}
  };
  return {manifest, csv};
}

function v41Reader(localBundle, pagesBundle, hostname="cupajoe.live"){
  const requests = [];
  const context = vm.createContext({
    Date:FixedDate, TextDecoder, URL, crypto:webcrypto, location:{hostname},
    OFFSET_FROM_MLLW:{NAVD88:-2.66}, console:{warn(){}},
    async fetchWithTimeout(url){
      const [path] = url.split("?");
      requests.push(path);
      const bundle = path.startsWith(sameOrigin) ? localBundle : pagesBundle;
      if(!bundle) return new Response(null, {status:503});
      return new Response(path.endsWith("latest.csv") ? bundle.csv : JSON.stringify(bundle.manifest));
    }
  });
  vm.runInContext(html.match(/^const STONE_HARBOR_V41_.*$/gm).join("\n"), context);
  loadFunctions(context, ["parseStoneHarborV41", "fetchStoneHarborV41"]);
  return {context, requests};
}

test("V41 uses the newest complete forecast across both origins", async()=>{
  const local = v41Bundle(earlierIssue, 2);
  const mirrored = v41Bundle(laterIssue, 4);
  for(const [first, second] of [[local, mirrored], [mirrored, local]]){
    const {context, requests} = v41Reader(first, second);
    const loaded = await context.fetchStoneHarborV41();
    assert.equal(loaded.issuedTime, laterIssue);
    assert.equal(loaded.points[0].ft, 6.66);
    assert.deepEqual(requests, [sameOrigin + "latest.json", sameOrigin + "latest.csv", pages + "latest.json", pages + "latest.csv"]);
  }
});

test("V41 prefers the public site's same-cycle release and rejects a torn newer mirror bundle", async()=>{
  const local = v41Bundle(earlierIssue, 2);
  const sameCycle = v41Bundle(earlierIssue, 4);
  const newer = v41Bundle(laterIssue, 4);
  for(const mirror of [sameCycle, {...newer, csv:sameCycle.csv}, null]){
    const loaded = await v41Reader(local, mirror).context.fetchStoneHarborV41();
    assert.equal(loaded.issuedTime, earlierIssue);
    assert.equal(loaded.points[0].ft, 4.66);
  }
});

test("local V41 preview reads the Pages mirror directly", async()=>{
  const {context, requests} = v41Reader(null, v41Bundle(laterIssue, 4), "localhost");
  assert.equal((await context.fetchStoneHarborV41()).issuedTime, laterIssue);
  assert.deepEqual(requests, [pages + "latest.json", pages + "latest.csv"]);
});

function forecastRefresh(current, arriving){
  const providerLabel = {textContent:""};
  const end = "2026-11-19T12:00:00Z";
  const state = {
    waterForecastProvider:current?.provider,
    petssIssuedTime:current?.issue,
    pred72Mllw:current ? [{t:current.end || end, ft:current.level}] : []
  };
  const context = vm.createContext({
    Date:FixedDate, STATE:state, STONE_HARBOR_V41_PROVIDER:v41, STONE_HARBOR_V41_HOUR_MS:hour,
    console:{warn(){}}, document:{getElementById:()=>providerLabel}, renderTimeseries(){},
    async fetchDashboardWaterForecast(){
      if(!arriving) throw new Error("unavailable");
      return {provider:arriving.provider, issuedTime:arriving.issue, points:[{t:end, ft:arriving.level}]};
    }
  });
  loadFunctions(context, ["showDashboardForecastProvider", "updateForecastTimeseries"]);
  return context.updateForecastTimeseries().then(()=>({state, providerLabel}));
}

test("refresh retains a current forecast when either provider offers older guidance", async()=>{
  for(const current of [v41, petss]){
    for(const arriving of [v41, petss]){
      const {state} = await forecastRefresh({provider:current, issue:laterIssue, level:5},
        {provider:arriving, issue:earlierIssue, level:9});
      assert.equal(state.waterForecastProvider, current);
      assert.equal(state.petssIssuedTime, laterIssue);
      assert.equal(state.pred72Mllw[0].ft, 5);
    }
  }
});

test("same-provider revisions and same-cycle V41 recovery update the displayed levels and provider", async()=>{
  for(const [current, arriving] of [[v41, v41], [petss, petss], [petss, v41]]){
    const {state, providerLabel} = await forecastRefresh({provider:current, issue:laterIssue, level:5},
      {provider:arriving, issue:laterIssue, level:9});
    assert.equal(state.waterForecastProvider, arriving);
    assert.equal(providerLabel.textContent, arriving);
    assert.equal(state.pred72Mllw[0].ft, 9);
  }
});

test("retained V41 survives a transient fallback while expired V41 permits a usable replacement", async()=>{
  const current = {provider:v41, issue:earlierIssue, level:5};
  const fallback = {provider:petss, issue:laterIssue, level:9};
  const {state:retained} = await forecastRefresh(current, fallback);
  assert.equal(retained.waterForecastProvider, v41);
  assert.equal(retained.pred72Mllw[0].ft, 5);
  const expired = {...current, end:"2026-11-15T10:00:00Z"};
  const {state:replaced, providerLabel} = await forecastRefresh(expired, fallback);
  assert.equal(replaced.waterForecastProvider, petss);
  assert.equal(providerLabel.textContent, petss);
  const {state:unavailable} = await forecastRefresh(expired, null);
  assert.equal(unavailable.waterForecastProvider, null);
  assert.equal(unavailable.pred72Mllw.length, 0);
});
