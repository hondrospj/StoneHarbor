"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {parseStationCsv}=require("../tools/petss-exceedance");
const {APPS,DATA_PATHS,request,chooseRun,chooseCycle,validateConnection,validateForecast,buildPayloads,mergeManifest,publishData,sha256}=require("../tools/refresh_dashboard_petss");
const now=Date.parse("2026-10-26T14:00:00Z");
const source={runDir:"petss.20261026",cycle:"t06z",url:"https://nomads.ncep.noaa.gov/pub/data/nccf/com/petss/prod/petss.20261026/petss.t06z.csv.tar.gz",sha256:"c".repeat(64)};
const isoHour=t=>new Date(t).toISOString().replace(/[-:TZ.]/g,"").slice(0,12);
const csv=(end=80)=>"TIME,TIDE,SURGE,TWL,TWL90p,TWL10p\n"+Array.from({length:end+121},(_,i)=>`${isoHour(now+(i-120)*3600000)},2,1,3,1,5`).join("\n");
const connection=()=>({site:"https://cupajoe.live",tokens:Object.fromEntries(APPS.map(a=>[a.id,"A".repeat(43)]))});
const entry=data=>({sha256:sha256(Buffer.from(data)),size:Buffer.byteLength(data)});
function state(){return {published:true,deployment:"a".repeat(64),manifest:{files:{"index.html":entry("private live application source"),"assets/runtime.js":entry("preserved code"),"data/peaks_navd88.json":entry("historical observations"),"data/petss_forecast.json":entry("old forecast")}}};}

test("select only published official run directories and cycles, not filename mentions",()=>{
  assert.equal(chooseRun('<a href="petss.20261025/">old</a><a href="petss.20261026/">new</a>'),"petss.20261026");
  assert.equal(chooseCycle('<a href="petss.t00z.csv.tar.gz">old</a><a href="petss.t06z.csv.tar.gz">new</a> petss.t18z.csv.tar.gz'),"t06z");
});
test("five-day hindcast is allowed but future coverage and cycle freshness are required",()=>{
  const rows=parseStationCsv(csv());
  assert.equal(validateForecast(rows,{...source,now}).points,201);
  assert.throws(()=>validateForecast(parseStationCsv(csv(20)),{...source,now}),/next 72 hours/);
  assert.throws(()=>validateForecast(rows,{...source,runDir:"petss.20261022",now}),/stale/);
  assert.throws(()=>validateForecast(rows,{...source,datum:"NAVD88",now}),/datum/);
  assert.throws(()=>validateForecast(rows.filter(r=>r.t!=="2026-10-27T10:00:00.000Z"),{...source,now}),/gap/);
});
test("never replace a missing mean with a percentile; preserve NOAA zero and negative values",()=>{
  assert.throws(()=>buildPayloads(APPS[0],"TIME,TWL90p,TWL10p\n202610261400,1,5",source,{now}),/mean TWL/);
  const rows=parseStationCsv(csv());rows[120].source_twl_mean=0;rows[120].twl=0;rows[121].source_twl_mean=-0.1;rows[121].twl=-0.1;
  assert.doesNotThrow(()=>validateForecast(rows,{...source,now}));
  rows[122].twl=4;assert.throws(()=>validateForecast(rows,{...source,now}),/adjusted/);
});
test("connection has exactly six app tokens and cannot target another site",()=>{
  assert.equal(validateConnection(connection()).site,"https://cupajoe.live");
  assert.equal(APPS.length,6);
  const old=connection();delete old.tokens["flooddashboard--cape-may-harbor"];assert.throws(()=>validateConnection(old),/exactly/);
  const extra=connection();extra.tokens["floodmapper--avalon"]="A".repeat(43);assert.throws(()=>validateConnection(extra),/exactly/);
  const other=connection();other.site="https://example.com";assert.throws(()=>validateConnection(other),/HTTPS site/);
});
test("Harbor retains its issued 8535901 MLLW mean forecast, distinct from Cape May observation station",()=>{
  const harbor=APPS.find(a=>a.id==="flooddashboard--cape-may-harbor");
  assert.equal(harbor.station,"8535901");assert.equal(harbor.datum,"MLLW");
  const payloads=buildPayloads(harbor,csv(),source,{now});
  const meta=JSON.parse(payloads.get("data/petss_meta.json")),rows=JSON.parse(payloads.get("data/petss_forecast.json"));
  assert.equal(meta.stid,"8535901");assert.equal(meta.custom_bias_correction,false);assert.equal(meta.forecast_adjustment_ft,0);
  assert(rows.every(r=>r.twl===r.source_twl_mean && r.twl===3));
  assert.throws(()=>buildPayloads({...harbor,station:"8536110"},csv(),source,{now}),/scope/);
});
test("publisher credentials never reach an off-origin destination or a redirect",async()=>{
  await assert.rejects(request("https://example.com/collect",{token:"A".repeat(43)}),/destination/);
  const https=require("node:https"),original=https.request;let requests=0;
  https.request=(url,options,callback)=>{
    requests++;
    assert.equal(url.origin,"https://cupajoe.live");
    return {setTimeout(){},on(){return this;},end(){callback({statusCode:302,headers:{location:"https://example.com/collect"},resume(){}});}};
  };
  try{await assert.rejects(request("https://cupajoe.live/wp-json/shorelysafe/v1/apps/flooddashboard--cape-may/state",{token:"A".repeat(43)}),/Redirect refused/);assert.equal(requests,1);}
  finally{https.request=original;}
});
test("forecast merge preserves every existing source, history and asset entry",()=>{
  const original=state(),copy=JSON.parse(JSON.stringify(original));
  const payloads=buildPayloads(APPS[0],csv(),source,{now});
  const merged=mergeManifest(original,payloads);
  for(const [name,value] of Object.entries(original.manifest.files))if(!DATA_PATHS.includes(name))assert.deepEqual(merged.find(f=>f.path===name),{path:name,...value});
  assert.deepEqual(original,copy);
  assert.equal(merged.length,7);
  assert.throws(()=>mergeManifest(original,new Map([["index.html",Buffer.from("replacement")]])),/four forecast/);
});

