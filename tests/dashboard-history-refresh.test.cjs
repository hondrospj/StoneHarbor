"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {APPS,sha256}=require("../tools/refresh_dashboard_petss");
const {CONFIG,HISTORY_PATH,buildEvents,updateCache,officialAuthority,fetchRecent,historyManifest,refreshHistory}=require("../tools/refresh_dashboard_history");
const now=Date.parse("2026-10-26T14:00:00Z"),hour=3600000,usgs=CONFIG[2],noaa=CONFIG[0];
const stamp=n=>new Date(now+n*hour).toISOString(),point=(n,ft)=>({t:stamp(n),ft});
function cache(config=usgs){return {site:config.site,datum:"NAVD88",...(config.parameter?{parameterCd:config.parameter}:{}),method:"original-method",provenance:{retain:"unchanged"},thresholdsNAVD88:Object.fromEntries(["minorLow","moderateLow","majorLow"].map((k,i)=>[k,config.thresholds[i]])),lastProcessedISO:stamp(-1),events:[]};}
const connection=()=>({site:"https://cupajoe.live",tokens:Object.fromEntries(APPS.map(a=>[a.id,"A".repeat(43)]))});

test("crest uses the maximum within two hours only when observations exist within one hour",()=>{
  const highs=[{t:stamp(-2)}],T=cache().thresholdsNAVD88;
  const events=buildEvents([point(-4.01,99),point(-4,8),point(-2,4),point(0.01,99)],highs,usgs,T);
  assert.equal(events.length,1);assert.equal(events[0].ft,8);assert.equal(events[0].t,stamp(-4));assert.equal(events[0].type,"Major");
  assert.deepEqual(buildEvents([point(-4,8)],highs,usgs,T),[]);
});
test("incremental overlap retains better old peaks and provenance while allowing higher observations",()=>{
  const original=cache();original.events=[{t:stamp(-2),ft:8,crest:stamp(-2),kind:"CrestHigh",custom:"preserved"},{t:"2000-01-01T00:00:00Z",ft:5,source:"historical-surrogate"}];
  const copy=JSON.parse(JSON.stringify(original));
  const lower=updateCache(original,[point(-2,4),point(0,3)],[{t:stamp(-2)}],usgs,{now});
  assert.equal(lower.cache.events.find(e=>e.crest).ft,8);assert.equal(lower.cache.events.length,2);assert.deepEqual(lower.cache.provenance,original.provenance);
  const higher=updateCache(original,[point(-2,9),point(0,3)],[{t:stamp(-2)}],usgs,{now});
  assert.equal(higher.cache.events.find(e=>e.crest).ft,9);assert.equal(higher.cache.events.find(e=>e.crest).custom,"preserved");assert.equal(higher.updated,1);
  assert.deepEqual(original,copy);
});
test("missing observations never delete prior good peaks or advance the cache cursor",()=>{
  const original=cache();original.events=[{t:stamp(-8),ft:7,crest:stamp(-8)}];
  const result=updateCache(original,[],[{t:stamp(-2)}],usgs,{now});assert.equal(result.cache,original);assert.equal(result.changed,false);
  assert.throws(()=>updateCache(original,[point(-8,5)],[{t:stamp(-8)}],usgs,{now}),/stale/);
});
test("official crest authority uses the New Jersey calendar date and keeps the highest official crest",()=>{
  const small={t:"2026-10-26T02:00:00Z",ft:8,officialCrestOverride:true,source:"official"};
  const large={t:"2026-10-25T23:00:00Z",ft:9,officialCrestOverride:true,source:"official",evidence:"retained"};
  const ordinary={t:"2026-10-26T03:00:00Z",ft:12};
  const nextDay={t:"2026-10-26T05:00:00Z",ft:6};
  assert.deepEqual(officialAuthority([small,large,ordinary,nextDay]),[large,nextDay]);
});
test("station, NAVD88 datum, thresholds and USGS parameter are validated before merging",()=>{
  for(const modified of [{...cache(),datum:"MLLW"},{...cache(),site:"123"},{...cache(),parameterCd:"00065"},{...cache(),thresholdsNAVD88:{minorLow:0,moderateLow:1,majorLow:2}}])
    assert.throws(()=>updateCache(modified,[point(0,3)],[{t:stamp(0)}],usgs,{now}),/configuration|parameter/);
});
test("NOAA fallback converts only the approved MLLW offset and keeps zero and negative observations",async()=>{
  const calls=[];
  const fake=async url=>{
    const u=new URL(url);calls.push(u);
    if(u.searchParams.get("product")==="predictions")return {ok:true,json:async()=>({predictions:[{t:"2026-10-26 13:00",v:"4",type:"H"}]})};
    if(u.searchParams.get("datum")==="NAVD")return {ok:true,json:async()=>({error:{message:"datum temporarily unavailable"}})};
    return {ok:true,json:async()=>({metadata:{id:noaa.site},data:[{t:"2026-10-26 13:00",v:"0"},{t:"2026-10-26 14:00",v:"-1"}]})};
  };
  const recent=await fetchRecent(noaa,cache(noaa),{now,fetchImpl:fake});
  assert(recent.series.some(p=>p.ft===-3.02));assert(recent.series.some(p=>p.ft===-4.02));assert.equal(recent.highs.length,1);
  assert(calls.filter(u=>u.searchParams.get("product")==="water_level").every(u=>u.searchParams.get("station")===noaa.site));
});

