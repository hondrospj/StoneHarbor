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
    h=await createHarness(options);
    if(!options.skipReady) await h.ready();
    row.observations=await fn(h);
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

let liveReadingAvailable = false;
await run('the reading card distinguishes cached and retained levels from a recovered live level',{
  externalResponse:args=>liveReadingAvailable ? feeds([valid])(args) : undefined
},async({page:p})=>{
  const label=p.locator('.curLabel'), time=p.locator('#curMeta');
  assert.equal(await label.textContent(),'Latest cached high tide');
  assert.ok(await time.isVisible());
  assert.match(await time.textContent(),/ ET$/);

  liveReadingAvailable=true;
  await p.evaluate(()=>updateLiveConditions());
  assert.equal(await label.textContent(),'Current water elevation');
  assert.equal(await time.isVisible(),false);

  liveReadingAvailable=false;
  await p.evaluate(()=>updateLiveConditions());
  assert.equal(await label.textContent(),'Last water elevation');
  assert.ok(await time.isVisible());
  assert.equal((await liveState(p)).last.t,valid.time);
});

const gap=[{time:'2026-11-03T16:00:00Z',value:3.2},
  ...[4,4.1,4.2,4.3,4.4,4.5].map((value,i)=>({time:new Date(Date.parse('2026-11-03T17:15:00Z')+i*900000).toISOString(),value}))];
await run('the real observed chart retains valid flood readings after a 75-minute gap',{
  externalResponse:feeds(gap)
},async({page:p})=>{
  await p.waitForFunction(()=>STATE.obs24Navd?.length===7&&tsChart?.data.datasets[0]?.data.length);
  await p.locator('#datumSelect').selectOption('NAVD88');
  const values=await p.evaluate(rows=>rows.map(row=>{
    const i=tsChart.data.labels.indexOf(Date.parse(row.time));
    return {time:row.time,expected:row.value,displayed:i<0?undefined:tsChart.data.datasets[0].data[i]};
  }),gap);
  assert.equal(values.length,7);for(const v of values){assert.notEqual(v.displayed,null);assert.ok(Math.abs(v.displayed-v.expected)<1e-10,JSON.stringify(v));}
  return values;
});

