"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {monthlyMeanResponse,dailyPayload}=require("./sea-level-test-fixtures.cjs");
const repo=process.env.DASHBOARD_REPO||path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(repo,"index.html"),"utf8");
const cached=JSON.parse(fs.readFileSync(path.join(repo,"data/sealevel.json"),"utf8"));
const plain=value=>JSON.parse(JSON.stringify(value));
function source(name,optional=false){
  const start=html.indexOf("function "+name+"(");
  if(start<0&&optional)return "";
  assert(start>=0,name);const first=html.slice(start-6,start)==="async "?start-6:start;
  for(let end=html.indexOf("}",start);end>=0;end=html.indexOf("}",end+1)){
    const code=html.slice(first,end+1);
    try{new vm.Script("("+code+")");return code;}catch{}
  }
  throw Error("Cannot extract "+name);
}
function harness({cacheBody=null,dailyRows=null,dailyEmpty=false,monthly=true,monthlyBody=monthlyMeanResponse,gauge="USGS"}={}){
  const calls=[],warnings=[];let rendered=0;
  const ctx=vm.createContext({Date,URL,console:{warn:(...args)=>warnings.push(args.map(String).join(" "))},
    GAUGE_TYPE:gauge,USGS_SITE:"01411360",USGS_PARAM_PRIMARY:"72279",NOAA_SEA_LEVEL_STATION_CANDIDATES:["8557380"],
    SEA_LEVEL_JSON_PATH_CANDIDATES:["data/sealevel.json","./data/sealevel.json","../data/sealevel.json","/data/sealevel.json"],
    SEA_LEVEL_MIN_DAILY_VALUES_PER_MONTH:20,SEA_LEVEL_EXCLUDED_USGS_MONTHS:{},DOY_ANNUAL_FORECAST_ENABLED:false,
    seaLevelMeta:{textContent:""},SEA_LEVEL_STATE:null,renderSeaLevelChart:()=>{rendered++;}});
  const transport=async resource=>{
    const url=new URL(String(resource),"https://fixture.invalid/dashboard/");calls.push(url);
    if(url.hostname==="fixture.invalid")return {ok:cacheBody!==null,status:cacheBody?200:404,json:async()=>cacheBody};
    if(url.hostname==="waterservices.usgs.gov")return {ok:dailyRows!==null||dailyEmpty,status:dailyRows!==null||dailyEmpty?200:503,json:async()=>dailyPayload(dailyRows||[])};
    assert.equal(url.hostname,"api.tidesandcurrents.noaa.gov");
    assert.equal(url.searchParams.get("product"),"monthly_mean");
    return {ok:monthly,status:monthly?200:503,json:async()=>monthlyBody};
  };
  ctx.fetch=transport;ctx.fetchWithTimeout=transport;
  const names=["dashboardGaugeNumber","nowISO","ymdCompactFromISO","seaLevelNumber","normalizeSeaLevelPoint",
    "normalizeSeaLevelRegression","normalizeSeaLevelJson","monthKeyFromDate","decimalYearFromMonth",
    "computeMonthlySeaLevel","filterSeaLevelMonthlyQuality","relativeSeaLevelSeries","seaLevelLinearRegression",
    "seaLevelRegression","fetchSeaLevelJson","fetchUSGSDailySeaLevel","fetchNOAAMonthlySeaLevel","fetchDailySeaLevel","updateSeaLevelTrends"];
  vm.runInContext(source("fetchSeaLevelFallback",true),ctx);
  for(const name of names)vm.runInContext(source(name),ctx);
  return {ctx,calls,warnings,get rendered(){return rendered;},async update(){await ctx.updateSeaLevelTrends();return ctx.SEA_LEVEL_STATE;}};
}
function assertMonthlyState(h,state){
  assert.equal(h.rendered,1);assert.equal(h.ctx.seaLevelMeta.textContent,"");
  assert.equal(state.monthly.length,monthlyMeanResponse.data.length);
  assert.match(state.source,/NOAA.*monthly/i);
  assert(state.monthly.every(row=>row.days===undefined||row.days===null),"Published monthly means must not receive invented daily sample counts");
  for(const row of monthlyMeanResponse.data){
    const month=`${row.year}-${String(row.month).padStart(2,"0")}`;
    assert.equal(state.monthly.find(point=>point.month===month).ft,Number(row.MSL));
  }
}
test("NOAA monthly fallback survives failed cache and USGS requests with the correct source",async()=>{
  const h=harness();assertMonthlyState(h,await h.update());
  assert.equal(h.calls.filter(url=>url.hostname==="waterservices.usgs.gov").length,1);
});
test("an empty successful daily response also falls back to published monthly means",async()=>{
  const h=harness({dailyEmpty:true});assertMonthlyState(h,await h.update());
});
test("a NOAA gauge takes the monthly path directly without making a USGS daily request",async()=>{
  const h=harness({gauge:"NOAA"});assertMonthlyState(h,await h.update());
  assert.equal(h.calls.filter(url=>url.hostname==="waterservices.usgs.gov").length,0);
});
test("retained daily values retain the existing daily aggregation and quality path",async()=>{
  const h=harness({dailyRows:cached.daily}),state=await h.update();
  assert.equal(h.rendered,1);assert.equal(state.monthly.length,cached.monthly.length);
  assert.equal(state.source,"USGS daily values");
  assert(state.monthly.every(row=>row.days>=20));
  assert.equal(h.calls.filter(url=>url.searchParams.get("product")==="monthly_mean").length,0);
});
test("cached monthly values and their stored regression are unchanged",async()=>{
  const h=harness({cacheBody:cached}),state=await h.update();
  assert.equal(h.rendered,1);assert.equal(state.monthly.length,cached.monthly.length);
  assert.deepEqual(plain(state.monthly),plain(h.ctx.normalizeSeaLevelJson(cached).monthly));
  assert.deepEqual(plain(state.regression),plain(h.ctx.normalizeSeaLevelJson(cached).regression));
  assert.equal(state.source,"data/sealevel.json");
  assert.equal(h.calls.filter(url=>url.hostname!=="fixture.invalid").length,0);
});
test("a supported cached daily-only document keeps its existing aggregation path",async()=>{
  const h=harness({cacheBody:{daily:cached.daily}}),state=await h.update();
  assert.equal(h.rendered,1);assert.equal(state.monthly.length,cached.monthly.length);
  assert.equal(state.source,"data/sealevel.json");assert.equal(h.calls.length,1);
});
test("19 daily observations remain insufficient while 20 qualify",async()=>{
  for(const n of [19,20]){
    const dailyRows=Array.from({length:n},(_,i)=>({date:`2026-06-${String(i+1).padStart(2,"0")}`,ft:i/100}));
    const h=harness({dailyRows}),state=await h.update();
    assert.equal(h.rendered,n===20?1:0);
    if(n===19){assert.equal(state,null);assert.match(h.ctx.seaLevelMeta.textContent,/unavailable/);}
    else{assert.equal(state.monthly[0].days,20);assert(Math.abs(state.monthly[0].ft-.095)<1e-12);}
    assert.equal(h.calls.filter(url=>url.searchParams.get("product")==="monthly_mean").length,0);
  }
});
test("cached monthly daily-coverage metadata still rejects 19 and accepts 20",async()=>{
  for(const days of [19,20]){
    const h=harness({cacheBody:{monthly:[{month:"2026-06",ft:0,days}]}}),state=await h.update();
    assert.equal(h.rendered,days===20?1:0);
    if(days===20){assert.equal(state.monthly[0].ft,0);assert.equal(state.monthly[0].days,20);}
    else assert.equal(state,null);
    assert.equal(h.calls.length,1);
  }
});
test("all unavailable providers retain the existing visible unavailable result",async()=>{
  const h=harness({monthly:false});assert.equal(await h.update(),null);
  assert.equal(h.rendered,0);assert.match(h.ctx.seaLevelMeta.textContent,/Sea level data unavailable/);
  await assert.rejects(h.ctx.fetchDailySeaLevel(),/monthly sea-level means unavailable/);
});
test("provider and compatibility readers preserve their array-returning contracts",async()=>{
  const direct=harness({dailyRows:cached.daily});
  assert(Array.isArray(await direct.ctx.fetchUSGSDailySeaLevel()));
  assert(Array.isArray(await direct.ctx.fetchNOAAMonthlySeaLevel()));
  const daily=await direct.ctx.fetchDailySeaLevel();assert(Array.isArray(daily));assert.equal(daily.length,cached.daily.length);
  const fallback=await harness().ctx.fetchDailySeaLevel();assert(Array.isArray(fallback));assert.equal(fallback.length,monthlyMeanResponse.data.length);
});
test("valid zero monthly means remain data and missing calendar months remain gaps",async()=>{
  const h=harness(),state=await h.update();assertMonthlyState(h,state);
  assert.equal(state.monthly.find(row=>row.month==="2013-11").ft,0);
  assert.equal(state.monthly.find(row=>row.month==="2026-02"),undefined);
  assert.equal(state.relative.find(row=>row.month==="2026-02"),undefined);
});
test("monthly fallback retains chronological explicit months without changing provider values",async()=>{
  const monthlyBody={...monthlyMeanResponse,data:monthlyMeanResponse.data.slice().reverse()};
  const original=plain(monthlyBody),h=harness({monthlyBody}),state=await h.update();
  assertMonthlyState(h,state);
  const months=state.monthly.map(row=>row.month);
  assert.deepEqual(Array.from(months),Array.from(months).sort());
  assert.deepEqual(monthlyBody,original);
});
