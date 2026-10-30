"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const worker = require("../tools/refresh_selected_high_tides");
const {createEngine, HOUR:H} = require("../tools/tide-cycle-events");
const {sha256} = require("../tools/refresh_dashboard_petss");
const zero = Date.parse("2026-01-01T00:00:00Z"), t = h => new Date(zero+h*H).toISOString();
const clock = [0,12,24,36].map(h => ({t:t(h)}));
const connection = () => ({site:worker.SITE, tokens:Object.fromEntries(worker.CONFIG.map(c => [c.id,"a".repeat(43)]))});
const bytes = v => Buffer.from(JSON.stringify(v)+"\n");
const series = (maxima = {12:4,24:4.5}) => Array.from({length:37},(_,h) => ({t:t(h),ft:maxima[h] ?? 1}));
function event(config,h,ft=4,extra={}) {
  const e=createEngine(config), p=e.localParts(t(h));
  return {cycleId:e.cycleId(t(h)), crest:e.secondsISO(t(h)), t:t(h), ft, kind:"HighTide", sourceRole:"primary", modelEligible:true, historyAgency:config.primaryAgency,
    localDate:p.localDate, ...extra};
}
function cache(config=worker.CONFIG[0],events=[event(config,12),event(config,24,4.5)]) {
  return {method:"individual_high_tides_v3",countUnit:"individual-high-tide",site:config.primarySite,parameterCd:config.parameter,datum:"NAVD88",clockStation:config.clockStation,
    thresholdsNAVD88:config.thresholds,lastProcessedISO:t(30),backup:{biasCorrectionFt:.064},calibration:{noaaBackup:{correctionFt:-.283}},events,
    coverage:[{year:2026,expectedCycles:2,acceptedCycles:events.length,primaryCycles:events.length,missingCycles:2-events.length,fullYearExpectedCycles:705}],
    monthlyCoverage:[{year:2026,month:1,expectedCycles:2,acceptedCycles:events.length,primaryCycles:events.length,missingCycles:2-events.length}]};
}
const recent = (primary=series()) => ({primary,backup:[],hourly:[],verifiedHighs:[],highs:clock,startISO:t(0)});