function service({foreignMissing=false,concurrent=false,paddingBytes=0}={}){
  const old=cache();if(paddingBytes)old.provenance.padding="x".repeat(paddingBytes);
  const bytes=Buffer.from(JSON.stringify(old));
  const original={published:true,deployment:"a".repeat(64),manifest:{files:{"index.html":{sha256:sha256(Buffer.from("private code")),size:12},"data/petss_forecast.json":{sha256:sha256(Buffer.from("mean data")),size:9},[HISTORY_PATH]:{sha256:sha256(bytes),size:bytes.length}}}};
  const calls=[];let planned,committed=false;
  const api=async(url,options={})=>{
    calls.push({url,method:options.method||"GET",body:options.body});
    if(url.endsWith("state?manifest=1"))return committed?{published:true,deployment:"b".repeat(64),manifest:{files:Object.fromEntries(planned.files.map(f=>[f.path,{sha256:f.sha256,size:f.size}]))}}:original;
    if(url.endsWith("/plan")){planned=options.body;return {deployment:"b".repeat(64),missing:[foreignMissing?original.manifest.files["index.html"].sha256:planned.files.find(f=>f.path===HISTORY_PATH).sha256]};}
    if(url.includes("/blobs/")){const offset=Number(new URL(url).searchParams.get("offset")),length=planned.files.find(f=>f.path===HISTORY_PATH).size;return {offset:offset+options.body.length,complete:offset+options.body.length===length};}
    if(url.endsWith("/state"))return {deployment:concurrent?"c".repeat(64):original.deployment};
    if(url.endsWith("/commit")){committed=true;return {published:true};}
    throw new Error("Unexpected test request");
  };
  return {api,calls,bytes,original};
}
test("history publication changes one path, preserves forecast and private code, and checks the final manifest",async()=>{
  const mock=service();
  const result=await refreshHistory(usgs,connection(),{api:mock.api,getCache:async()=>mock.bytes,getRecent:async()=>({series:[point(-1,4),point(0,3)],highs:[{t:stamp(-1)}]}),now});
  assert.equal(result.added,1);
  const plan=mock.calls.find(c=>c.url.endsWith("/plan")).body;
  for(const name of ["index.html","data/petss_forecast.json"])assert.deepEqual(plan.files.find(f=>f.path===name),{path:name,...mock.original.manifest.files[name]});
  const uploads=mock.calls.filter(c=>c.method==="PUT");assert.equal(uploads.length,1);assert(!uploads[0].body.includes(Buffer.from("private code")));
});
test("unexpected missing blobs and concurrent publications abort without committing",async()=>{
  for(const config of [{foreignMissing:true},{concurrent:true}]){
    const mock=service(config);
    await assert.rejects(refreshHistory(usgs,connection(),{api:mock.api,getCache:async()=>mock.bytes,getRecent:async()=>({series:[point(-1,4),point(0,3)],highs:[{t:stamp(-1)}]}),now}),/non-history|changed during/);
    assert.equal(mock.calls.some(c=>c.url.endsWith("/commit")),false);
  }
});
test("large history is uploaded in bounded four MiB chunks with verified offsets",async()=>{
  const mock=service({paddingBytes:5*1024*1024});
  await refreshHistory(usgs,connection(),{api:mock.api,getCache:async()=>mock.bytes,getRecent:async()=>({series:[point(-1,4),point(0,3)],highs:[{t:stamp(-1)}]}),now});
  const uploads=mock.calls.filter(c=>c.method==="PUT");assert.equal(uploads.length,2);
  assert(uploads.every(c=>c.body.length<=4*1024*1024));
  assert.equal(Number(new URL(uploads[1].url).searchParams.get("offset")),4*1024*1024);
});
test("public cache must match its captured manifest and unknown apps are rejected",async()=>{
  const mock=service();
  await assert.rejects(refreshHistory(usgs,connection(),{api:mock.api,getCache:async()=>Buffer.from("different cache"),now}),/differs/);
  assert.equal(mock.calls.some(c=>c.url.endsWith("/plan")),false);
  await assert.rejects(refreshHistory({...usgs,id:"floodmapper--stone-harbor"},connection()),/scope/);
});