const separatedObservations=[
  {time:'2026-11-03T16:00:00Z',value:3.5},
  {time:'2026-11-03T16:45:00Z',value:3.6},
  {time:'2026-11-03T17:30:00Z',value:3.4},
  {time:'2026-11-03T18:15:00Z',value:2.6},
  {time:'2026-11-03T18:30:00Z',value:2.7}
];
await run('isolated observations are marked and inspectable while continuous observations remain a line',{
  externalResponse:feeds(separatedObservations)
},async({page:p})=>{
  await p.waitForFunction(count=>STATE.obs24Navd?.length===count&&tsChart?.data.datasets[0]?.data.length,separatedObservations.length);
  await p.locator('#datumSelect').selectOption('NAVD88');
  const results=await p.evaluate(rows=>{
    const dataset=tsChart.data.datasets[0], metadata=tsChart.getDatasetMeta(0);
    return rows.map(row=>{
      const index=tsChart.data.labels.indexOf(Date.parse(row.time));
      const point=metadata.data[index];
      return {index,value:dataset.data[index],radius:point.options.radius,skipped:point.skip};
    });
  },separatedObservations);
  assert.deepEqual(results.map(row=>row.value),separatedObservations.map(row=>row.value));
  assert.ok(results.every(row=>!row.skipped));
  assert.ok(results.slice(0,3).every(row=>row.radius>0));
  assert.ok(results.slice(3).every(row=>row.radius===0));
  await p.locator('#tsChart').scrollIntoViewIfNeeded();
  const location=await p.evaluate(index=>{
    const point=tsChart.getDatasetMeta(0).data[index], rect=tsChart.canvas.getBoundingClientRect();
    return {x:rect.left+point.x,y:rect.top+point.y};
  },results[1].index);
  await p.mouse.move(location.x,location.y);
  await p.waitForFunction(()=>tsChart.tooltip?.dataPoints?.some(row=>row.dataset.label==='Observed'&&row.parsed.y===3.6));
  return {results,inspectable:true};
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
    responseForRequest:forecastFixture(points)
  },async({page:p})=>{
    await p.waitForFunction(()=>STATE.pred72Mllw?.length===97&&document.getElementById('f48MinorHrs').textContent!=='—');
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
function forecastFixture(points,issuedTime='2026-11-03T18:00:00Z'){
  return ({url})=>new URL(url).pathname.endsWith('/data/petss_forecast.json')
    ? {body:{points,model_time_utc:issuedTime,stid:'8535581',datum:'MLLW'}}
    : undefined;
}

await run('flood outlook shows the end of a midnight window and incomplete coverage at smaller widths',{
  now:'2026-11-04T03:00:00Z',
  viewport:{width:900,height:800},
  responseForRequest:forecastFixture([9,9,9,5].map((ft,index)=>({
    t:new Date(Date.parse('2026-11-04T03:00:00Z')+index*3600000).toISOString(),
    source_twl_mean:ft,twl:ft
  })))
},async({page:p})=>{
  await p.waitForFunction(()=>STATE.pred72Mllw?.length===4);
  const when=p.locator('#f48List .eventWhen').first();
  const note=p.locator('#f48List .eventSub').last();
  assert.match(await when.textContent(),/November 3rd.*November 4th/);
  assert.match(await note.textContent(),/remaining hours are unknown/);
  for(const width of [900,1440,390]){
    await p.setViewportSize({width,height:800});
    for(const text of [when,note]){
      const {client,scroll}=await text.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));
      assert.ok(client>=scroll,`Flood outlook clips text on a ${width}px viewport (${client}px of ${scroll}px visible)`);
    }
  }
});

let releaseHistory;
const historyGate=new Promise(resolve=>{releaseHistory=resolve;});
const earlyForecast=forecastFixture([
  {t:'2026-11-03T22:00:00Z',twl:7.2},
  {t:'2026-11-03T23:00:00Z',twl:7.2}
]);
await run('observations and forecast can load while the initial tide history is pending',{
  skipReady:true,
  async responseForRequest(request){
    if(new URL(request.url).pathname.endsWith('/data/peaks_navd88.json')) await historyGate;
    return earlyForecast(request);
  },
  externalResponse:feeds([valid])
},async(h)=>{
  try{
    await h.page.waitForFunction(()=>STATE.lastNavd?.ft===3.5 && STATE.pred72Mllw?.length===2);
    assert.match(await h.page.locator('#f48List').textContent(), /Moderate/);
    assert.equal(await h.page.locator('#doyYearTable button').count(),0);
  }finally{
    releaseHistory();
  }
  await h.ready();
  return {liveAndForecastBeforeHistory:true};
});

