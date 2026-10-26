#!/usr/bin/env node
"use strict";

// Incremental public observations only; retain each live cache and every other app file.
const {APPS,SITE,request,validateConnection,sha256}=require("./refresh_dashboard_petss");
const {fetchObservations}=require("./usgs-observations");
const HISTORY_PATH="data/peaks_navd88.json",HOUR=3600000;
const CONFIG=Object.freeze([
  {id:"flooddashboard--cape-may",agency:"NOAA",site:"8536110",clock:"8536110",navdMinusMllw:-3.02,thresholds:[4.18,5.18,6.18]},
  {id:"flooddashboard--avalon",agency:"USGS",site:"01411355",clock:"8535419",parameter:"72279",thresholds:[3.42,4.42,5.22]},
  {id:"flooddashboard--stone-harbor",agency:"USGS",site:"01411360",clock:"8557380",parameter:"72279",thresholds:[3.44,4.44,5.44]},
  {id:"flooddashboard--sandy-hook",agency:"NOAA",site:"8531680",clock:"8531680",navdMinusMllw:-2.82,thresholds:[3.88,4.78,5.88]},
  {id:"flooddashboard--seaside-heights",agency:"USGS",site:"01408748",clock:"8534720",parameter:"72279",thresholds:[2.55,3.55,4.55]}
].map(c=>Object.freeze({...c,thresholds:Object.freeze(c.thresholds)})));
const dateFormatter=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"});
const iso=t=>new Date(t).toISOString(),roundFt=n=>Math.round(n*1000)/1000;
function localDate(event){
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(event.localDate||"")))return event.localDate;
  const d=new Date(event.t||event.time||event.timestamp||"");if(!Number.isFinite(+d))return "";
  const parts=dateFormatter.formatToParts(d),v=k=>parts.find(p=>p.type===k)?.value;
  return `${v("year")}-${v("month")}-${v("day")}`;
}
function officialAuthority(events){
  const best=new Map();
  for(const event of events){if(!event?.officialCrestOverride)continue;const key=localDate(event),value=Number(event.ft);if(key && Number.isFinite(value) && (!best.has(key)||value>Number(best.get(key).ft)))best.set(key,event);}
  return events.filter(event=>!best.has(localDate(event))||best.get(localDate(event))===event);
}
function validateCache(cache,config){
  if(!CONFIG.includes(config) || cache?.site!==config.site || cache?.datum!=="NAVD88" || !Array.isArray(cache.events))throw new Error("Live history station, datum or schema differs from the approved configuration.");
  if(config.agency==="USGS" && cache.parameterCd!==config.parameter)throw new Error("Unexpected USGS elevation parameter; no datum substitution is allowed.");
  const t=cache.thresholdsNAVD88;
  if(!t || [t.minorLow,t.moderateLow,t.majorLow].some((v,i)=>v!==config.thresholds[i]))throw new Error("Live history flood thresholds differ from the approved configuration.");
  if(!Number.isFinite(Date.parse(cache.lastProcessedISO)))throw new Error("Live history has no valid incremental cursor.");
  return cache;
}
function buildEvents(series,predictedHighs,config,thresholds){
  const points=series.filter(p=>Number.isFinite(Date.parse(p.t))&&Number.isFinite(p.ft)).slice().sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  const highs=predictedHighs.slice().sort((a,b)=>Date.parse(a.t)-Date.parse(b.t)),out=[];let left=0;
  for(const high of highs){
    const crest=Date.parse(high.t);if(!Number.isFinite(crest))continue;
    while(left<points.length && Date.parse(points[left].t)<crest-2*HOUR)left++;
    let best=null,near=false;
    for(let i=left;i<points.length && Date.parse(points[i].t)<=crest+2*HOUR;i++){
      const point=points[i];if(Math.abs(Date.parse(point.t)-crest)<=HOUR)near=true;
      if(!best || point.ft>best.ft)best=point;
    }
    if(!near || !best)continue;
    const ft=roundFt(best.ft),type=ft>=thresholds.majorLow?"Major":ft>=thresholds.moderateLow?"Moderate":ft>=thresholds.minorLow?"Minor":"Below";
    out.push({t:iso(Date.parse(best.t)),ft,type,crest:iso(crest),kind:"CrestHigh",historyAgency:config.agency,
      historySource:`${config.agency} ${config.site} primary continuous record`,source:config.agency==="USGS"?"primary-usgs-continuous":"primary-noaa-continuous",localDate:localDate(best)});
  }
  return out;
}
function updateCache(cache,series,highs,config,{now=Date.now()}={}){
  validateCache(cache,config);
  const start=Date.parse(cache.lastProcessedISO)-12*HOUR;
  const points=series.filter(p=>Number.isFinite(Date.parse(p.t))&&Date.parse(p.t)>=start&&Date.parse(p.t)<=now&&Number.isFinite(p.ft)&&Math.abs(p.ft)<100).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  if(!points.length || !highs.length)return {cache,changed:false,added:0,updated:0};
  const newest=Date.parse(points.at(-1).t);
  if(now-newest>6*HOUR)throw new Error("Recent observation feed is stale; history cursor was not advanced.");
  const events=cache.events.map(e=>({...e})),byCrest=new Map(events.filter(e=>e.crest).map(e=>[String(e.crest),e]));let added=0,updated=0;
  for(const event of buildEvents(points,highs,config,cache.thresholdsNAVD88)){
    const previous=byCrest.get(event.crest);
    if(!previous){events.push(event);byCrest.set(event.crest,event);added++;}
    else if(!Number.isFinite(Number(previous.ft))||event.ft>Number(previous.ft)){
      // Preserve existing provenance and any supplemental authority fields.
      for(const key of ["t","ft","type","kind","crest"])previous[key]=event[key];updated++;
    }
  }
  const merged=officialAuthority(events).sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  const cursor=iso(Math.max(Date.parse(cache.lastProcessedISO),newest));
  return {cache:{...cache,events:merged,lastProcessedISO:cursor},changed:added>0||updated>0||cursor!==cache.lastProcessedISO,added,updated};
}

