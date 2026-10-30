"use strict";
const test=require("node:test"), assert=require("node:assert/strict"), fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const repo=process.env.DASHBOARD_REPO || path.resolve(__dirname,"..");
const tides=require(path.join(repo,"assets/individual-high-tides.js"));
const html=fs.readFileSync(path.join(repo,"index.html"),"utf8");
const T={minorLow:4,moderateLow:5,majorLow:6};
const now="2026-10-29T16:00:00.000Z";
const event=(t,ft,cycleId,extra={})=>({t,ft,cycleId,crest:t,kind:"HighTide",historyAgency:"USGS",sourceRole:"primary",...extra});
const cache=(events,monthlyCoverage=[])=>({countUnit:tides.COUNT_UNIT,method:tides.METHOD,events,monthlyCoverage,coverage:[]});
const sum=count=>count.minor+count.moderate+count.major;
const normalize=events=>tides.normalizeCache(cache(events),{primaryAgency:"USGS"});
function extract(name){
  const match=html.match(new RegExp("^(?:async )?function "+name+"\\([^\\n]*\\)\\{.*?^}","ms"));
  assert(match,`Missing dashboard function ${name}`);return match[0];
}
function localParts(date){const p=tides.parts({t:date.toISOString()});return {y:p.year,m:p.month,d:p.day};}
function appContext(json){
  class FixedDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return Date.parse(now);}}
  const context=vm.createContext({IndividualHighTides:tides,Date:FixedDate,console,getESTParts:localParts,
    GAUGE_TYPE:"USGS",THRESH:{NAVD88:T},resolvePeaksJsonUrl:async()=>({json}),
    applyFilter(){},updateMonthAveragesFromHistory(){},renderAnnual(){},renderDOYCumPanel(){},
    ANNUAL_PREDICTIONS_ENABLED:false,ANNUAL_SCENARIO:"Baseline",FUTURE_FLOOD_PREDICTIONS:{},doyStageLabel:()=>"Flooding high tides"});
  vm.runInContext(`let HIGH_TIDES_NAVD=[],monthlyCoverage=[],stationAnnualCoverageYears=new Set(),annualCoverageByYear=new Map(),annualPredictionLookup=new Map(),annualSource=[],YEARS=[],annualMinor=[],annualModerate=[],annualMajor=[],DOY_CACHE=null,DOY_HISTORY_LOAD_STATE="loading";`,context);
  for(const name of ["normalizePeaksJson","annualYearFromEvent","inferStationAnnualCoverageYears","annualNumber","countEventsFromListForYear","buildStationAnnualCountsMap","buildAnnualArrays","combinedHistoricRowsNavd","calIndex365","doyCompleteHistoricalYear","buildDOYYearDailyCountsFromEvents","computeDOYStatsFromEvents","buildYTDSeriesFromEvents","emptyCurrentYTDSeries","computeMonthlyAveragesFromEvents","refreshDOYFromHistory","initJSONBackedHistory"]){
    vm.runInContext(extract(name),context);
  }
  return context;
}