await run('the time axis preserves two nearby readings and charts the flood before the next whole hour',{
  now:'2026-11-03T21:15:00Z',
  responseForRequest:forecastFixture([
    {t:'2026-11-03T21:00:00Z',twl:8.4},
    {t:'2026-11-03T22:00:00Z',twl:4},
    {t:'2026-11-03T23:00:00Z',twl:3}
  ]),
  externalResponse:feeds([
    {time:'2026-11-03T21:06:00Z',value:3.2},
    {time:'2026-11-03T21:12:00Z',value:3.3}
  ])
},async({page:p})=>{
  await p.waitForFunction(()=>STATE.obs24Navd?.length===2&&STATE.pred72Mllw?.length===3);
  const result=await p.evaluate(()=>{
    const labels=tsChart.data.labels;
    const observed=tsChart.data.datasets.find(ds=>ds.label==='Observed').data;
    const forecast=tsChart.data.datasets.find(ds=>ds.label==='Forecast').data;
    const x=tsChart.scales.x;
    const first=Date.parse('2026-11-03T21:06:00Z'),second=Date.parse('2026-11-03T21:12:00Z');
    const pixelDistance=(start,end)=>x.getPixelForValue(end)-x.getPixelForValue(start);
    const forecastIndex=forecast.findIndex(Number.isFinite);
    return {
      first:observed[labels.indexOf(first)], second:observed[labels.indexOf(second)],
      ratio:pixelDistance(first,second)/pixelDistance(first,first+3600000),
      forecastStart:labels[forecastIndex], forecastHeight:forecast[forecastIndex],
      forecastEnd:labels.at(-1), outlook:document.getElementById('f48List').textContent
    };
  });
  assert.equal(result.first, 3.2+2.66);
  assert.equal(result.second, 3.3+2.66);
  assert.ok(Math.abs(result.ratio-.1)<1e-10);
  assert.ok(result.forecastStart>=Date.parse('2026-11-03T21:15:00Z'));
  assert.ok(result.forecastStart<Date.parse('2026-11-03T22:00:00Z'));
  assert.ok(result.forecastHeight>7.1);
  assert.equal(result.forecastEnd-result.forecastStart,72*3600000);
  assert.match(result.outlook,/Moderate/);
  const zoom = await p.evaluate(()=>{
    const {min,max,unit}=getChartZoomRange(tsChart);
    setChartZoomRange(tsChart,min+4,max-8);
    const cropped=[tsChart.scales.x.min,tsChart.scales.x.max];
    const zoomed=isChartZoomed(tsChart);
    resetChartZoom(tsChart);
    return {cropped,expected:[(min+4)*unit,(max-8)*unit],zoomed,reset:!isChartZoomed(tsChart)};
  });
  assert.deepEqual(zoom.cropped,zoom.expected);
  assert.equal(zoom.zoomed,true);
  assert.equal(zoom.reset,true);
  return result;
});

let failed=false;
const beforeFeedFailure=feeds([{time:'2026-11-03T21:54:00Z',value:2.15}]);
await run('a failed periodic observation refresh withdraws an old all-clear',{
  clock:true,
  externalResponse:request=>failed ? unavailable : beforeFeedFailure(request)
},async({page:p})=>{
  await p.waitForFunction(()=>STATE.lastNavd && !STATE.liveObservationError);
  assert.equal((await liveState(p)).stage,'NO FLOODING');
  failed=true;
  await p.clock.fastForward(7*3600000);
  await p.waitForFunction(()=>STATE.liveObservationError);
  assert.equal((await liveState(p)).stage,'LIVE DATA STALE');
  assert.match(await p.locator('#lastPill').textContent(),/Last USGS reading/);
  return liveState(p);
});

const rapidRise=[2.55,3.50,3.61,3.63].map((value,index)=>({
  time:`2026-11-03T21:${String(index*15).padStart(2,'0')}:00Z`,value
}));
await run('a sustained rise keeps real flood readings and draws straight observed segments',{
  externalResponse:feeds(rapidRise)
},async({page:p})=>{
  await p.waitForFunction(()=>STATE.obs24Navd?.length===4);
  await p.locator('#datumSelect').selectOption('NAVD88');
  const result=await p.evaluate(rows=>{
    const {labels,datasets}=tsChart.data;
    return {
      values:rows.map(row=>datasets[0].data[labels.indexOf(Date.parse(row.time))]),
      tension:datasets[0].tension,
      stage:document.getElementById('stageText').textContent
    };
  },rapidRise);
  assert.deepEqual(result.values,rapidRise.map(row=>row.value));
  assert.equal(result.tension,0);
  assert.equal(result.stage,'MINOR FLOODING');
  return result;
});

