import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHarness,sourceSha256,writeReport} from './dashboard-browser-harness.mjs';

const record={sourceSha256,mode:'Actual app, retained history and pinned vendors; controlled provider responses, native inputs and read-only result inspection in fresh isolated headless browsers.',checks:[],errors:[]};
const valid={time:'2026-11-03T21:30:00Z',value:3.5};
const unavailable={status:503,body:{error:'Controlled unavailable feed'}};
function modern(rows){return {body:{type:'FeatureCollection',features:rows.map(row=>({type:'Feature',geometry:null,properties:{monitoring_location_id:'USGS-01411360',parameter_code:'72279',unit_of_measure:'ft',...row}}))}};}
function legacy(rows){return {body:{value:{timeSeries:[{sourceInfo:{siteCode:[{value:'01411360'}]},variable:{variableCode:[{value:'72279'}],unit:{unitCode:'ft'}},values:[{value:rows.map(row=>({dateTime:row.time,value:row.value}))}]}]}}};}
function feeds(rows,{legacyRows}={}){return ({url})=>url.startsWith('https://api.waterdata.usgs.gov/')?modern(rows):url.startsWith('https://waterservices.usgs.gov/')&&legacyRows?legacy(legacyRows):undefined;}
async function run(name,options,fn){
  if(process.env.DASHBOARD_OBSERVATION_TEST_FILTER&&!new RegExp(process.env.DASHBOARD_OBSERVATION_TEST_FILTER).test(name))return;
  let h;const row={name};
  try{
    h=await createHarness(options);await h.ready();row.observations=await fn(h);
    assert.deepEqual(h.errors,[]);row.passed=true;
  }catch(e){row.passed=false;row.failure=e.stack||String(e);}
  finally{if(h){record.browser=h.browser.version();record.engine=h.engineName;record.errors.push(...h.errors);await h.close();}}
  record.checks.push(row);console.log(`${row.passed?'PASS':'FAIL'} ${name}`);if(!row.passed)console.log(row.failure);
}
async function liveState(p){return p.evaluate(()=>({last:STATE.lastNavd,cached:!!STATE.lastObservationIsCachedHighTide,current:document.getElementById('curFt').textContent,stage:document.getElementById('stageText').textContent,today:STATE.todayNavd.map(p=>p.ft)}));}

await run('missing modern readings do not replace the latest valid water level with zero',{
  externalResponse:feeds([valid,{time:'2026-11-03T21:45:00Z',value:null}])
},async({page:p})=>{
  await p.waitForFunction(()=>STATE.lastNavd);await p.locator('#datumSelect').selectOption('NAVD88');
  const result=await liveState(p);assert.equal(result.last.ft,3.5);assert.equal(result.last.t,valid.time);
  assert.equal(result.current,'3.50');assert.match(result.stage,/MINOR/);assert.equal(result.cached,false);
  assert.deepEqual(result.today,[3.5]);return result;
});
await run('a genuine modern zero remains a valid observation',{
  externalResponse:feeds([valid,{time:'2026-11-03T21:45:00Z',value:0}])
},async({page:p})=>{
  await p.waitForFunction(()=>STATE.lastNavd);await p.locator('#datumSelect').selectOption('NAVD88');
  const result=await liveState(p);assert.equal(result.last.ft,0);assert.equal(result.current,'0.00');
  assert.equal(result.stage,'NO FLOODING');assert.equal(result.cached,false);return result;
});
await run('all-missing modern readings use valid legacy measurements',{
  externalResponse:feeds([{time:'2026-11-03T21:45:00Z',value:null}],{legacyRows:[{time:'2026-11-03T21:40:00Z',value:'4.0'}]})
},async({page:p})=>{
  await p.waitForFunction(()=>STATE.lastNavd);await p.locator('#datumSelect').selectOption('NAVD88');
  const result=await liveState(p);assert.equal(result.last.ft,4);assert.equal(result.current,'4.00');
  assert.equal(result.cached,false);assert.match(result.stage,/MINOR/);return result;
});
await run('missing modern and unavailable legacy feeds retain the explicit cached-high warning',{
  externalResponse:feeds([{time:'2026-11-03T21:45:00Z',value:null}])
},async({page:p})=>{
  await p.waitForFunction(()=>STATE.lastNavd);const result=await liveState(p);
  assert.equal(result.cached,true);assert.match(result.stage,/CACHED HIGH/);
  assert.match(await p.locator('#lastPill').textContent(),/feed unavailable/);return result;
});

