"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const repo=process.env.DASHBOARD_REPO || path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(repo,"index.html"),"utf8");
const tides=require(path.join(repo,"assets/individual-high-tides.js"));
const cache=JSON.parse(fs.readFileSync(path.join(repo,"data/peaks_navd88.json"),"utf8"));
const plain=value=>JSON.parse(JSON.stringify(value));
function source(name,optional=false){
  const match=html.match(new RegExp("^[ \\t]*(?:async )?function "+name+"\\([^\\n]*\\)\\{[\\s\\S]*?^}","m"));
  if(optional && !match)return "";
  assert(match,`Missing actual application function ${name}`);
  return match[0];
}
function constant(name){
  const match=html.match(new RegExp("^const "+name+" = (.*);$","m"));
  assert(match,`Missing application constant ${name}`);
  return vm.runInNewContext("("+match[1]+")");
}
const THRESH=constant("THRESH"),OFFSET_FROM_MLLW=constant("OFFSET_FROM_MLLW");
function harness(){
  const ctx=vm.createContext({Date,console,Math,Number,THRESH,OFFSET_FROM_MLLW,DISPLAY_DATUM:"NAVD88",
    TS_STEP_MS:900000,TS_MAX_DELTA_FT:.75,HOUR_MS:3600000,TS_ANNUAL_FORECAST_ENABLED:false,
    IndividualHighTides:tides,HISTORY_LOAD_STATE:"loaded"});
  vm.runInContext(source("compareFeet",true),ctx);
  for(const name of ["mllwToDatum","datumToMllw","datumToDatum","toDisplayFtFromNavd","toDisplayFtFromMllw",
    "fromDisplayToNavd","classifyByNavd","stageNameFromDisplayFt","colorForFtDisplay","interpFtAtMs","stageRank",
    "splitIntervalByFloodThresholds","buildExactFloodAccounting","filterSpikes15Min","applyFilter"]){
    vm.runInContext(source(name),ctx);
  }
  return ctx;
}
function filter(ctx,min="",max="",events=cache.events){
  Object.assign(ctx,{minElevEl:{value:String(min)},maxElevEl:{value:String(max)},fromDateEl:{value:""},toDateEl:{value:""},
    sortModeEl:{value:"recent"},combinedHistoricRowsNavd:()=>events,historicDateKey:tides.localDate});
  let result;ctx.renderHist=rows=>{result=rows;};ctx.applyFilter();return result;
}
function account(ctx,values){
  const points=values.map((mllw,index)=>({ms:index*3600000,ftDisplay:ctx.toDisplayFtFromMllw(mllw)}));
  return ctx.buildExactFloodAccounting(points,0,(values.length-1)*3600000);
}

test("a real observation gap releases the old spike anchor without changing smooth readings",()=>{
  const ctx=harness(),values=[3.2,null,null,null,null,4,4.1,4.2,4.3,4.4,4.5];
  assert.deepEqual(Array.from(ctx.filterSpikes15Min(values)),values);
});
test("an isolated spike remains masked and does not become the following reading's baseline",()=>{
  const ctx=harness();
  assert.deepEqual(Array.from(ctx.filterSpikes15Min([0,.1,4,.2,.3])),[0,.1,null,.2,.3]);
  assert.deepEqual(Array.from(ctx.filterSpikes15Min([.1,4,null,2.2,2.3])),[.1,null,null,2.2,2.3]);
});
test("confirmed rises and falls remain visible while sharp returns are masked",()=>{
  const ctx=harness();
  for(const values of [[2.55,3.5,3.61,3.63],[3.63,2.55,2.61,2.6],[2.55,3.5,4.45,5.4]]){
    assert.deepEqual(Array.from(ctx.filterSpikes15Min(values)),values);
  }
  assert.deepEqual(Array.from(ctx.filterSpikes15Min([2.55,5.5,3.51,3.61])),[2.55,null,3.51,3.61]);
});
test("invalid observation bins remain missing and cannot anchor the next finite reading",()=>{
  const ctx=harness();
  for(const missing of [null,undefined,NaN,Infinity,-Infinity,"",false,"3.2",{},[]]){
    assert.deepEqual(Array.from(ctx.filterSpikes15Min([1,missing,3,3.1])),[1,null,3,3.1]);
  }
  assert.deepEqual(Array.from(ctx.filterSpikes15Min([null,0,.1])),[null,0,.1]);
});
test("the 0.75-foot limit is inclusive without accepting real excess change or mutating inputs",()=>{
  const ctx=harness(),input=[.1,.8500000000000001],before=input.slice();
  assert.deepEqual(Array.from(ctx.filterSpikes15Min(input)),input);
  assert.deepEqual(input,before);
  assert.deepEqual(Array.from(ctx.filterSpikes15Min([.1,.8500000001])),[.1,null]);
  assert.deepEqual(Array.from(ctx.filterSpikes15Min([])),[]);
});
test("actual chart sampling preserves flooding observations after a 75-minute gap",()=>{
  const ctx=harness();
  for(const name of ["nearbyThresholdsForRange","interpolateForecastLevels","buildTimeseriesSamples",
    "tsObservedDataset","tsPredictedDataset","updateTsChartFromState"])vm.runInContext(source(name),ctx);
  const readings=[["16:00",3.2],["17:15",4],["17:30",4.1],["17:45",4.2],["18:00",4.3],["18:15",4.4],["18:30",4.5]]
    .map(([time,ft])=>({t:`2026-11-03T${time}:00Z`,ft}));
  ctx.STATE={obs24Navd:readings,pred72Mllw:[],obs24CachedHighs:false};
  ctx.tsChart={data:{},options:{scales:{x:{title:{}},y:{title:{},ticks:{}}}},update(){}};
  for(const name of ["ensureTsChart","styleTsLegendAsLines","applyTsDateAxis","syncChartZoomToData","stabilizeTsChartLayout"])ctx[name]=()=>{};
  ctx.unitText=()=>"ft NAVD88";ctx.thresholdsDisplay=()=>({minor:3.44,moderate:4.44,major:5.44});
  ctx.updateTsChartFromState(Date.parse("2026-11-03T19:00:00Z"));
  const index=new Map(ctx.tsChart.data.labels.map((t,i)=>[t,i]));
  for(const p of readings){
    assert.equal(ctx.tsChart.data.datasets[0].data[index.get(Date.parse(p.t))],p.ft);
  }
  assert.equal(ctx.tsChart.data.datasets[0].data[index.get(Date.parse("2026-11-03T16:37:30Z"))],null);
});

