import fs from 'node:fs';
import assert from 'node:assert/strict';
import fixtures from './sea-level-test-fixtures.cjs';
import {createHarness,sourceSha256,writeReport} from './dashboard-browser-harness.mjs';
const cached=JSON.parse(fs.readFileSync(new URL('../data/sealevel.json',import.meta.url),'utf8'));
const monthlyResponse=process.env.DASHBOARD_MONTHLY_FIXTURE
  ?JSON.parse(fs.readFileSync(process.env.DASHBOARD_MONTHLY_FIXTURE,'utf8')):fixtures.monthlyMeanResponse;
const record={sourceSha256,mode:'Actual dashboard, pinned libraries and retained data; controlled cache/provider responses in fresh isolated headless browsers with an advancing clock. Read-only state inspection, no source or user-session control.',monthlyFixtureRows:monthlyResponse.data.length,checks:[],errors:[]};
async function run(name,{cache=true,daily=false,monthly=true}={},test){
  if(process.env.DASHBOARD_SEA_LEVEL_TEST_FILTER&&!new RegExp(process.env.DASHBOARD_SEA_LEVEL_TEST_FILTER).test(name))return;
  const calls=[];let h;const row={name};
  try{
    h=await createHarness({
      responseForRequest:({url})=>!cache&&new URL(url).pathname.endsWith('/sealevel.json')
        ?{status:404,body:{error:'Controlled absent sea-level cache'}}:undefined,
      externalResponse:({url})=>{
        const u=new URL(url);
        if(u.hostname==='waterservices.usgs.gov'&&u.pathname.includes('/nwis/dv/')){
          calls.push({provider:'USGS',resolution:'daily'});
          return daily?{body:fixtures.dailyPayload(cached.daily)}:{status:503,body:{error:'Controlled daily service unavailable'}};
        }
        if(u.hostname==='api.tidesandcurrents.noaa.gov'&&u.searchParams.get('product')==='monthly_mean'){
          calls.push({provider:'NOAA',resolution:'monthly'});
          return monthly?{body:monthlyResponse}:{status:503,body:{error:'Controlled monthly service unavailable'}};
        }
      }
    });
    await h.ready();row.observations=await test(h,calls);assert.deepEqual(h.errors,[]);row.passed=true;
  }catch(error){row.passed=false;row.failure=error.stack||String(error);}
  finally{if(h){record.browser=h.browser.version();record.engine=h.engineName;record.errors.push(...h.errors);await h.close();}}
  record.checks.push(row);console.log(`${row.passed?'PASS':'FAIL'} ${name}`);if(!row.passed)console.log(row.failure);
}
async function state(page){
  return page.evaluate(()=>{
    const current=SEA_LEVEL_STATE,chart=Chart.getChart(document.querySelector('#seaLevelChart'));
    const observed=chart?.data.datasets.find(row=>row.label==='Monthly mean sea level');
    return {source:current?.source||null,monthly:current?.monthly||[],meta:document.querySelector('#seaLevelMeta').textContent,
      chart:!!chart,labels:chart?.data.labels||[],observed:observed?.data||[],regression:current?.regression||null};
  });
}
await run('a successful NOAA monthly fallback renders real means after cache and daily-service failure',
  {cache:false},async({page},calls)=>{
    const result=await state(page);
    assert.equal(result.monthly.length,monthlyResponse.data.length);assert(result.chart);assert.equal(result.meta,'');
    assert.match(result.source,/NOAA.*monthly/i);
    assert(result.monthly.every(row=>row.days===undefined||row.days===null));
    assert.equal(result.monthly.find(row=>row.month==='2013-11').ft,0);
    assert.equal(result.observed.filter(Number.isFinite).length,monthlyResponse.data.length);
    assert(result.observed.some(value=>value===null),'Missing calendar months must remain chart gaps');
    assert(calls.some(call=>call.provider==='USGS'));assert(calls.some(call=>call.provider==='NOAA'));
    return {source:result.source,months:result.monthly.length,finitePlottedMonths:result.observed.filter(Number.isFinite).length,calendarGapCount:result.observed.filter(v=>v===null).length,realZeroRetained:true};
  });
await run('real retained daily values retain the daily coverage path and source',
  {cache:false,daily:true},async({page},calls)=>{
    const result=await state(page);assert(result.chart);assert.equal(result.meta,'');
    assert.equal(result.monthly.length,cached.monthly.length);assert.equal(result.source,'USGS daily values');
    assert(result.monthly.every(row=>row.days>=20));assert.equal(calls.filter(call=>call.provider==='NOAA').length,0);
    return {source:result.source,monthlyPoints:result.monthly.length,dailyObservations:cached.daily.length};
  });
await run('the original monthly cache keeps its source and stored regression',
  {},async({page},calls)=>{
    const result=await state(page);assert(result.chart);assert.equal(result.meta,'');
    assert.equal(result.monthly.length,cached.monthly.length);assert.equal(result.source,'data/sealevel.json');
    assert.equal(result.regression.slope,cached.regression.slopeFtPerYear);
    assert.equal(result.regression.intercept,cached.regression.interceptFt);
    assert.equal(calls.length,0);return {source:result.source,monthlyPoints:result.monthly.length,officialSlope:result.regression.slope};
  });
await run('failure of every sea-level source leaves an explicit unavailable result',
  {cache:false,daily:false,monthly:false},async({page},calls)=>{
    const result=await state(page);assert.equal(result.chart,false);assert.match(result.meta,/Sea level data unavailable/);
    assert.equal(result.source,null);assert.equal(result.monthly.length,0);
    assert(calls.some(call=>call.provider==='USGS'));assert(calls.some(call=>call.provider==='NOAA'));
    return {meta:result.meta,noInventedMonthlyPoints:true};
  });
writeReport(record);if(record.errors.length||record.checks.some(row=>!row.passed))process.exitCode=1;