const gap=[{time:'2026-11-03T16:00:00Z',value:3.2},
  ...[4,4.1,4.2,4.3,4.4,4.5].map((value,i)=>({time:new Date(Date.parse('2026-11-03T17:15:00Z')+i*900000).toISOString(),value}))];
await run('the real observed chart retains valid flood readings after a 75-minute gap',{
  externalResponse:feeds(gap)
},async({page:p})=>{
  await p.waitForFunction(()=>STATE.obs24Navd.length===7&&tsChart?.data.datasets[0]?.data.length);
  await p.locator('#datumSelect').selectOption('NAVD88');
  const values=await p.evaluate(rows=>rows.map(row=>{
    const i=tsChart.data.labels.findIndex(t=>Date.parse(t)===Date.parse(row.time));
    return {time:row.time,expected:row.value,displayed:i<0?undefined:tsChart.data.datasets[0].data[i]};
  }),gap);
  assert.equal(values.length,7);for(const v of values){assert.notEqual(v.displayed,null);assert.ok(Math.abs(v.displayed-v.expected)<1e-10,JSON.stringify(v));}
  return values;
});

const cache=JSON.parse(fs.readFileSync(new URL('../data/peaks_navd88.json',import.meta.url),'utf8'));
const exactMatches=cache.events.filter(row=>row.ft===3.44).length;
assert.ok(exactMatches>0&&exactMatches<=50);
await run('an inclusive exact 3.44 NAVD88 filter returns every actual matching tide',{},async({page:p})=>{
  await p.locator('#datumSelect').selectOption('NAVD88');
  for(const id of ['fromDate','toDate'])await p.locator('#'+id).fill('');
  await p.locator('#minElev').fill('3.44');await p.locator('#maxElev').fill('3.44');
  await p.locator('#histLimit').selectOption('50');await p.locator('#applyBtn').click();
  const rows=await p.locator('#histBody tr').allTextContents();assert.equal(rows.length,exactMatches);
  assert.ok(rows.every(r=>r.includes('3.44')));return {expected:exactMatches,actual:rows.length};
});

for(const [name,height,target]of [['Minor',6.1,'f48MinorHrs'],['Moderate',7.1,'f48ModerHrs'],['Major',8.1,'f48MajorHrs']]){
  const points=Array.from({length:97},(_,i)=>({t:new Date(Date.parse('2026-11-03T21:00:00Z')+i*3600000).toISOString(),source_twl_mean:height,twl:height}));
  await run(`${name} threshold forecast keeps the same 72 flood hours in every datum`,{
    responseForRequest:({url})=>new URL(url).pathname.endsWith('/data/petss_forecast.json')?{body:{points}}:undefined
  },async({page:p})=>{
    await p.waitForFunction(()=>STATE.pred72Mllw.length===97&&document.getElementById('f48MinorHrs').textContent!=='—');
    const results=[];
    for(const datum of ['MLLW','NAVD88','MSL','MHHW']){
      await p.locator('#datumSelect').selectOption(datum);
      const values=await p.evaluate(()=>Object.fromEntries(['f48MinorHrs','f48ModerHrs','f48MajorHrs'].map(id=>[id,document.getElementById(id).textContent])));
      assert.equal(values[target],'72.0');for(const id of Object.keys(values))if(id!==target)assert.equal(values[id],'0.0');
      assert.match(await p.locator('#f48List').textContent(),new RegExp(name));results.push({datum,...values});
    }
    return results;
  });
}

