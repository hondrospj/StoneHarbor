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
function harness({cacheBody=null,dailyRows=null,dailyBody=null,dailyEmpty=false,monthly=true,monthlyBody=monthlyMeanResponse,gauge="USGS",now="2026-08-04T16:00:00Z"}={}){
  const calls=[],warnings=[];let rendered=0;
  class FixedDate extends Date { constructor(...args){super(...(args.length?args:[now]));} }
  const ctx=vm.createContext({Date:FixedDate,URL,AbortSignal,console:{warn:(...args)=>warnings.push(args.map(String).join(" "))},
    GAUGE_TYPE:gauge,GAUGE_DISPLAY_NAME:"Stone Harbor",USGS_SITE:"01411360",USGS_PARAM_PRIMARY:"72279",NOAA_SEA_LEVEL_STATION_CANDIDATES:["8557380"],
    getESTParts:date=>({y:date.getUTCFullYear(),m:date.getUTCMonth()+1}),
    SEA_LEVEL_JSON_PATH_CANDIDATES:["data/sealevel.json","./data/sealevel.json","../data/sealevel.json","/data/sealevel.json"],
    SEA_LEVEL_MIN_DAILY_VALUES_PER_MONTH:20,SEA_LEVEL_EXCLUDED_USGS_MONTHS:{},DOY_ANNUAL_FORECAST_ENABLED:false,
    seaLevelMeta:{textContent:""},SEA_LEVEL_STATE:null,SEA_LEVEL_REFRESH_IN_FLIGHT:null,SEA_LEVEL_BACKFILL:null,
    SEA_LEVEL_PROVIDER_RETRY_AT:0,renderSeaLevelChart:()=>{rendered++;}});
  const transport=async resource=>{
    const url=new URL(String(resource),"https://fixture.invalid/dashboard/");calls.push(url);
    if(url.hostname==="fixture.invalid")return {ok:cacheBody!==null,status:cacheBody?200:404,json:async()=>cacheBody};
    if(url.hostname==="waterservices.usgs.gov"){
      const ok=dailyBody!==null||dailyRows!==null||dailyEmpty;
      return {ok,status:ok?200:503,json:async()=>dailyBody||dailyPayload(dailyRows||[])};
    }
    assert.equal(url.hostname,"api.tidesandcurrents.noaa.gov");
    assert.equal(url.searchParams.get("product"),"monthly_mean");
    return {ok:monthly,status:monthly?200:503,json:async()=>monthlyBody};
  };
  ctx.fetch=transport;ctx.fetchWithTimeout=transport;
  const names=["dashboardGaugeNumber","nowISO","ymdCompactFromISO","seaLevelNumber","normalizeSeaLevelPoint",
    "normalizeSeaLevelRegression","normalizeSeaLevelJson","monthKeyFromDate","decimalYearFromMonth",
    "computeMonthlySeaLevel","filterSeaLevelMonthlyQuality","validSeaLevelMonths","seaLevelBaseline","seaLevelLinearRegression",
    "seaLevelRegression","fetchSeaLevelJson","fetchUSGSDailySeaLevel","fetchNOAAMonthlySeaLevel","fetchDailySeaLevel",
    "applySeaLevelSnapshot","supplementSeaLevelMonths","updateSeaLevelTrends"];
  vm.runInContext(source("fetchSeaLevelFallback",true),ctx);
  for(const name of names)vm.runInContext(source(name),ctx);
  return {ctx,calls,warnings,get rendered(){return rendered;},async update(){await ctx.updateSeaLevelTrends();return ctx.SEA_LEVEL_STATE;}};
}
function assertMonthlyState(h,state){
  assert.equal(h.rendered,1);assert.match(h.ctx.seaLevelMeta.textContent,/NOAA Lewes monthly means through 2026-10/);
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
test("unusable or unrelated successful cache responses fall back to the configured provider",async()=>{
  for(const cacheBody of [{}, {...cached,station:"99999999"}, {...cached,datum:"MSL"}]){
    const h=harness({cacheBody});assertMonthlyState(h,await h.update());
    assert(h.calls.some(url=>url.searchParams.get("product")==="monthly_mean"));
  }
});
test("cached monthly means of the configured NOAA fallback station remain valid",async()=>{
  const h=harness({cacheBody:{station:"8557380",datum:"MSL",monthly:[{month:"2026-07",ft:1.0}]}});
  const state=await h.update();
  assert.equal(state.source,"data/sealevel.json");
  assert.equal(state.monthly[0].ft,1.0);
  assert.equal(h.calls.length,1);
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
test("the full USGS daily fallback selects the configured gauge even when another series comes first",async()=>{
  const dailyBody=dailyPayload(cached.daily);
  const wrongSeries=dailyPayload(cached.daily.map(row=>({...row,ft:5.2}))).value.timeSeries[0];
  wrongSeries.sourceInfo.siteCode[0].value="01408168";
  dailyBody.value.timeSeries.unshift(wrongSeries);
  const state=await harness({dailyBody}).update();
  assert.equal(state.source,"USGS daily values");
  assert(Math.abs(state.monthly[0].ft-cached.monthly[0].ft)<0.0001);
});
test("the cached trend keeps its slope and adopts the same zero point as the observations",async()=>{
  const h=harness({cacheBody:cached}),state=await h.update();
  assert.equal(h.rendered,1);assert.equal(state.monthly.length,cached.monthly.length);
  assert.deepEqual(plain(state.monthly),plain(h.ctx.normalizeSeaLevelJson(cached).monthly));
  assert.equal(state.regression.slope,cached.regression.slopeFtPerYear);
  assert.ok(Math.abs(state.baseline.ft + 0.14292)<1e-10);
  assert.equal(state.regression.intercept,cached.regression.interceptFt-state.baseline.ft);
  assert.match(h.ctx.seaLevelMeta.textContent,/Stone Harbor USGS monthly means through 2026-07\. Trend rate from NOAA Cape May \(1965–2025\)/);
  assert.equal(state.source,"data/sealevel.json");
  assert.equal(h.calls.filter(url=>url.hostname!=="fixture.invalid").length,0);
});
test("a stale local cache is supplemented with completed USGS months once per refresh window",async()=>{
  const points=(month,count)=>Array.from({length:count},(_,index)=>({date:`${month}-${String(index+1).padStart(2,"0")}`,ft:0.25}));
  const august=points("2026-08",20), september=points("2026-09",19);
  const dailyRows=[...august,...september,september[0],...points("2026-10",21),...points("2026-11",24)];
  const h=harness({cacheBody:cached,dailyRows,now:"2026-11-15T16:00:00Z"}),state=await h.update();
  const updates=h.calls.filter(url=>url.hostname==="waterservices.usgs.gov");
  assert.equal(updates.length,1);
  assert.equal(updates[0].searchParams.get("startDT"),"2026-08-01");
  assert.equal(updates[0].searchParams.get("endDT"),"2026-10-31");
  assert.deepEqual(Array.from(state.monthly.slice(-3),row=>row.month),["2026-07","2026-08","2026-10"]);
  assert.equal(state.monthly.at(-1).days,21);
  assert.equal(state.regression.officialTrend.station,"8536110");
  assert.strictEqual(await h.update(),state);
  assert.equal(h.rendered,1);
  assert.equal(h.calls.filter(url=>url.hostname==="waterservices.usgs.gov").length,1);
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
    if(n===19){
      assertMonthlyState(h,state);
    }else{
      assert.equal(h.rendered,1);
      assert.equal(state.monthly[0].days,20);
      assert(Math.abs(state.monthly[0].ft-.095)<1e-12);
      assert.equal(h.calls.filter(url=>url.searchParams.get("product")==="monthly_mean").length,0);
    }
  }
});
test("cached monthly daily-coverage metadata still rejects 19 and accepts 20",async()=>{
  for(const days of [19,20]){
    const h=harness({cacheBody:{monthly:[{month:"2026-06",ft:0,days}]}}),state=await h.update();
    if(days===20){
      assert.equal(h.rendered,1);
      assert.equal(state.monthly[0].ft,0);
      assert.equal(state.monthly[0].days,20);
      assert.equal(h.calls.length,1);
    }else{
      assertMonthlyState(h,state);
    }
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