function fakeApi({foreignMissing=false,concurrent=false,changedDatum=false}={}){
  const original=state(),calls=[];let planned=null,committed=false;
  const api=async(url,options={})=>{
    calls.push({url,method:options.method||"GET",body:options.body});
    if(url.endsWith("petss_meta.json"))return {stid:APPS[0].station,datum:changedDatum?"NAVD88":"MLLW",run_dir:"petss.20261022",cycle:"t06z"};
    if(url.endsWith("state?manifest=1"))return committed?{published:true,deployment:"b".repeat(64),manifest:{files:Object.fromEntries(planned.files.map(f=>[f.path,{sha256:f.sha256,size:f.size}]))}}:original;
    if(url.endsWith("/plan")){planned=options.body;return {deployment:"b".repeat(64),missing:foreignMissing?[original.manifest.files["index.html"].sha256]:planned.files.filter(f=>DATA_PATHS.includes(f.path)).map(f=>f.sha256)};}
    if(url.includes("/blobs/"))return {complete:true,offset:options.body.length};
    if(url.endsWith("/state"))return {deployment:concurrent?"d".repeat(64):original.deployment};
    if(url.endsWith("/commit")){committed=true;return {published:true};}
    throw new Error("Unexpected test service request");
  };
  return {api,calls,original};
}
test("publication uploads only four public forecast files and verifies preserved manifest",async()=>{
  const mock=fakeApi(),src={...source,stations:new Map([[APPS[0].station,csv()]])};
  const result=await publishData(APPS[0],src,connection(),{api:mock.api,now});
  assert.equal(result.changed,true);
  const writes=mock.calls.filter(c=>c.method!=="GET");
  const uploads=writes.filter(c=>c.method==="PUT");assert.equal(uploads.length,4);
  for(const upload of uploads)assert(!upload.body.includes(Buffer.from("private live application source")));
  assert.equal(writes.at(-1).url.endsWith("/commit"),true);
});
test("unexpected missing source blobs abort before upload or commit",async()=>{
  const mock=fakeApi({foreignMissing:true});
  await assert.rejects(publishData(APPS[0],{...source,stations:new Map([[APPS[0].station,csv()]])},connection(),{api:mock.api,now}),/non-forecast/);
  assert.equal(mock.calls.some(c=>c.method==="PUT"||c.url.endsWith("/commit")),false);
});
test("concurrent deployments or station datum changes cannot be overwritten",async()=>{
  for(const config of [{concurrent:true},{changedDatum:true}]){
    const mock=fakeApi(config);
    await assert.rejects(publishData(APPS[0],{...source,stations:new Map([[APPS[0].station,csv()]])},connection(),{api:mock.api,now}),/changed during|station or datum/);
    assert.equal(mock.calls.some(c=>c.url.endsWith("/commit")),false);
  }
});
test("unknown apps are rejected before any service access",async()=>{
  let called=false;
  await assert.rejects(publishData({...APPS[0],id:"floodmapper--cape-may"},source,connection(),{api:()=>{called=true;},now}),/scope/);
  assert.equal(called,false);
});