test("the flood-stage overlay respects hidden time-series datasets after refresh",()=>{
  const declaration="const tsFloodLineOverlayPlugin = ";
  const begin=html.indexOf(declaration)+declaration.length;
  const end=html.indexOf("\n};",begin)+2;
  const plugin=vm.runInNewContext("("+html.slice(begin,end)+")",{THRESH,DISPLAY_DATUM:"MLLW"});
  let visible=false, draws=0;
  const noop=()=>{};
  const chart={
    canvas:{id:"tsChart"},
    ctx:{save:noop,beginPath:noop,rect:noop,clip:noop,restore:noop},
    chartArea:{left:0,right:100,top:0,bottom:100},
    scales:{y:{getPixelForValue:ft=>100-ft*10}},
    data:{datasets:[{label:"Observed",hidden:true}]},
    isDatasetVisible:()=>visible,
    getDatasetMeta:()=>({hidden:null,dataset:{options:{},draw:()=>draws++}})
  };
  plugin.afterDatasetsDraw(chart);
  assert.equal(draws,0);
  visible=true;
  chart.data.datasets[0].hidden=false;
  plugin.afterDatasetsDraw(chart);
  assert.equal(draws,3);
});

test("identity datum conversion preserves finite values and their full sensor precision",()=>{
  const ctx=harness();
  for(const datum of Object.keys(OFFSET_FROM_MLLW)){
    for(const value of [0,-0,3.44,4.44,5.44,Math.PI,3.4400000001,-9.8765432109,1e-10]){
      assert.equal(ctx.datumToDatum(value,datum,datum),value);
    }
  }
});
for(const datum of Object.keys(OFFSET_FROM_MLLW)){
  test(`${datum}: configured physical thresholds retain their category and color`,()=>{
    const ctx=harness();ctx.DISPLAY_DATUM=datum;
    for(const [kind,stage]of [["minorLow","Minor"],["moderateLow","Moderate"],["majorLow","Major"]]){
      const converted=ctx.toDisplayFtFromMllw(THRESH.MLLW[kind]);
      assert.equal(ctx.stageNameFromDisplayFt(converted),stage);
      assert.equal(ctx.colorForFtDisplay(converted),ctx.colorForFtDisplay(THRESH[datum][kind]));
      assert.equal(ctx.classifyByNavd(ctx.fromDisplayToNavd(THRESH[datum][kind])).short,stage);
    }
  });
  test(`${datum}: actual exact-threshold historic records survive inclusive min and max filters`,()=>{
    const ctx=harness();ctx.DISPLAY_DATUM=datum;
    const expected=cache.events.filter(e=>e.ft===THRESH.NAVD88.minorLow);
    assert(expected.length>0,"The retained archive must contain exact configured boundary records");
    const exact=filter(ctx,THRESH[datum].minorLow,THRESH[datum].minorLow);
    assert.equal(exact.length,expected.length);
    assert.deepEqual(exact.map(e=>e.cycleId).sort(),expected.map(e=>e.cycleId).sort());
    assert.equal(filter(ctx,THRESH[datum].minorLow).length,cache.events.filter(e=>e.ft>=THRESH.NAVD88.minorLow).length);
    assert.equal(filter(ctx,"",THRESH[datum].minorLow).length,cache.events.filter(e=>e.ft<=THRESH.NAVD88.minorLow).length);
    assert.equal(filter(ctx).length,cache.events.length);
  });
  test(`${datum}: genuinely off-boundary levels are not rounded into flooding or an exact range`,()=>{
    const ctx=harness();ctx.DISPLAY_DATUM=datum;
    for(const [kind,stageBelow,stageAt]of [["minorLow","Below","Minor"],["moderateLow","Minor","Moderate"],["majorLow","Moderate","Major"]]){
      const navd=THRESH.NAVD88[kind];
      assert.equal(ctx.stageNameFromDisplayFt(ctx.toDisplayFtFromNavd(navd-1e-10)),stageBelow);
      assert.equal(ctx.stageNameFromDisplayFt(ctx.toDisplayFtFromNavd(navd+1e-10)),stageAt);
    }
    const point=(id,ft)=>({cycleId:id,ft,t:"2026-01-01T12:00:00Z",localDate:"2026-01-01",kind:"HighTide"});
    const events=[point("below",3.44-1e-10),point("at",3.44),point("above",3.44+1e-10),point("invalid",NaN)];
    assert.deepEqual(filter(ctx,THRESH[datum].minorLow,THRESH[datum].minorLow,events).map(e=>e.cycleId),["at"]);
  });
  test(`${datum}: physical plateau and crossing durations do not change with display datum`,()=>{
    const ctx=harness();ctx.DISPLAY_DATUM=datum;
    for(const [kind,key,stage]of [["minorLow","minorMs","Minor"],["moderateLow","moderateMs","Moderate"],["majorLow","majorMs","Major"]]){
      const level=THRESH.MLLW[kind],actual=account(ctx,[level,level,level]);
      assert.equal(actual.coveredMs,7200000);assert.equal(actual[key],7200000);
      assert.equal(actual.segments.length,1);assert.equal(actual.segments[0].peakStage,stage);
    }
    const ramp=ctx.buildExactFloodAccounting([
      {ms:0,ftDisplay:ctx.toDisplayFtFromMllw(5.6)},
      {ms:10800000,ftDisplay:ctx.toDisplayFtFromMllw(8.6)}
    ],0,10800000);
    assert(Math.abs(ramp.minorMs-3600000)<1e-5);
    assert(Math.abs(ramp.moderateMs-3600000)<1e-5);
    assert(Math.abs(ramp.majorMs-1800000)<1e-5);
    assert.equal(ramp.coveredMs,10800000);
  });
  test(`${datum}: an exact threshold peak is classified without inventing positive-duration hours`,()=>{
    const ctx=harness();ctx.DISPLAY_DATUM=datum;
    for(const values of [[7.1,8.1,7.1],[7.1,8.1],[8.1,7.1]]){
      const actual=account(ctx,values);
      assert.equal(actual.segments.length,1);assert.equal(actual.segments[0].peakStage,"Major");
      assert.equal(actual.majorMs,0);
      assert.equal(actual.moderateMs,(values.length-1)*3600000);
      assert(actual.pieces.every(p=>p.endMs>p.startMs));
    }
    const touchOnly=account(ctx,[5.1,6.1,5.1]);
    assert.equal(touchOnly.segments.length,0);
    assert.equal(touchOnly.minorMs+touchOnly.moderateMs+touchOnly.majorMs,0);
  });
}
test("missing or nonfinite values do not become flood classifications or finite historic rows",()=>{
  const ctx=harness();
  for(const datum of Object.keys(OFFSET_FROM_MLLW)){
    ctx.DISPLAY_DATUM=datum;
    for(const value of [NaN,Infinity,-Infinity,undefined,null]){
      assert.equal(ctx.stageNameFromDisplayFt(value),"Below");
      assert.equal(ctx.classifyByNavd(value).short,"Below");
    }
  }
  const actual=ctx.buildExactFloodAccounting([{ms:0,ftDisplay:NaN},{ms:3600000,ftDisplay:Infinity}],0,3600000);
  assert.equal(actual.coveredMs,0);assert.deepEqual(plain(actual.segments),[]);
});
