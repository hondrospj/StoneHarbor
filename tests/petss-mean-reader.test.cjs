"use strict";
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,fs.existsSync(path.join(root,'site/flooddashboard/index.html'))?'site/flooddashboard/index.html':'index.html'),'utf8');
const normalizer=html.match(/function normalizePetssJsonToPoints\([^)]*\)\s*\{[\s\S]*?\n\}/);
if(normalizer){
 const read=vm.runInNewContext('('+normalizer[0]+')');
 const time='2026-10-17T12:00:00Z';
 test('the actual dashboard reader selects the issued mean when both percentiles disagree',()=>{
  for(const wrap of [r=>r,r=>({points:r}),r=>({data:r})]){
   const points=read(wrap([{t:time,source_twl_mean:3.125,twl:99,source_twl90p:1.1,source_twl10p:5.9}]));
   assert.equal(points.length,1);assert.equal(points[0].ft,3.125);
  }
 });
 test('zero, negative and mean-only TWL survive; percentiles are never substituted',()=>{
  assert.equal(read([{t:time,source_twl_mean:0,twl:3}])[0].ft,0);
  assert.equal(read([{t:time,source_twl_mean:-1.23}])[0].ft,-1.23);
  assert.equal(read([{t:time,twl:3.125}])[0].ft,3.125);
  assert.equal(read([{t:time,source_twl90p:1.1,source_twl10p:5.9}]).length,0);
 });
 test('malformed or missing mean values cannot turn into false zero forecasts',()=>{
  for(const v of ['',true,false,9999,-400,'bad'])assert.equal(read([{t:time,source_twl_mean:v}]).length,0);
  assert.equal(read([{t:'invalid',source_twl_mean:3}]).length,0);
 });
 if(html.includes('ForecastPeakAnchors.apply')||html.includes('STATE.forecastPeakAnchors')){
  test('the real forecast loading path retains issued means on former custom peak dates',async()=>{
   const update=html.match(/async function updateTimeseries\(\)\s*\{[\s\S]*?\n\}/);assert.ok(update);
   const points=[{t:'2026-09-25T12:00:00Z',ft:3.125},{t:'2026-09-26T12:00:00Z',ft:4.25}];
   const state={},context={STATE:state,Date,console,fetchObservedSeries:async()=>[],fetchPETSSForecast_MLLW:async()=>({points}),updateTsChartFromState(){},updateFloodOutlook48(){},ForecastPeakAnchors:{apply(){throw Error('Issued mean cannot be replaced by a local peak');}}};
   await vm.runInNewContext('('+update[0]+')',context)();
   assert.equal(state.pred72Mllw,points);assert.equal(state.pred72MllwRaw,points);assert.equal(state.forecastPeakAnchors.length,0);
  });
 }
}else{
 const native=html.match(/function getStageValue\(entry\)\s*\{[\s\S]*?\n    \}/);assert.ok(native,'Known forecast reader is required');
 const read=vm.runInNewContext('('+native[0]+')',{getRawStageValue:r=>r.navd88StageFt,normalizeStageValue:n=>n-.09});
 test('issued TWL is displayed with only its existing datum conversion and no local observation shift',()=>{
  assert.equal(read({sourceColumn:'TWL',navd88StageFt:1.25}),1.25);
  assert.equal(read({sourceColumn:'TWL90p',navd88StageFt:1.25}),1.25);
  assert.equal(read({navd88StageFt:1.25}),1.16);
 });
}