async function publicFetch(url,options={}){
  const parsed=new URL(url);
  if(parsed.protocol!=="https:" || !["https://api.tidesandcurrents.noaa.gov","https://api.waterdata.usgs.gov","https://waterservices.usgs.gov"].includes(parsed.origin))throw new Error("Unapproved public observation service.");
  return fetch(url,{...options,redirect:"error",signal:options.signal||AbortSignal.timeout(30000)});
}
async function publicJson(url,fetchImpl=publicFetch){
  const response=await fetchImpl(url,{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Public observation service HTTP ${response.status}`);
  const data=await response.json();if(data?.error)throw new Error("Public observation service rejected the requested product or datum.");return data;
}
const day=t=>iso(t).slice(0,10).replaceAll("-","");
async function noaaChunk(config,product,datum,start,end,fetchImpl=publicFetch){
  const url=new URL("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter");
  url.search=new URLSearchParams({product,application:"shorelysafe-history-refresh",format:"json",station:product==="predictions"?config.clock:config.site,time_zone:"gmt",units:"english",datum,begin_date:day(start),end_date:day(end),...(product==="predictions"?{interval:"hilo"}:{})}).toString();
  const data=await publicJson(url.href,fetchImpl);
  if(product!=="predictions" && data.metadata?.id && String(data.metadata.id)!==config.site)throw new Error("NOAA returned observations for another station.");
  const values=product==="predictions"?data.predictions:data.data;
  if(!Array.isArray(values))throw new Error("NOAA response is missing the expected observation or prediction array.");
  return values.filter(p=>product!=="predictions"||p.type==="H").map(p=>{
    if(p.v==null || String(p.v).trim()==="")return null;
    const t=Date.parse(String(p.t).replace(" ","T")+"Z"),ft=Number(p.v);
    return Number.isFinite(t)&&Number.isFinite(ft)&&Math.abs(ft)<100?{t:iso(t),ft}:null;
  }).filter(Boolean);
}
async function fetchRecent(config,cache,{now=Date.now(),fetchImpl=publicFetch}={}){
  validateCache(cache,config);
  const start=Date.parse(cache.lastProcessedISO)-12*HOUR;
  if(start>now)throw new Error("History cursor is in the future.");
  if(now-start>45*24*HOUR)throw new Error("History requires a manual backfill before incremental refresh.");
  let series=[];
  if(config.agency==="USGS")series=await fetchObservations({site:config.site,parameter:config.parameter,startISO:iso(start),endISO:iso(now),fetchImpl,warn:()=>{}});
  else{
    for(let chunk=Date.parse(iso(start).slice(0,10)+"T00:00:00Z");chunk<=now;chunk+=31*24*HOUR){
      const end=Math.min(chunk+30*24*HOUR,now);
      try{series.push(...await noaaChunk(config,"water_level","NAVD",chunk,end,fetchImpl));}
      catch{const rows=await noaaChunk(config,"water_level","MLLW",chunk,end,fetchImpl);series.push(...rows.map(p=>({...p,ft:roundFt(p.ft+config.navdMinusMllw)})));}
    }
  }
  const highs=[];
  for(let chunk=Date.parse(iso(start-3*HOUR).slice(0,10)+"T00:00:00Z");chunk<=now+3*HOUR;chunk+=31*24*HOUR)
    highs.push(...await noaaChunk(config,"predictions","MLLW",chunk,Math.min(chunk+30*24*HOUR,now+3*HOUR),fetchImpl));
  return {series,highs};
}
function historyManifest(state,data){
  const original=state?.manifest?.files;
  if(!state?.published || !/^[a-f0-9]{64}$/.test(state.deployment||"") || !original?.["index.html"] || !original[HISTORY_PATH])throw new Error("Existing live history manifest is unavailable.");
  const files=Object.entries(original).map(([name,value])=>{
    if(!/^[a-f0-9]{64}$/.test(value?.sha256||"")||!Number.isSafeInteger(value.size)||value.size<0)throw new Error("Invalid existing live manifest entry.");
    return {path:name,sha256:value.sha256,size:value.size};
  });
  return files.map(f=>f.path===HISTORY_PATH?{path:HISTORY_PATH,sha256:sha256(data),size:data.length}:f);
}
async function serviceJson(url,options){const bytes=await request(url,options);try{return JSON.parse(bytes);}catch{throw new Error("Publisher returned invalid JSON.");}}
async function refreshHistory(config,connection,{api=serviceJson,getCache=null,getRecent=fetchRecent,now=Date.now(),dryRun=false}={}){
  if(!CONFIG.includes(config))throw new Error("History application is outside the approved scope.");
  if(!dryRun)validateConnection(connection);
  const app=APPS.find(a=>a.id===config.id),base=`${SITE}/wp-json/shorelysafe/v1/apps/${app.id}/`;
  const options=dryRun?{}:{token:connection.tokens[app.id],maxBytes:32*1024*1024};
  const state=dryRun?null:await api(base+"state?manifest=1",options);
  const cacheBytes=getCache?await getCache(app):await request(`${SITE}/shorelysafe/flooddashboard/${app.town}/${HISTORY_PATH}?v=${now}`,{maxBytes:32*1024*1024});
  const dataBytes=Buffer.isBuffer(cacheBytes)?cacheBytes:Buffer.from(cacheBytes);
  if(!dryRun && sha256(dataBytes)!==state?.manifest?.files?.[HISTORY_PATH]?.sha256)throw new Error("Live cache differs from its captured manifest; retry after concurrent publication.");
  const cache=JSON.parse(dataBytes),recent=await getRecent(config,cache,{now});
  const updated=updateCache(cache,recent.series,recent.highs,config,{now});
  const summary={application:app.id,added:updated.added,updated:updated.updated,lastProcessedISO:updated.cache.lastProcessedISO,events:updated.cache.events.length,changed:updated.changed};
  if(dryRun || !updated.changed)return summary;
  const data=Buffer.from(JSON.stringify(updated.cache,null,2)+"\n"),files=historyManifest(state,data),hash=sha256(data);
  const plan=await api(base+"plan",{...options,method:"POST",body:{files,commit:`Incremental ${config.agency} crest history ${updated.cache.lastProcessedISO}`}});
  if(!/^[a-f0-9]{64}$/.test(plan.deployment||"") || !Array.isArray(plan.missing) || plan.missing.some(h=>h!==hash))throw new Error("Plan requests non-history files; no application source will be uploaded.");
  if(plan.missing.length){
    for(let offset=0;offset<data.length;){
      const chunk=data.subarray(offset,offset+4*1024*1024);
      const result=await api(`${base}blobs/${hash}?deployment=${plan.deployment}&offset=${offset}`,{...options,method:"PUT",body:chunk});
      if(result.offset!==offset+chunk.length || !!result.complete!==(result.offset===data.length))throw new Error("History upload offset or completion is invalid.");
      offset=result.offset;
    }
  }
  if((await api(base+"state",options)).deployment!==state.deployment)throw new Error("Live deployment changed during history refresh; concurrent work was preserved.");
  await api(base+"commit",{...options,method:"POST",body:{deployment:plan.deployment}});
  const after=await api(base+"state?manifest=1",options);
  if(!after.published || after.deployment!==plan.deployment || Object.keys(after.manifest?.files||{}).length!==files.length || files.some(f=>after.manifest.files[f.path]?.sha256!==f.sha256||after.manifest.files[f.path]?.size!==f.size))throw new Error("Published history manifest did not preserve all other files.");
  return summary;
}
async function main(){
  const dryRun=process.argv.includes("--dry-run");let connection=null;
  if(!dryRun){try{connection=validateConnection(JSON.parse(process.env.SHORELYSAFE_DASHBOARD_CONNECTION||""));}catch{throw new Error("The approved five-dashboard publisher connection is required.");}}
  const results=[];
  for(const config of CONFIG){try{results.push(await refreshHistory(config,connection,{dryRun}));}catch(error){results.push({application:config.id,error:error.message});}}
  console.log(JSON.stringify({dryRun,results},null,2));if(results.some(r=>r.error))process.exitCode=1;
}
module.exports={CONFIG,HISTORY_PATH,localDate,officialAuthority,validateCache,buildEvents,updateCache,fetchRecent,historyManifest,refreshHistory};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