const forecastStart=Date.parse('2026-11-03T22:00:00Z');
const partialForecast=Array.from({length:97},(_,i)=>i>1&&i<10?null:{
  t:new Date(forecastStart+i*3600000).toISOString(),source_twl_mean:i===10?8.5:5,twl:i===10?8.5:5
}).filter(Boolean);
await run('a supplied forecast peak survives a long gap in every datum',{
  responseForRequest:({url})=>new URL(url).pathname.endsWith('/data/petss_forecast.json')?{body:partialForecast}:undefined,
  externalResponse:feeds([valid])
},async({page:p})=>{
  await p.waitForFunction(n=>STATE.pred72Mllw?.length===n&&tsChart?.data.datasets.some(d=>d.label==='Forecast'),partialForecast.length);
  const results=[];
  for(const [datum,offset]of Object.entries({MLLW:0,NAVD88:-2.66,MSL:-2.31,MHHW:-4.74})){
    await p.locator('#datumSelect').selectOption(datum);
    const result=await p.evaluate(time=>{
      const series=tsChart.data.datasets.find(d=>d.label==='Forecast');
      const i=tsChart.data.labels.findIndex(t=>Date.parse(t)===time);
      return {peak:series.data[i],before:series.data[i-1],after:series.data[i+1],maximum:Math.max(...series.data.filter(Number.isFinite)),spanGaps:series.spanGaps,majorHours:document.getElementById('f48MajorHrs').textContent,details:document.getElementById('f48List').textContent};
    },forecastStart+10*3600000);
    assert.ok(Math.abs(result.peak-(8.5+offset))<1e-10);
    assert.ok(Math.abs(result.maximum-(8.5+offset))<1e-10);
    assert.equal(result.before,null);assert.ok(Math.abs(result.after-(7.625+offset))<1e-10);
    assert.equal(result.spanGaps,false);
    assert.equal(result.majorHours,'0.1');assert.match(result.details,/Major/);
    results.push({datum,...result});
  }
  return results;
});
const isolatedForecast=Array.from({length:97},(_,i)=>(i>1&&i<10)||(i>10&&i<20)?null:{
  t:new Date(forecastStart+i*3600000).toISOString(),source_twl_mean:i===10?8.5:5,twl:i===10?8.5:5
}).filter(Boolean);
await run('a known forecast peak between two gaps is visibly marked and can be inspected',{
  responseForRequest:({url})=>new URL(url).pathname.endsWith('/data/petss_forecast.json')?{body:isolatedForecast}:undefined,
  externalResponse:feeds([valid])
},async({page:p})=>{
  await p.waitForFunction(n=>STATE.pred72Mllw?.length===n&&tsChart?.data.datasets.some(d=>d.label==='Forecast'),isolatedForecast.length);
  const result=await p.evaluate(time=>{
    const index=tsChart.data.labels.findIndex(t=>Date.parse(t)===time),dataset=tsChart.data.datasets.findIndex(d=>d.label==='Forecast');
    const series=tsChart.data.datasets[dataset],point=tsChart.getDatasetMeta(dataset).data[index];
    return{value:series.data[index],before:series.data[index-1],after:series.data[index+1],radius:point.options.radius,skip:point.skip,spanGaps:series.spanGaps,index};
  },forecastStart+10*3600000);
  assert.equal(result.value,8.5);assert.equal(result.before,null);assert.equal(result.after,null);
  assert.ok(result.radius>0);assert.equal(result.skip,false);assert.equal(result.spanGaps,false);
  await p.locator('#tsChart').scrollIntoViewIfNeeded();
  const location=await p.evaluate(index=>{
    const dataset=tsChart.data.datasets.findIndex(d=>d.label==='Forecast'),point=tsChart.getDatasetMeta(dataset).data[index],rect=tsChart.canvas.getBoundingClientRect();
    return{x:rect.left+point.x,y:rect.top+point.y};
  },result.index);
  await p.mouse.move(location.x,location.y);
  await p.waitForFunction(()=>tsChart.tooltip?.dataPoints?.some(p=>p.dataset.label==='Forecast'&&p.parsed.y===8.5));
  return{...result,inspectable:true};
});
writeReport(record);
if(record.errors.length||record.checks.some(c=>!c.passed))process.exitCode=1;