test("two separate high tides on one local date both count, even in the same AM half-day",()=>{
  const rows=normalize([event("2024-01-04T05:01:00Z",4.2,"clock@2024-01-04T05:00Z"),event("2024-01-04T16:55:00Z",4.3,"clock@2024-01-04T17:00Z")]);
  assert.equal(rows.length,2);assert.equal(tides.localDate(rows[0]),tides.localDate(rows[1]));
  assert.equal(sum(tides.yearCounts(rows,2024,T)),2);
  assert.equal(tides.monthlyAverages(rows,[{year:2024,month:1,expectedCycles:2,acceptedCycles:2}],T,new Date(now))[0].avgTotal,2);
});
test("a flood tail past midnight and repeated source records stay one cycle",()=>{
  const cycle="clock@2024-03-01T04:50:00Z";
  const rows=normalize([event("2024-03-01T04:55:00Z",4.2,cycle),event("2024-03-01T05:05:00Z",4.1,cycle),event("2024-03-01T04:55:00Z",4.2,cycle)]);
  assert.equal(rows.length,1);assert.equal(sum(tides.yearCounts(rows,2024,T)),1);
});
test("source priority operates within one cycle, retaining distinct NOAA and USGS cycles",()=>{
  const rows=normalize([event("2024-01-04T06:00:00Z",4.2,"a"),event("2024-01-04T06:01:00Z",9,"a",{historyAgency:"NOAA",sourceRole:"donor"}),event("2024-01-04T18:00:00Z",4.3,"b",{historyAgency:"NOAA",sourceRole:"donor"})]);
  assert.equal(rows.length,2);assert.equal(rows.find(row=>row.cycleId==="a").ft,4.2);
  assert.deepEqual(new Set(rows.map(row=>row.historyAgency)),new Set(["NOAA","USGS"]));
});
test("an official crest replaces only its cycle and keeps a second tide on the date",()=>{
  const rows=normalize([event("2024-01-04T06:00:00Z",4.2,"a",{sourceRole:"backup",modelEligible:false}),event("2024-01-04T06:15:00Z",6.2,"a",{officialCrestOverride:true,sourceRole:"official-crest",modelEligible:false}),event("2024-01-04T18:00:00Z",4.3,"b")]);
  assert.equal(rows.length,2);assert.equal(rows.find(row=>row.cycleId==="a").ft,6.2);
  assert.deepEqual(tides.yearCounts(rows,2024,T),{minor:1,moderate:0,major:1});
});
test("a date-only official crest preserves unknown time, counts once and never enters an empirical fit",()=>{
  const official=event(null,6.4,"official:site@1974-12-01:catalogue-crest",{localDate:"1974-12-01",timeUnknown:true,officialCrestOverride:true,officialCrestOnly:true});
  const rows=normalize([official,official]);
  assert.equal(rows.length,1);assert.equal(rows[0].t,null);assert.equal(rows[0].timeUnknown,true);
  assert.equal(sum(tides.yearCounts(rows,1974,T)),1);assert.equal(tides.dailyCounts(rows,4).get(1974).reduce((a,b)=>a+b,0),1);
  assert.deepEqual(tides.fitEvents(rows),[]);assert.equal(tides.localDate(rows[0]),"1974-12-01");
});
test("a complete nonflooding month is zero; missing, incomplete and unfinished months are null",()=>{
  const rows=normalize([event("2024-01-04T06:00:00Z",3,"a"),event("2024-02-04T06:00:00Z",4.5,"b"),event("2026-10-04T06:00:00Z",5,"c")]);
  const coverage=[{year:2024,month:1,expectedCycles:1,acceptedCycles:1},{year:2024,month:2,expectedCycles:2,acceptedCycles:1},{year:2026,month:10,expectedCycles:1,acceptedCycles:1}];
  const stats=tides.monthlyAverages(rows,coverage,T,new Date(now));
  assert.equal(stats[0].avgTotal,0);assert.equal(stats[0].years,1);
  for(const month of [2,3,10]){assert.equal(stats[month-1].avgTotal,null);assert.equal(stats[month-1].years,0);}
  assert(tides.dailyCounts(rows,4).has(2024));assert.equal(tides.dailyCounts(rows,4).has(2025),false);
});
test("legacy daily peaks fail closed and null readings cannot become accepted zero-valued tides",()=>{
  assert.throws(()=>tides.normalizeCache({events:[event("2024-01-04T06:00:00Z",5,"a")]}),/legacy daily peaks/);
  const rows=normalize([event("2024-01-04T06:00:00Z",5,"a",{kind:"DailyPeak",legacyDailyPeak:true}),event("2024-01-04T06:00:00Z",5,"",{kind:"HighTide"}),event("2024-01-04T06:00:00Z",null,"b"),event("2024-01-04T06:00:00Z",0,"c")]);
  assert.equal(rows.length,1);assert.equal(rows[0].ft,0);
});
test("independent annual, cumulative year-end and monthly sums agree, including February 29",()=>{
  const fixtures=[event("2024-02-28T16:00:00Z",4.2,"a"),event("2024-02-28T23:00:00Z",5.2,"b"),event("2024-02-29T23:00:00Z",6.2,"c"),event("2024-07-01T16:00:00Z",3,"d"),event("2024-12-31T16:00:00Z",4.2,"e")];
  const rows=normalize(fixtures);
  const metadata=Array.from({length:12},(_,i)=>({year:2024,month:i+1,expectedCycles:2,acceptedCycles:2}));
  // Oracle uses only the raw fixture's threshold comparisons, with no dashboard helper.
  const oracle=fixtures.filter(row=>row.ft>=4).length;
  assert.equal(oracle,4);assert.equal(sum(tides.yearCounts(rows,2024,T)),oracle);
  const daily=tides.dailyCounts(rows,4).get(2024);assert.equal(daily[58],3);
  assert.equal(daily.reduce((a,b)=>a+b,0),oracle);
  assert.equal(tides.monthlyAverages(rows,metadata,T,new Date(now)).reduce((a,row)=>a+row.avgTotal,0),oracle);
});
test("dashboard history load connects one canonical event set to annual, cumulative, monthly and ranking",async()=>{
  const raw=[event("2024-02-28T16:00:00Z",4.2,"a"),event("2024-02-28T23:00:00Z",5.2,"b"),event("2024-02-29T23:00:00Z",6.2,"c",{historyAgency:"NOAA",sourceRole:"donor"}),event("2025-01-02T16:00:00Z",3,"d")];
  const json=cache(raw,[{year:2024,month:2,expectedCycles:3,acceptedCycles:3}]);
  json.coverage=[{year:2024,expectedCycles:3,acceptedCycles:3},{year:2025,expectedCycles:1,acceptedCycles:1},{year:2026,expectedCycles:0,acceptedCycles:0}];
  const context=appContext(json);await vm.runInContext("initJSONBackedHistory()",context);
  const values=JSON.parse(vm.runInContext("JSON.stringify({years:YEARS,minor:annualMinor,moderate:annualModerate,major:annualMajor,sources:annualSource,cumulative:DOY_CACHE.seriesByYear.map(row=>({year:row.y,total:row.cum[364]})),monthly:computeMonthlyAveragesFromEvents(HIGH_TIDES_NAVD),ranks:combinedHistoricRowsNavd().map(row=>({cycleId:row.cycleId,rank:row.rank})),ytd:emptyCurrentYTDSeries()})",context));
  const index=values.years.indexOf(2024);assert.equal(values.minor[index]+values.moderate[index]+values.major[index],3);
  assert.equal(values.cumulative.find(row=>row.year===2024).total,3);assert.equal(values.monthly[1].avgTotal,3);assert.equal(values.ranks.length,4);
  assert.equal(values.sources[index],"NOAA / USGS");
  assert.equal(values.minor[values.years.indexOf(2025)],0);assert.equal(values.minor[values.years.indexOf(2026)],null);
  assert.equal(values.cumulative.find(row=>row.year===2025).total,0);assert(values.ytd.every(value=>value===null));
  for(const token of ["bestByLocalDay","applyOfficialCrestDateAuthority","bestEventsByTideBucket","USGS_HISTORY_NAVD"]){assert.equal(html.includes(token),false,`${token} must not split the counting authority`);}
});
test("a successfully loaded empty canonical archive leaves loading state",async()=>{
  const context=appContext(cache([]));await vm.runInContext("initJSONBackedHistory()",context);
  assert.equal(vm.runInContext("DOY_CACHE",context),null);
  assert.equal(vm.runInContext("DOY_HISTORY_LOAD_STATE",context),"loaded");
});
test("retrospective empirical fits use the canonical primary-only monthly exposure model",()=>{
  assert.match(extract("pastAnnualForecastInfo"),/IndividualHighTides\.fitEvents\(eventsNavd\)/);
  assert.match(extract("doyAnnualDrawCountBeforeYear"),/IndividualHighTides\.fitEvents\(eventsNavd\)/);
  assert.match(html,/pastAnnualForecastInfo\(year, HIGH_TIDES_NAVD\)/);
  assert(html.includes("Average flooding high tides per month"));assert(!html.includes("Year visibility (USGS)"));
});
test("the total forecast mean and interval use explicit total fields without adding category endpoints",()=>{
  const context=vm.createContext({ANNUAL_SCENARIO:"Baseline",FUTURE_FLOOD_PREDICTIONS:{Baseline:[{year:2026,totalMean:17.7,totalP05:10,totalP95:25,minorMean:10.9,moderateMean:5.9,majorMean:0.9,minorMinus:100,moderateMinus:100,majorMinus:100,minorPlus:100,moderatePlus:100,majorPlus:100}]}});
  vm.runInContext(extract("currentAnnualForecastInfo"),context);
  const result=JSON.parse(vm.runInContext("JSON.stringify(currentAnnualForecastInfo(2026))",context));
  assert.equal(result.mean,17);assert.equal(result.low,10);assert.equal(result.high,25);
  assert.equal(result.minus,7);assert.equal(result.plus,8);
  assert(extract("pastAnnualForecastInfo").includes("IndividualHighTides.annualForecast("));
});
test("browser retrospective 2026 fit agrees with the regenerated Python 2026 baseline and exact total interval",()=>{
  const crypto=require("node:crypto"),raw=fs.readFileSync(path.join(repo,"data/peaks_navd88.json"));
  const json=JSON.parse(raw),future=JSON.parse(fs.readFileSync(path.join(repo,"data/future_flood_counts.json"),"utf8"));
  assert.equal(future.sourceSHA256,crypto.createHash("sha256").update(raw).digest("hex"),"future model must bind to the current canonical cache");
  const baseline=future.scenarios.Baseline.find(row=>row.year===2026);
  const fit=tides.annualForecast(json.events,json.coverage,json.monthlyCoverage,2026,future.trendFtPerYear,json.thresholdsNAVD88);
  assert(fit,"qualified primary history must support the retrospective model");
  assert.equal(fit.draws,baseline.drawsPerYear);
  assert(Math.abs(fit.meanRaw-baseline.totalMean)<1e-6,`browser ${fit.meanRaw} vs Python ${baseline.totalMean}`);
  assert.equal(fit.low,baseline.totalP05);assert.equal(fit.high,baseline.totalP95);
  assert.equal(fit.sourceHighTides,future.highTideCount);assert.deepEqual(fit.trainingYears,future.trainingYears);
});

test("qualified primary remains authoritative over a same-cycle official estimate in either source order",()=>{
 const measured=event("2024-01-04T06:00:00Z",4.2,"a",{modelEligible:true});
 const official=event("2024-01-04T06:00:00Z",7,"a",{sourceRole:"official-crest",modelEligible:false,officialCrestOverride:true});
 for(const rows of [[measured,official],[official,measured]]){const actual=normalize(rows);assert.equal(actual.length,1);assert.equal(actual[0].ft,4.2);}
});