let refreshRevision=0;
const initialIssue='2026-11-03T18:00:00Z';
const refreshForecast=(ft,issue)=>forecastFixture([
  {t:'2026-11-03T22:00:00Z',twl:ft},{t:'2026-11-03T23:00:00Z',twl:ft}
],issue);
const refreshForecasts=[refreshForecast(7.5,initialIssue),refreshForecast(5,'2026-11-03T12:00:00Z'),refreshForecast(7.6,initialIssue)];
const refreshFeeds=[feeds(rapidRise),feeds([rapidRise[0]]),feeds([...rapidRise,{time:'2026-11-03T21:54:00Z',value:3.7}])];
await run('periodic refresh keeps newer observations, newer guidance and the Observed legend choice',{
  clock:true,
  responseForRequest:request=>refreshForecasts[refreshRevision](request),
  externalResponse:request=>refreshFeeds[refreshRevision](request)
},async({page:p})=>{
  await p.waitForFunction(()=>STATE.lastNavd?.ft===3.63&&STATE.obs24Navd?.length===4&&STATE.pred72Mllw?.length===2);
  const observed=p.locator('#shorelyLegend-tsChart').getByRole('button',{name:'Observed',exact:true});
  await observed.click();
  await p.waitForFunction(()=>!tsChart.isDatasetVisible(0));

  refreshRevision=1;
  await p.clock.fastForward(5*60000);
  await p.waitForFunction(()=>STATE.liveObservationError&&!pendingRefreshes.size);
  const retained=await p.evaluate(()=>({
    observation:STATE.lastNavd.ft, latestChartTime:STATE.obs24Navd.at(-1).t,
    issue:STATE.petssIssuedTime, forecast:STATE.pred72Mllw[0].ft,
    observedVisible:tsChart.isDatasetVisible(0)
  }));
  assert.deepEqual(retained,{observation:3.63,latestChartTime:rapidRise.at(-1).time,issue:'2026-11-03T18:00:00.000Z',forecast:7.5,observedVisible:false});
  assert.equal(await observed.getAttribute('aria-pressed'),'false');

  refreshRevision=2;
  await p.clock.fastForward(5*60000);
  await p.waitForFunction(()=>!STATE.liveObservationError&&STATE.lastNavd?.ft===3.7&&STATE.pred72Mllw?.[0]?.ft===7.6&&!pendingRefreshes.size);
  assert.equal(await observed.getAttribute('aria-pressed'),'false');
  return {...retained,acceptedFreshObservationAndRevisedForecast:true};
});

const partialForecast=Array.from({length:97},(_,i)=>i>1&&i<10?null:{
  t:new Date(forecastStart+i*3600000).toISOString(),source_twl_mean:i===10?8.5:5,twl:i===10?8.5:5
}).filter(Boolean);
await run('a supplied forecast peak survives a long gap in every datum',{
  responseForRequest:forecastFixture(partialForecast),
  externalResponse:feeds([valid])
},async({page:p})=>{
  await p.waitForFunction(n=>STATE.pred72Mllw?.length===n&&tsChart?.data.datasets.some(d=>d.label==='Forecast'),partialForecast.length);
  const results=[];
  for(const [datum,offset]of Object.entries({MLLW:0,NAVD88:-2.66,MSL:-2.31,MHHW:-4.74})){
    await p.locator('#datumSelect').selectOption(datum);
    const result=await p.evaluate(time=>{
      const series=tsChart.data.datasets.find(d=>d.label==='Forecast');
      const i=tsChart.data.labels.indexOf(time);
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
  responseForRequest:forecastFixture(isolatedForecast),
  externalResponse:feeds([valid])
},async({page:p})=>{
  await p.waitForFunction(n=>STATE.pred72Mllw?.length===n&&tsChart?.data.datasets.some(d=>d.label==='Forecast'),isolatedForecast.length);
  const result=await p.evaluate(time=>{
    const index=tsChart.data.labels.indexOf(time),dataset=tsChart.data.datasets.findIndex(d=>d.label==='Forecast');
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
