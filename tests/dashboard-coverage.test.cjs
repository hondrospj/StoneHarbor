"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const repo=process.env.DASHBOARD_REPO || path.resolve(__dirname,"..");
const tides=require(path.join(repo,"assets/individual-high-tides.js"));
const html=fs.readFileSync(path.join(repo,"index.html"),"utf8");
const threshold={minorLow:4,moderateLow:5,majorLow:6};
const event=(year,ft,id)=>({t:`${year}-02-01T12:00:00Z`,localDate:`${year}-02-01`,ft,cycleId:id,kind:"HighTide",sourceRole:"primary"});
function extract(name){
  const source=html.match(new RegExp("^(?:async )?function "+name+"\\([^\\n]*\\)\\{.*?^}","ms"));
  assert(source,`Missing ${name}`);return source[0];
}
function context(coverage){
  const ctx=vm.createContext({IndividualHighTides:tides,THRESH:{NAVD88:threshold},getESTParts:()=>({y:2026,m:10,d:29}),doyStageLabel:()=>"≥ 4 ft",console});
  ctx.coverage=coverage;
  vm.runInContext("let annualCoverageByYear=new Map(coverage.map(row=>[row.year,row])),DOY_CACHE=null;",ctx);
  for(const name of ["doyCompleteHistoricalYear","annualCoverageNote","annualTooltipFooter","doyCoverageMeta","buildDOYYearDailyCountsFromEvents","computeDOYStatsFromEvents","buildDoyAverageSeriesFromYearSeries","seasonalHistoricForecastInfo"]){vm.runInContext(extract(name),ctx);}
  return ctx;
}
const coverage=[
  {year:2020,expectedCycles:2,acceptedCycles:1,fullYearExpectedCycles:2,missingCycles:1},
  {year:2021,expectedCycles:1,acceptedCycles:1,fullYearExpectedCycles:1,missingCycles:0},
  {year:2022,expectedCycles:2,acceptedCycles:2,fullYearExpectedCycles:2,missingCycles:0},
  {year:2023,expectedCycles:1,acceptedCycles:1,fullYearExpectedCycles:2,missingCycles:0},
  {year:2024,expectedCycles:2,acceptedCycles:0,fullYearExpectedCycles:2,missingCycles:2},
  {year:2026,expectedCycles:2,acceptedCycles:1,fullYearExpectedCycles:705,missingCycles:1}
];
const events=[event(2020,6.2,"a"),event(2021,3,"b"),event(2022,4.2,"c"),event(2022,4.3,"d"),event(2023,6.2,"e"),event(2026,4.2,"f")];
test("cumulative observed lines preserve every count while complete zero-flood years enter the historical average",()=>{
  const ctx=context(coverage);ctx.events=events;
  const actual=JSON.parse(vm.runInContext("DOY_CACHE=computeDOYStatsFromEvents(events);JSON.stringify(DOY_CACHE)",ctx));
  assert.deepEqual(actual.completeYears,[2021,2022]);
  assert.equal(actual.avg[364],1);assert.equal(actual.min[364],0);assert.equal(actual.max[364],2);
  assert(!actual.years.includes(2024),"no accepted cycles must not create a dry-year line");
  for(const row of actual.seriesByYear){
    assert.equal(row.cum[364],events.filter(e=>Number(e.localDate.slice(0,4))===row.y&&e.ft>=4).length);
  }
  assert.match(vm.runInContext("doyCoverageMeta()",ctx),/1 cycle missing in 2026/);
});
test("no complete calendar year yields unknown historical statistics and no fabricated zero forecast",()=>{
  const ctx=context(coverage.filter(row=>![2021,2022].includes(row.year)));ctx.events=events.filter(e=>![2021,2022].includes(Number(e.localDate.slice(0,4))));
  const actual=JSON.parse(vm.runInContext("DOY_CACHE=computeDOYStatsFromEvents(events);JSON.stringify(DOY_CACHE)",ctx));
  for(const field of ["avg","min","max"])assert(actual[field].every(value=>value===null));
  assert.equal(vm.runInContext("seasonalHistoricForecastInfo(2026,DOY_CACHE.avg,DOY_CACHE.min,DOY_CACHE.max)",ctx),null);
  assert.match(vm.runInContext("doyCoverageMeta()",ctx),/no complete-year average/);
});
test("seasonal anchoring excludes partial years and retains an eligible zero-flood year",()=>{
  const ctx=context(coverage);ctx.events=events;
  vm.runInContext("DOY_CACHE=computeDOYStatsFromEvents(events)",ctx);
  const zero=JSON.parse(vm.runInContext("JSON.stringify(buildDoyAverageSeriesFromYearSeries(DOY_CACHE.seriesByYear,2022))",ctx));
  assert(zero.every(value=>value===0));
  const average=JSON.parse(vm.runInContext("JSON.stringify(buildDoyAverageSeriesFromYearSeries(DOY_CACHE.seriesByYear,2026))",ctx));
  assert.equal(average[364],1);
});
test("annual coverage footer distinguishes missing historical cycles, first partial years and current completed windows",()=>{
  const ctx=context(coverage);
  assert.equal(vm.runInContext("annualCoverageNote(2022)",ctx),"");
  assert.match(vm.runInContext("annualCoverageNote(2020)",ctx),/1\/2 cycles available; 1 missing \(partial record\)/);
  assert.match(vm.runInContext("annualCoverageNote(2023)",ctx),/1\/2 cycles available; 1 missing/);
  assert.match(vm.runInContext("annualCoverageNote(2026)",ctx),/1\/2 cycles available; 1 missing \(year to date; completed windows\)/);
  const footer=JSON.parse(vm.runInContext("JSON.stringify(annualTooltipFooter([{label:'2026'}],27))",ctx));
  assert.equal(footer[0],"Total: 27 flooding high tides");assert.equal(footer.length,2);
  assert(html.includes("return annualTooltipFooter(items,total)"),"annual tooltip must call coverage footer");
  assert(html.includes("${stageLabel} · ${doyCoverageMeta()}"),"cumulative meta must show coverage");
});
test("patched inline browser JavaScript parses",()=>{
  for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){
    assert.doesNotThrow(()=>new vm.Script(match[1]));
  }
});
