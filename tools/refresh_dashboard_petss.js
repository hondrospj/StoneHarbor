#!/usr/bin/env node
"use strict";

// Public NOAA data only. Preserve every other file in each live application.
const https = require("node:https");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {execFileSync} = require("node:child_process");
const {parseStationCsv, forecastCsv, forecastMetadata} = require("./petss-exceedance");

const SITE = "https://cupajoe.live";
const NOMADS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/petss/prod/";
const APPS = Object.freeze([
  {id:"flooddashboard--cape-may", station:"8536110", town:"cape-may", datum:"MLLW"},
  {id:"flooddashboard--avalon", station:"8535419", town:"avalon", datum:"MLLW"},
  {id:"flooddashboard--stone-harbor", station:"8535581", town:"stone-harbor", datum:"MLLW"},
  {id:"flooddashboard--sandy-hook", station:"8531680", town:"sandy-hook", datum:"MLLW"},
  {id:"flooddashboard--seaside-heights", station:"est0006", town:"seaside-heights", datum:"MLLW"}
].map(Object.freeze));
const DATA_PATHS = Object.freeze([
  "data/petss_forecast.json", "data/petss_forecast.csv",
  "data/petss_meta.json", "data/petss_station_debug.txt"
]);
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");

function validateConnection(connection){
  if(!connection || typeof connection!=="object" || connection.site?.replace(/\/$/, "")!==SITE)
    throw new Error("Dashboard connection must target the configured HTTPS site.");
  const tokens=connection.tokens;
  const expected=APPS.map(a=>a.id).sort();
  if(!tokens || JSON.stringify(Object.keys(tokens).sort())!==JSON.stringify(expected))
    throw new Error("Dashboard connection must contain exactly the five allowed application credentials.");
  if(expected.some(id=>!/^[-_A-Za-z0-9]{43}$/.test(tokens[id])))
    throw new Error("Invalid dashboard publisher credential format.");
  return connection;
}

function request(url,{method="GET",body,token,maxBytes=64*1024*1024,redirects=0}={}){
  const parsed=new URL(url);
  const allowed=token ? SITE : (parsed.origin===new URL(NOMADS).origin ? new URL(NOMADS).origin : SITE);
  if(parsed.protocol!=="https:" || parsed.origin!==allowed || parsed.username || parsed.password)
    return Promise.reject(new Error("Refusing an unapproved request destination."));
  return new Promise((resolve,reject)=>{
    const headers={"User-Agent":"ShorelySafe-dashboard-PETSS-refresh/1.0", "Accept":"application/json,text/html,*/*"};
    if(token) headers["X-ShorelySafe-Token"]=token;
    if(body) headers["Content-Type"] = Buffer.isBuffer(body) ? "application/octet-stream" : "application/json";
    const payload=body==null ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    if(payload)headers["Content-Length"]=payload.length;
    const req=https.request(parsed,{method,headers},res=>{
      if(res.statusCode>=300 && res.statusCode<400){
        res.resume();
        const destination=res.headers.location ? new URL(res.headers.location,parsed) : null;
        // Credentials and write bodies never follow redirects, even on the same origin.
        if(token || method!=="GET" || !destination || destination.origin!==parsed.origin || redirects>=2)
          return reject(new Error("Redirect refused for this request."));
        return resolve(request(destination.href,{method,maxBytes,redirects:redirects+1}));
      }
      const chunks=[];let size=0;
      res.on("data",chunk=>{size+=chunk.length;if(size>maxBytes){res.destroy();reject(new Error("Response exceeded its size limit."));}else chunks.push(chunk);});
      res.on("end",()=>res.statusCode===200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`HTTP ${res.statusCode} from configured service.`)));
      res.on("error",()=>reject(new Error("Response stream failed.")));
    });
    req.setTimeout(90000,()=>req.destroy(new Error("Configured service request timed out.")));
    req.on("error",()=>reject(new Error("Configured service request failed.")));
    req.end(payload);
  });
}