test("sealed engines retain two flooding tides on a date and normalize equivalent cycle IDs",()=>{
  for(const config of worker.CONFIG) {
    const e=createEngine(config), windows=e.buildWindows(clock,{startISO:t(0),latestObservedISO:t(36)});
    const highs=e.buildEvents({series:series(),windows}).events;
    assert.equal(highs.length,2); assert.equal(highs[0].localDate,highs[1].localDate);
    assert.notEqual(highs[0].cycleId,highs[1].cycleId);
    const out=e.mergeEvents([event(config,12,3.5)],[{...event(config,12,3.4),cycleId:config.clockStation+"@"+t(12)}],[]);
    assert.equal(out.length,1);assert.equal(out[0].ft,3.4);
    assert(Object.isFrozen(e.config));assert(Object.isFrozen(e.THRESHOLDS));
    assert.equal(e.secondsISO(t(12)).endsWith(".000Z"),config.isoMilliseconds);
  }
});
test("qualified primary downward revisions remain authoritative during backup or primary feed failures",async()=>{
  const config=worker.CONFIG[0], old=cache(config,[event(config,12,3.44),event(config,24,4.5)]);
  const revised=await worker.updateCache(config,old,{...recent(series({12:3.43,24:4.5})),backup:series({12:7,24:7})},{now:zero+36*H});
  assert.equal(revised.events.find(e=>e.crest===event(config,12).crest).ft,3.43);
  const failed=await worker.updateCache(config,old,{...recent([]),backup:series({12:7,24:7})},{now:zero+36*H});
  assert.equal(failed.events.find(e=>e.crest===event(config,12).crest).ft,3.44);
  assert.equal(old.events[0].ft,3.44);
  assert.equal(revised.lastProcessedISO,"2026-01-02T12:00:00Z");
  assert.equal(revised.lastCompletedWindowEnd,"2026-01-02T06:00:00Z");
  assert.equal(revised.generatedAt,t(36));
});
test("a truncated successful clock cannot advance exposure past missing clocks, and the next complete table recovers",async()=>{
  const config=worker.CONFIG[0],old=cache(config),original=JSON.stringify(old);
  const measured=end=>Array.from({length:end+1},(_,h)=>({t:t(h),ft:h%12===0?4:1}));
  await assert.rejects(worker.updateCache(config,old,{...recent(measured(72)),highs:clock},{now:zero+72*H}),/does not bracket/);
  assert.equal(JSON.stringify(old),original);assert.equal(old.lastProcessedISO,t(30));
  const full=[0,12,24,36,48,60,72,84,96].map(h=>({t:t(h)}));
  const recovered=await worker.updateCache(config,old,{...recent(measured(84)),highs:full},{now:zero+84*H});
  assert.equal(recovered.coverage[0].expectedCycles,6);assert.equal(recovered.coverage[0].acceptedCycles,6);
  assert.equal(recovered.lastProcessedISO,"2026-01-04T12:00:00Z");assert.equal(recovered.lastCompletedWindowEnd,"2026-01-04T06:00:00Z");
  const again=await worker.updateCache(config,recovered,{...recent(measured(84)),highs:full},{now:zero+84*H});
  assert.equal(again.coverage[0].expectedCycles,6);assert.equal(again.coverage[0].acceptedCycles,6);
  await assert.rejects(worker.updateCache(config,old,{...recent(measured(84)),highs:full.slice(4)},{now:zero+84*H}),/does not bracket/);
});
test("five-minute prediction revisions keep immutable cycle anchors and a genuine new tide adds exposure only once",async()=>{
  const config=worker.CONFIG[1],engine=createEngine(config),old=cache(config);
  old.expectedHighTideClocks=[engine.secondsISO(t(12)),engine.secondsISO(t(24))];
  const shifted=[0,12,24,36,48].map(h=>({t:new Date(zero+h*H+((h===12||h===24)?5*60000:0)).toISOString()}));
  const measured=Array.from({length:43},(_,h)=>({t:t(h),ft:h%12===0?4:1}));
  const result=await worker.updateCache(config,old,{...recent(measured),highs:shifted},{now:zero+42*H});
  assert.equal(result.events.length,3);assert.equal(result.coverage[0].expectedCycles,3);assert.equal(result.coverage[0].acceptedCycles,3);
  assert.deepEqual(result.events.slice(0,2).map(e=>e.cycleId),old.events.map(e=>e.cycleId));
  assert.equal(result.events[2].cycleId,engine.cycleId(t(36)));
  const again=await worker.updateCache(config,result,{...recent(measured),highs:shifted},{now:zero+42*H});
  assert.equal(again.events.length,3);assert.equal(again.coverage[0].expectedCycles,3);
  assert.equal(result.expectedHighTideClocks.length,3);
  assert.throws(()=>worker.alignPredictedHighs(engine,[{t:t(12)},{t:new Date(zero+12*H+60000).toISOString()}],old),/Ambiguous/);
  const ambiguous={...old,expectedHighTideClocks:[engine.secondsISO(t(12)),new Date(zero+12*H+2*60000).toISOString()]};
  assert.throws(()=>worker.alignPredictedHighs(engine,[{t:new Date(zero+12*H+60000).toISOString()}],ambiguous),/Ambiguous/);
});
test("a six-minute anchor revision cannot consume an existing missing denominator or duplicate one measured tide",async()=>{
  const config=worker.CONFIG[0],old=cache(config,[event(config,12)]),before=JSON.stringify(old);
  const sparse=[...Array.from({length:19},(_,h)=>({t:t(h),ft:h===12?4:1})),{t:t(36),ft:1}];
  const shifted=[{t:t(0)},{t:new Date(zero+12*H+6*60000).toISOString()},{t:t(24)},{t:t(36)}];
  await assert.rejects(worker.updateCache(config,old,{...recent(sparse),highs:shifted},{now:zero+36*H}),/Unsupported nearby/);
  assert.equal(JSON.stringify(old),before);assert.equal(old.events.length,1);
  assert.equal(old.coverage[0].expectedCycles,2);assert.equal(old.coverage[0].acceptedCycles,1);assert.equal(old.coverage[0].missingCycles,1);
  const engine=createEngine(config);
  assert.throws(()=>worker.alignPredictedHighs(engine,[{t:new Date(zero+12*H-6*60000).toISOString()}],old),/Unsupported nearby/);
  assert.doesNotThrow(()=>worker.alignPredictedHighs(engine,[{t:t(24)}],old));
});
test("NOAA verified measured H/HH win their own clock, while low tides and daily maxima cannot become highs",async()=>{
  const config=worker.CONFIG[1], old=cache(config);
  const result=await worker.updateCache(config,old,{...recent(series({12:6,24:6})),hourly:series({12:7,24:7}),
    verifiedHighs:[{t:t(12),ft:3.8,type:"H"},{t:t(24),ft:4.2,type:"HH"},{t:t(13),ft:9,type:"L"}]},{now:zero+36*H});
  assert.deepEqual(result.events.map(e=>e.ft),[3.8,4.2]);
  assert(result.events.every(e=>e.quality.product==="high_low"));
  assert.equal(worker.verifiedHighEvents(createEngine(config),[{t:t(12),ft:9,type:"Daily Peak"}],createEngine(config).buildWindows(clock)).length,0);
});
test("NOAA fallback cannot downgrade an existing measured product, while equal-quality revisions can lower it",async()=>{
  const config=worker.CONFIG[1],old=cache(config,[event(config,12,4,{quality:{product:"high_low"}}),event(config,24,4.5,{source:"NOAA water_level"})]);
  const result=await worker.updateCache(config,old,{...recent([]),hourly:series({12:7,24:7})},{now:zero+36*H});
  assert.deepEqual(result.events.map(e=>e.ft),[4,4.5]);
  const revised=await worker.updateCache(config,old,recent(series({12:3,24:3.8})),{now:zero+36*H});
  assert.deepEqual(revised.events.map(e=>e.ft),[4,3.8]);
});
test("historical missing denominators survive and all coverage roles are initialized by astronomical anchor",async()=>{
  const config=worker.CONFIG[2], e=createEngine(config), old=cache(config,[event(config,12,4,{sourceRole:"backup"})]);
  old.coverage[0].primaryCycles=0; old.monthlyCoverage[0].primaryCycles=0;
  old.expectedCycleRegistry=[{crest:e.secondsISO(t(12)),windowStart:e.secondsISO(t(6)),windowEnd:e.secondsISO(t(18))},{crest:e.secondsISO(t(24)),windowStart:e.secondsISO(t(18)),windowEnd:e.secondsISO(t(30))}];
  old.missingCycles=[{cycleId:e.cycleId(t(24)),crest:e.secondsISO(t(24))}];old.annualCoverage=old.coverage;
  const sparse=series().filter(p=>Date.parse(p.t)<=zero+18*H || Date.parse(p.t)===zero+36*H);
  const result=await worker.updateCache(config,old,recent(sparse),{now:zero+36*H});
  assert.equal(result.coverage[0].expectedCycles,2);assert.equal(result.coverage[0].acceptedCycles,1);assert.equal(result.coverage[0].missingCycles,1);
  assert.equal(result.coverage[0].primaryCycles,1);assert.equal(result.coverage[0].backupCycles,0);assert.equal(result.coverage[0].officialCycles,0);
  assert.equal(result.missingCycles.length,1);assert.equal(result.expectedCycleRegistry.length,2);assert.deepEqual(result.annualCoverage,result.coverage);
  const previous={...old,events:[event(config,12,4,{sourceRole:"backup"}),{cycleId:"official:unknown",kind:"OfficialCrest",timeUnknown:true,t:null,localDate:"1962-03-06",ft:7,sourceRole:"official-crest"}]};
  const merged=e.mergeEvents(previous.events,[],[]), coverage=e.reconcileCoverage(previous,e.buildWindows(clock,{startISO:t(0),latestObservedISO:t(36)}),merged,t(36));
  assert.equal(coverage.coverage[0].backupCycles,1);assert.equal(coverage.coverage[0].missingCycles,1);assert.equal(merged.length,2);
});
test("NOAA request chunks cover 35 days with at most 29 inclusive dates and accept H plus HH only",async()=>{
  const calls=[];
  const data=await worker.fetchNOAA({station:"8531680",product:"high_low",startISO:"2026-01-01T00:00:00Z",endISO:"2026-02-05T00:00:00Z",fetchImpl:async url=>{
    const p=new URL(url).searchParams;calls.push(p);
    return {ok:true,json:async()=>({metadata:{id:"8531680"},data:[{t:"2026-01-01 12:00",v:"4",ty:"H"},{t:"2026-01-02 00:00",v:"5",ty:"HH"},{t:"2026-01-01 18:00",v:"8",ty:"L"}]})};
  }});
  assert.equal(calls.length,2);assert.deepEqual(data.map(p=>p.type),["H","HH"]);
  const date=s=>Date.parse(s.slice(0,4)+"-"+s.slice(4,6)+"-"+s.slice(6,8));
  for(const call of calls)assert((date(call.get("end_date"))-date(call.get("begin_date")))/(24*H)<=28);
});
test("hourly donor uses its own MDAPI offset and exact UTC-hour preliminary values beneath verified hours",async()=>{
  const urls=[];
  const out=await worker.fetchHourlyBackup({station:"8536110",startISO:t(0),endISO:t(24),fetchImpl:async url=>{
    const u=new URL(url);urls.push(u);
    if(u.pathname.includes("datums"))return {ok:true,json:async()=>({id:"8536110",datums:[{name:"MLLW",value:2.42},{name:"NAVD88",value:5.44}]})};
    if(u.searchParams.get("datum")==="NAVD")return {ok:true,json:async()=>({error:{message:"unavailable"}})};
    return {ok:true,json:async()=>({metadata:{id:"8536110"},data:u.searchParams.get("product")==="hourly_height"?[{t:"2026-01-01 12:00",v:"6.5"}]:[{t:"2026-01-01 12:00",v:"7"},{t:"2026-01-01 12:06",v:"9"},{t:"2026-01-01 13:00",v:"6"}]})};
  }});
  assert.equal(out.series.length,2);assert(Math.abs(out.series[0].ft-3.48)<1e-9);assert(Math.abs(out.series[1].ft-2.98)<1e-9);
  assert(urls.filter(u=>u.pathname.includes("datums")).every(u=>u.pathname.includes("/8536110/")));
});
function snapshot(config,weather="weather-v1",suffix="") {
  const raw=bytes(cache(config)), hash=sha256(raw), inputs=new Map([[worker.CACHE_PATH,raw],[worker.ANNUAL_PATH,bytes({sourceSHA256:hash})],[worker.FUTURE_PATH,bytes({sourceSHA256:hash})],[worker.PROJECTIONS_PATH,bytes({originYear:2026})],["index.html",Buffer.from("live-index"+suffix)],["data/petss_forecast.json",Buffer.from(weather)]]);
  const files=Object.fromEntries([...inputs].map(([name,data])=>[name,{sha256:sha256(data),size:data.length}]));
  return {inputs,state:{published:true,deployment:sha256(Buffer.from("deployment"+weather+suffix)),manifest:{files}}};
}
function payloads(snap) {return new Map(worker.DATA_PATHS.map(name=>[name,Buffer.from("updated-"+name)]));}
test("manifest scope preserves weather and refuses extra paths, missing bindings, or foreign credentials",()=>{
  const snap=snapshot(worker.CONFIG[0]), data=payloads(snap), merged=worker.mergeManifest(snap.state,data);
  assert.deepEqual(merged.find(f=>f.path==="data/petss_forecast.json"),{path:"data/petss_forecast.json",...snap.state.manifest.files["data/petss_forecast.json"]});
  assert.throws(()=>worker.mergeManifest(snap.state,new Map([...data,["extra.txt",Buffer.from("bad")]])),/four/);
  assert.throws(()=>worker.validateConnection({...connection(),site:worker.SITE+"/"}),/exact/);
  assert.throws(()=>worker.validateConnection({...connection(),tokens:{...connection().tokens,"flooddashboard--cape-may":"b".repeat(43)}}),/exact/);
  assert.throws(()=>worker.validateConnection({site:worker.SITE,tokens:{[worker.CONFIG[0].id]:"a".repeat(43)}}),/exact/);
});
test("public snapshot refuses a model that is not bound to the captured raw cache bytes",async()=>{
  const config=worker.CONFIG[0],snap=snapshot(config);
  const bad=bytes({sourceSHA256:"0".repeat(64)});snap.inputs.set(worker.FUTURE_PATH,bad);
  snap.state.manifest.files[worker.FUTURE_PATH]={sha256:sha256(bad),size:bad.length};
  const read=async url=>snap.inputs.get(new URL(url).pathname.split("/stone-harbor/")[1]);
  await assert.rejects(worker.loadSnapshot(config,snap.state,{read}),/binding/);
});
test("an existing refresh receipt updates only existing tide fingerprints, retaining every weather claim and timestamp",async()=>{
  const config=worker.CONFIG[1],snap=snapshot(config),data=payloads(snap);
  const receipt={profile:"dashboard",checkedAtUtc:"2026-01-01T00:00:00Z",latestObservationUtc:"2026-01-01T00:00:00Z",latestPeakProcessedUtc:t(30),latestUpstreamCycleUtc:"2026-01-01T00:00:00Z",forecastEndUtc:t(80),status:"existing-weather-check",validated:true,
    files:{...Object.fromEntries([worker.CACHE_PATH,worker.ANNUAL_PATH,worker.FUTURE_PATH].map(name=>[name,{...snap.state.manifest.files[name],note:"preserved"}])),"data/petss_forecast.json":{sha256:"a".repeat(64),size:123},"data/observations.json":{sha256:"b".repeat(64),size:456}},
    payloads:{[worker.CACHE_PATH]:{sha256:"c".repeat(64),bytes:12,provenance:"preserved"}}};
  const raw=bytes(receipt),copy=JSON.parse(raw);
  const revised=worker.updateRefreshReceipt(raw,data),out=JSON.parse(revised);
  for(const key of Object.keys(receipt).filter(k=>!["files","payloads"].includes(k)))assert.deepEqual(out[key],receipt[key]);
  assert.deepEqual(out.files["data/petss_forecast.json"],receipt.files["data/petss_forecast.json"]);
  assert.deepEqual(out.files["data/observations.json"],receipt.files["data/observations.json"]);
  for(const name of [worker.CACHE_PATH,worker.ANNUAL_PATH,worker.FUTURE_PATH])assert.deepEqual(out.files[name],{sha256:sha256(data.get(name)),size:data.get(name).length,note:"preserved"});
  assert.deepEqual(out.payloads[worker.CACHE_PATH],{sha256:sha256(data.get(worker.CACHE_PATH)),bytes:data.get(worker.CACHE_PATH).length,provenance:"preserved"});
  assert.deepEqual(JSON.parse(raw),copy);assert.equal(worker.updateRefreshReceipt(revised,data),revised);
  assert.throws(()=>worker.mergeManifest(snap.state,new Map([...data,[worker.RECEIPT_PATH,revised]])),/existing refresh receipt/);
  snap.inputs.set(worker.RECEIPT_PATH,raw);snap.state.manifest.files[worker.RECEIPT_PATH]={sha256:sha256(raw),size:raw.length};
  assert.throws(()=>worker.mergeManifest(snap.state,data),/existing refresh receipt/);
  data.set(worker.RECEIPT_PATH,revised);const merged=worker.mergeManifest(snap.state,data);
  assert.equal(merged.find(f=>f.path===worker.RECEIPT_PATH).sha256,sha256(revised));
  const read=async url=>snap.inputs.get(new URL(url).pathname.split("/sandy-hook/")[1]);
  assert.equal((await worker.loadSnapshot(config,snap.state,{read})).get(worker.RECEIPT_PATH).toString(),raw.toString());
});
test("statistics staging includes an existing receipt as the sole optional fifth path",async()=>{
  const config=worker.CONFIG[1],snap=snapshot(config),receipt={checkedAtUtc:t(0),files:{[worker.CACHE_PATH]:snap.state.manifest.files[worker.CACHE_PATH],[worker.FUTURE_PATH]:snap.state.manifest.files[worker.FUTURE_PATH],"weather.json":{sha256:"e".repeat(64),size:9}}};
  snap.inputs.set(worker.RECEIPT_PATH,bytes(receipt));
  const updated={...cache(config),generatedAt:t(36)},fs=require("node:fs"),path=require("node:path");
  const run=(_command,_args,options)=>{
    const hash=sha256(fs.readFileSync(path.join(options.cwd,worker.CACHE_PATH)));
    for(const name of [worker.ANNUAL_PATH,worker.FUTURE_PATH])fs.writeFileSync(path.join(options.cwd,name),bytes({sourceSHA256:hash}));
  };
  const output=await worker.rebuildPayloads(snap.inputs,updated,{run});
  assert.equal(output.size,5);assert.deepEqual([...output.keys()].sort(),[...worker.DATA_PATHS,worker.RECEIPT_PATH].sort());
  const after=JSON.parse(output.get(worker.RECEIPT_PATH));
  assert.equal(after.checkedAtUtc,t(0));assert.deepEqual(after.files["weather.json"],receipt.files["weather.json"]);
  assert.equal(after.files[worker.CACHE_PATH].sha256,sha256(output.get(worker.CACHE_PATH)));
  assert.equal(after.files[worker.FUTURE_PATH].sha256,sha256(output.get(worker.FUTURE_PATH)));
});
test("stale feeds abort before a publish plan and leave their cursor untouched",async()=>{
  const config=worker.CONFIG[0],snap=snapshot(config),calls=[];
  const read=async url=>snap.inputs.get(new URL(url).pathname.split("/stone-harbor/")[1]);
  await assert.rejects(worker.refreshApplication(config,connection(),{now:zero+36*H,api:async url=>{calls.push(url);return snap.state;},read,getRecent:async()=>recent([]),rebuild:async()=>{throw Error("must not rebuild");}}),/stale/);
  assert.equal(calls.length,1);assert.equal(JSON.parse(snap.inputs.get(worker.CACHE_PATH)).lastProcessedISO,t(30));
  await assert.rejects(worker.refreshApplication({...config},connection(),{api:async()=>{throw Error("must not call");}}),/scope/);
});
test("publisher chunks large count files and aborts a stale deployment before commit",async()=>{
  const config=worker.CONFIG[0],snap=snapshot(config),data=payloads(snap),calls=[];data.set(worker.CACHE_PATH,Buffer.alloc(4*1024*1024+7,65));
  const api=async(url,options={})=>{
    calls.push({url,options});
    if(url.endsWith("/plan"))return {deployment:"b".repeat(64),missing:[sha256(data.get(worker.CACHE_PATH))]};
    if(options.method==="PUT") {const offset=Number(new URL(url).searchParams.get("offset"))+options.body.length;return {offset,complete:offset===data.get(worker.CACHE_PATH).length};}
    if(url.endsWith("/state"))return {deployment:"c".repeat(64)};
    throw Error("commit must not occur");
  };
  await assert.rejects(worker.publishSnapshot(config,connection(),snap.state,data,{api}),worker.ConcurrentPublication);
  assert.deepEqual(calls.filter(c=>c.options.method==="PUT").map(c=>c.options.body.length),[4*1024*1024,7]);
  assert(!calls.some(c=>c.url.endsWith("/commit")));
});
test("concurrent publication retries all inputs and preserves the newest weather instead of replaying a stale manifest",async()=>{
  const config=worker.CONFIG[0],first=snapshot(config),second=snapshot(config,"weather-v2","new"),snaps=[first,second];
  let attempt=0,rebuilds=0,plans=0,committed=null,lastFiles;
  const read=async url=>{const u=new URL(url),hash=u.searchParams.get("v");return [...snaps[attempt].inputs.values()].find(data=>sha256(data)===hash);};
  const api=async(url,options={})=>{
    if(url.endsWith("/state?manifest=1"))return committed || snaps[attempt].state;
    if(url.endsWith("/plan")){plans++;lastFiles=options.body.files;return {deployment:"d".repeat(64),missing:[]};}
    if(url.endsWith("/state")){if(attempt===0){attempt++;return second.state;}return second.state;}
    if(url.endsWith("/commit")){committed={published:true,deployment:"d".repeat(64),manifest:{files:Object.fromEntries(lastFiles.map(f=>[f.path,{sha256:f.sha256,size:f.size}]))}};return {};}
    throw Error("unexpected call");
  };
  const rebuild=async inputs=>{rebuilds++;assert.equal(inputs.get("index.html").toString(),attempt?"live-indexnew":"live-index");return payloads(snaps[attempt]);};
  const result=await worker.refreshApplication(config,connection(),{api,read,getRecent:async()=>recent(),rebuild,now:zero+36*H});
  assert.equal(result.changed,true);assert.equal(rebuilds,2);assert.equal(plans,2);
  assert.equal(committed.manifest.files["data/petss_forecast.json"].sha256,second.state.manifest.files["data/petss_forecast.json"].sha256);
});