async function jsonRequest(url,options){
  const data=await request(url,options);
  try{return JSON.parse(data.toString("utf8"));}catch{throw new Error("Configured service returned invalid JSON.");}
}

function chooseRun(index){
  return listedRuns(index)[0];
}
function listedRuns(index){
  const dates=[...new Set([...String(index).matchAll(/href=["']petss\.(\d{8})\/["']/g)].map(m=>m[1]))].sort().reverse();
  if(!dates.length)throw new Error("No official PETSS run directories listed.");
  return dates.map(date=>`petss.${date}`);
}
function chooseCycle(index){
  const cycles=[...String(index).matchAll(/href=["']petss\.(t(?:00|06|12|18)z)\.csv\.tar\.gz["']/g)].map(m=>m[1]).sort();
  if(!cycles.length)throw new Error("No official PETSS station-CSV cycle listed.");
  return cycles.at(-1);
}
function runTime(runDir,cycle){
  const d=/^petss\.(\d{4})(\d{2})(\d{2})$/.exec(runDir),h=/^t(00|06|12|18)z$/.exec(cycle);
  if(!d || !h)throw new Error("Invalid PETSS run identity.");
  const iso=`${d[1]}-${d[2]}-${d[3]}T${h[1]}:00:00.000Z`;
  if(new Date(iso).toISOString()!==iso)throw new Error("Invalid PETSS cycle date.");
  return Date.parse(iso);
}

function validateForecast(rows,{runDir,cycle,datum="MLLW",now=Date.now()}={}){
  if(datum!=="MLLW")throw new Error("Unexpected forecast datum; automatic conversion is not permitted.");
  const issued=runTime(runDir,cycle);
  if(issued>now+5*60000 || now-issued>24*3600000)throw new Error("PETSS cycle is future-dated or stale.");
  if(!Array.isArray(rows) || !rows.length)throw new Error("Missing NOAA mean forecast.");
  let previous=-Infinity;
  for(const row of rows){
    const t=Date.parse(row.t);
    if(!Number.isFinite(t) || t<=previous || !Number.isFinite(row.source_twl_mean) || row.twl!==row.source_twl_mean || Math.abs(row.twl)>=100)
      throw new Error("Invalid, duplicate or adjusted NOAA mean forecast point.");
    previous=t;
  }
  const future=rows.filter(row=>Date.parse(row.t)>now);
  if(!future.length || Date.parse(future[0].t)>now+75*60000 || Date.parse(rows.at(-1).t)<now+72*3600000)
    throw new Error("NOAA mean forecast does not cover the next 72 hours.");
  if(future.some((row,i)=>i>0 && Date.parse(row.t)-Date.parse(future[i-1].t)>75*60000))
    throw new Error("NOAA mean forecast has a gap in future coverage.");
  return {issuedTime:new Date(issued).toISOString(),validUntil:rows.at(-1).t,points:rows.length,futurePoints:future.length};
}

function buildPayloads(app,stationText,source,{now=Date.now(),existingMeta=null}={}){
  if(!APPS.some(a=>a.id===app.id && a.station===app.station && a.datum===app.datum && a.town===app.town))throw new Error("Application is outside the allowed dashboard scope.");
  const rows=parseStationCsv(stationText);
  const coverage=validateForecast(rows,{...source,datum:app.datum,now});
  const sameRun=existingMeta?.run_dir===source.runDir && existingMeta?.cycle===source.cycle;
  const meta={stid:app.station,datum:app.datum,run_dir:source.runDir,cycle:source.cycle,source_url:source.url,
    updated_utc:sameRun && Number.isFinite(Date.parse(existingMeta.updated_utc)) ? existingMeta.updated_utc : new Date(now).toISOString(),
    n_points:rows.length,...forecastMetadata,model_time_utc:coverage.issuedTime,
    forecast_valid_until_utc:coverage.validUntil,source_archive_sha256:source.sha256};
  return new Map([
    [DATA_PATHS[0],Buffer.from(JSON.stringify(rows,null,2)+"\n")],
    [DATA_PATHS[1],Buffer.from(forecastCsv(rows))],
    [DATA_PATHS[2],Buffer.from(JSON.stringify(meta,null,2)+"\n")],
    [DATA_PATHS[3],Buffer.from(stationText.split(/\r?\n/).slice(0,250).join("\n")+"\n")]
  ]);
}

function mergeManifest(state,payloads){
  const old=state?.manifest?.files;
  if(!state.published || !/^[a-f0-9]{64}$/.test(state.deployment||"") || !old || !old["index.html"])
    throw new Error("Existing live manifest is unavailable; refusing to replace an application.");
  if(JSON.stringify([...payloads.keys()].sort())!==JSON.stringify([...DATA_PATHS].sort()))
    throw new Error("Only the four forecast-data paths may be replaced.");
  const files=new Map();
  for(const [name,value] of Object.entries(old)){
    if(!value || !/^[a-f0-9]{64}$/.test(value.sha256||"") || !Number.isSafeInteger(value.size) || value.size<0)
      throw new Error("Existing manifest contains an invalid file entry.");
    files.set(name,{path:name,sha256:value.sha256,size:value.size});
  }
  for(const [name,data] of payloads)files.set(name,{path:name,sha256:sha256(data),size:data.length});
  return [...files.values()].sort((a,b)=>a.path.localeCompare(b.path));
}

async function loadSource({archive=null,runDir=null,cycle=null}={}){
  let temp=null;
  try{
    if(!archive){
      const runs=listedRuns((await request(NOMADS)).toString("utf8"));
      for(const candidate of runs){
        const listing=(await request(`${NOMADS}${candidate}/`)).toString("utf8");
        try{cycle=chooseCycle(listing);runDir=candidate;break;}catch{ /* A new day directory can precede its first completed CSV cycle. */ }
      }
      if(!cycle)throw new Error("No completed official PETSS CSV cycle is available.");
      temp=await fs.mkdtemp(path.join(os.tmpdir(),"shorely-petss-"));
      archive=path.join(temp,"forecast.tar.gz");
      await fs.writeFile(archive,await request(`${NOMADS}${runDir}/petss.${cycle}.csv.tar.gz`));
    }
    runTime(runDir,cycle);
    const bytes=await fs.readFile(archive);
    if(bytes.length>64*1024*1024)throw new Error("NOAA archive exceeded its size limit.");
    const tarOptions={encoding:"utf8",maxBuffer:4*1024*1024,env:{...process.env,LC_ALL:"C"}};
    const names=execFileSync("tar",["-tzf",archive],tarOptions).trim().split(/\r?\n/);
    const stations=new Map();
    for(const app of APPS){
      const expected=`${runDir}/${cycle}.csv/${app.station}.csv`;
      if(names.filter(name=>name===expected).length!==1)throw new Error(`Official station file missing or duplicated: ${app.station}`);
      const text=execFileSync("tar",["-xOf",archive,expected],tarOptions);
      validateForecast(parseStationCsv(text),{runDir,cycle,datum:app.datum});
      stations.set(app.station,text);
    }
    return {runDir,cycle,url:`${NOMADS}${runDir}/petss.${cycle}.csv.tar.gz`,sha256:sha256(bytes),stations};
  }finally{if(temp)await fs.rm(temp,{recursive:true,force:true});}
}

async function publishData(app,source,connection,{api=jsonRequest,now=Date.now()}={}){
  validateConnection(connection);
  if(!APPS.some(a=>a.id===app.id && a.station===app.station && a.datum===app.datum && a.town===app.town))throw new Error("Application is outside the allowed dashboard scope.");
  const token=connection.tokens[app.id];
  const base=`${SITE}/wp-json/shorelysafe/v1/apps/${app.id}/`;
  const options={token,maxBytes:16*1024*1024};
  const state=await api(base+"state?manifest=1",options);
  const currentMeta=await api(`${SITE}/shorelysafe/flooddashboard/${app.town}/data/petss_meta.json`,{maxBytes:128*1024});
  if(currentMeta.stid!==app.station || currentMeta.datum!==app.datum)throw new Error("Live station or datum differs from the approved configuration.");
  if(runTime(currentMeta.run_dir,currentMeta.cycle)>runTime(source.runDir,source.cycle))throw new Error("Refusing to replace a newer published NOAA cycle.");
  const payloads=buildPayloads(app,source.stations.get(app.station),source,{now,existingMeta:currentMeta});
  const files=mergeManifest(state,payloads);
  const changed=files.filter(f=>state.manifest.files[f.path]?.sha256!==f.sha256);
  if(!changed.length)return {application:app.id,changed:false,cycle:source.cycle};
  const hashes=new Map([...payloads].map(([,data])=>[sha256(data),data]));
  const plan=await api(base+"plan",{...options,method:"POST",body:{files,commit:`PETSS ${source.runDir}/${source.cycle} mean data`}});
  if(!/^[a-f0-9]{64}$/.test(plan.deployment||"") || !Array.isArray(plan.missing) || plan.missing.some(hash=>!hashes.has(hash)))
    throw new Error("Plan requests non-forecast data; refusing to upload application source.");
  for(const hash of new Set(plan.missing)){
    const data=hashes.get(hash);
    const result=await api(`${base}blobs/${hash}?deployment=${plan.deployment}&offset=0`,{...options,method:"PUT",body:data});
    if(!result.complete || result.offset!==data.length)throw new Error("Forecast data upload did not complete.");
  }
  const beforeCommit=await api(base+"state",options);
  if(beforeCommit.deployment!==state.deployment)throw new Error("Live deployment changed during refresh; refusing to overwrite concurrent work.");
  await api(base+"commit",{...options,method:"POST",body:{deployment:plan.deployment}});
  const after=await api(base+"state?manifest=1",options);
  if(!after.published || after.deployment!==plan.deployment || Object.keys(after.manifest?.files||{}).length!==files.length || files.some(f=>after.manifest.files[f.path]?.sha256!==f.sha256 || after.manifest.files[f.path]?.size!==f.size))
    throw new Error("Published manifest failed forecast-only preservation verification.");
  return {application:app.id,changed:true,cycle:source.cycle,forecastFiles:changed.length,preservedFiles:files.length-changed.length};
}

async function main(){
  const args=process.argv.slice(2),dry=args.includes("--dry-run");
  const arg=name=>{const i=args.indexOf(name);return i<0 ? null : args[i+1];};
  if(arg("--archive") && !dry)throw new Error("A local archive may be used only for a dry run.");
  let connection=null;
  if(!dry){try{connection=validateConnection(JSON.parse(process.env.SHORELYSAFE_DASHBOARD_CONNECTION||""));}catch{throw new Error("SHORELYSAFE_DASHBOARD_CONNECTION must contain the approved five-app connection.");}}
  const source=await loadSource({archive:arg("--archive"),runDir:arg("--run-dir"),cycle:arg("--cycle")});
  const results=[];
  for(const app of APPS){
    if(dry){const payloads=buildPayloads(app,source.stations.get(app.station),source);results.push({application:app.id,...validateForecast(JSON.parse(payloads.get(DATA_PATHS[0])),{...source,datum:app.datum})});}
    else{try{results.push(await publishData(app,source,connection));}catch(error){results.push({application:app.id,error:error.message});}}
  }
  console.log(JSON.stringify({source:source.url,sourceSha256:source.sha256,results},null,2));
  if(results.some(r=>r.error))process.exitCode=1;
}

module.exports={APPS,DATA_PATHS,SITE,NOMADS,validateConnection,request,chooseRun,chooseCycle,runTime,validateForecast,buildPayloads,mergeManifest,loadSource,publishData,sha256};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
