import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHarness,sourceSha256,writeReport} from './dashboard-browser-harness.mjs';

const report={sourceSha256,checks:[],errors:[],mode:'Actual dashboard, retained data and pinned vendors; native controls and actual five-minute callbacks in fresh isolated headless contexts.'};
const cache=JSON.parse(fs.readFileSync(new URL('../data/sealevel.json',import.meta.url),'utf8'));
const isSea=url=>new URL(url).pathname.endsWith('/data/sealevel.json');
const legend=(p,label)=>p.locator('#shorelyLegend-seaLevelChart').getByRole('button',{name:label,exact:true});
async function chart(p){return p.evaluate(()=>{const c=Chart.getChart('seaLevelChart');return{id:c.id,series:c.data.datasets.map((d,i)=>({label:d.label,visible:c.isDatasetVisible(i),last:d.data.filter(Number.isFinite).at(-1)}))};});}
const visibility=value=>Object.fromEntries(value.series.map(d=>[d.label,d.visible]));
async function ready(h){await h.ready();await h.page.waitForFunction(()=>Chart.getChart('seaLevelChart')&&document.querySelectorAll('#shorelyLegend-seaLevelChart button').length>0);}
async function reload(h){const before=await chart(h.page);await h.page.clock.fastForward(300001);await h.page.waitForFunction(id=>{const c=Chart.getChart('seaLevelChart');return c&&c.id!==id;},before.id);await h.page.waitForTimeout(100);return chart(h.page);}
async function waitNode(test){const deadline=Date.now()+10000;while(!test()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(test(),'Controlled refresh did not reach its request');}
async function run(name,options,test){
  if(process.env.DASHBOARD_LOADING_TEST_FILTER&&!new RegExp(process.env.DASHBOARD_LOADING_TEST_FILTER).test(name))return;
  const row={name};let h;
  try{h=await createHarness(options);report.browser=h.browser.version();report.engine=h.engineName;row.observations=await test(h);assert.deepEqual(h.errors,[]);row.passed=true;}
  catch(error){row.passed=false;row.failure=error.stack||String(error);}
  finally{if(h){report.errors.push(...h.errors);await h.close();}}
  report.checks.push(row);console.log(`${row.passed?'PASS':'FAIL'} ${name}`);if(!row.passed)console.log(row.failure);
}

await run('a hidden sea-level series remains hidden after the actual five-minute refresh',{clock:true},async h=>{
  await ready(h);await legend(h.page,'Monthly mean sea level').click();const before=await chart(h.page);assert.equal(visibility(before)['Monthly mean sea level'],false);
  const after=await reload(h);assert.equal(visibility(after)['Monthly mean sea level'],false);assert.equal(visibility(after)['Historical trend'],true);
  assert.equal(await legend(h.page,'Monthly mean sea level').getAttribute('aria-pressed'),'false');return{before,after};
});
await run('hide-all and later re-enable choices survive successive data reloads',{clock:true},async h=>{
  await ready(h);for(const label of (await chart(h.page)).series.map(d=>d.label))await legend(h.page,label).click();
  const hidden=await reload(h);assert.ok(hidden.series.every(d=>!d.visible));await legend(h.page,'Monthly mean sea level').click();
  const enabled=await reload(h);assert.equal(visibility(enabled)['Monthly mean sea level'],true);assert.equal(visibility(enabled)['Historical trend'],false);return{hidden,enabled};
});
await run('projection choices follow their labels when scenarios disappear and return',{},async h=>{
  await ready(h);const p=h.page;await legend(p,'Monthly mean sea level').click();await p.locator('#seaLevelProjectionToggle').click();await p.waitForTimeout(100);
  await legend(p,'Historical trend').click();await legend(p,'High').click();await legend(p,'Current Trend').click();const selected=visibility(await chart(p));
  assert.equal(selected.High,false);assert.equal(selected['Historical trend'],false);assert.equal(selected['Monthly mean sea level'],false);
  await p.locator('#seaLevelProjectionToggle').click();await p.waitForTimeout(100);assert.equal(await legend(p,'High').count(),0);assert.equal(visibility(await chart(p))['Historical trend'],false);
  await p.locator('#seaLevelProjectionToggle').click();await p.waitForTimeout(100);const restored=visibility(await chart(p));assert.deepEqual(restored,selected);
  await legend(p,'High').click();await p.locator('#seaLevelProjectionToggle').click();await p.locator('#seaLevelProjectionToggle').click();await p.waitForTimeout(100);assert.equal(visibility(await chart(p)).High,true);return{selected,restored,reEnabledScenarioSurvives:true};
});
let changedReads=0;const changed=structuredClone(cache);changed.monthly.at(-1).ft+=0.05;
await run('changed data from the same cache preserves chosen series visibility',{clock:true,responseForRequest:({url})=>isSea(url)&&++changedReads>1?{body:changed}:undefined},async h=>{
  await ready(h);await legend(h.page,'Monthly mean sea level').click();const before=await chart(h.page),after=await reload(h);
  assert.equal(visibility(after)['Monthly mean sea level'],false);assert.ok(Math.abs(after.series[0].last-before.series[0].last-0.05)<1e-8);return{before,after,cacheReads:changedReads};
});
let recovering=false;
await run('a failed refresh and recovery retain the current user choices',{clock:true,responseForRequest:({url})=>isSea(url)&&recovering?{status:503,body:{error:'Controlled unavailable cache'}}:undefined},async h=>{
  await ready(h);await legend(h.page,'Monthly mean sea level').click();const before=await chart(h.page);recovering=true;await h.page.clock.fastForward(300001);
  await h.page.waitForFunction(()=>/unavailable/i.test(document.getElementById('seaLevelMeta').textContent));assert.equal((await chart(h.page)).id,before.id);
  await legend(h.page,'Historical trend').click();recovering=false;const after=await reload(h);assert.ok(after.series.every(d=>!d.visible));return{before,after,failedRefreshKeptChart:true};
});
let pendingChoice=null,choiceReads=0;
await run('a choice made while a refresh is pending wins over the earlier display',{clock:true,responseForRequest:({url})=>{if(!isSea(url)||++choiceReads===1)return;return new Promise(resolve=>{pendingChoice=()=>resolve({body:cache});});}},async h=>{
  await ready(h);const before=await chart(h.page);await h.page.clock.fastForward(300001);await waitNode(()=>pendingChoice);
  await legend(h.page,'Monthly mean sea level').click();pendingChoice();await h.page.waitForFunction(id=>Chart.getChart('seaLevelChart')?.id!==id,before.id);await h.page.waitForTimeout(100);
  const after=await chart(h.page);assert.equal(visibility(after)['Monthly mean sea level'],false);return{before,after,newerChoiceRetained:true};
});
let pendingFocus=null,focusReads=0;
await run('queued chart rebuilding keeps current legend, field and dialog focus',{clock:true,responseForRequest:({url})=>{if(!isSea(url)||++focusReads===1)return;return new Promise(resolve=>{pendingFocus=()=>resolve({body:cache});});}},async h=>{
  await ready(h);const p=h.page,observations=[];
  for(const target of['legend','field','dialog']){
    pendingFocus=null;const before=await chart(p);await p.clock.fastForward(300001);await waitNode(()=>pendingFocus);
    if(target==='legend')await legend(p,'Monthly mean sea level').focus();
    else if(target==='field'){await p.locator('#minElev').focus();await p.locator('#minElev').fill('6.20');}
    else await p.locator('#dashboardTutorialBtn').click();
    pendingFocus();await p.waitForFunction(id=>Chart.getChart('seaLevelChart')?.id!==id,before.id);await p.waitForTimeout(100);
    const focused=await p.evaluate(()=>({id:document.activeElement.id,text:document.activeElement.textContent.trim(),legend:document.activeElement.closest('.shorelyChartLegend')?.id||null}));
    if(target==='legend'){assert.equal(focused.legend,'shorelyLegend-seaLevelChart');assert.equal(focused.text,'Monthly mean sea level');}
    else assert.equal(focused.id,target==='field'?'minElev':'dashboardTutorialNext');
    if(target==='dialog')await p.keyboard.press('Escape');observations.push({target,focused});
  }
  return observations;
});

const modern={body:{type:'FeatureCollection',features:[{type:'Feature',geometry:null,properties:{monitoring_location_id:'USGS-01411360',parameter_code:'72279',unit_of_measure:'ft',time:'2026-11-03T21:30:00Z',value:3.5}}]}};
await run('late successful time-series loading installs both keyboard series controls',{externalResponse:async({url})=>{if(!url.startsWith('https://api.waterdata.usgs.gov/'))return;await new Promise(resolve=>setTimeout(resolve,3000));return modern;}},async h=>{
  const p=h.page;await h.ready({settleMs:0});await p.waitForFunction(()=>tsChart?.data.labels.length>0);assert.ok(await p.evaluate(()=>performance.now()>2200));
  const key=p.locator('#shorelyLegend-tsChart');assert.equal(await key.locator('button').count(),2);assert.equal(await p.evaluate(()=>tsChart.options.plugins.legend.display),false);
  const observed=key.getByRole('button',{name:'Observed',exact:true}),forecast=key.getByRole('button',{name:'Forecast',exact:true});await observed.focus();await p.keyboard.press('Enter');await p.waitForTimeout(100);assert.equal(await observed.getAttribute('aria-pressed'),'false');
  assert.equal(await p.evaluate(()=>document.activeElement.dataset.shorelyLegendKey),'Observed');await p.keyboard.press(h.engineName==='webkit'?'Alt+Tab':'Tab');assert.equal(await p.evaluate(()=>document.activeElement.dataset.shorelyLegendKey),'Forecast');await p.keyboard.press('Enter');await p.waitForTimeout(100);assert.equal(await forecast.getAttribute('aria-pressed'),'false');
  assert.ok(await p.evaluate(()=>tsChart.data.datasets.every((d,i)=>!tsChart.isDatasetVisible(i))));return{bothSeriesKeyboardToggleable:true,elapsedMs:await p.evaluate(()=>performance.now())};
});
await run('an early native datum selection keeps the time-series legend through later loading',{localDelays:{'data/peaks_navd88.json':1800},externalResponse:({url})=>url.startsWith('https://api.waterdata.usgs.gov/')?modern:undefined},async h=>{
  const p=h.page;await p.locator('#datumSelect').selectOption('NAVD88');await h.ready();await p.waitForFunction(()=>tsChart?.data.labels.length>0);
  assert.ok(await p.locator('#shorelyLegend-tsChart button').count()>0);assert.equal(await p.locator('#datumSelect').inputValue(),'NAVD88');await p.locator('#tsAnnualForecastToggle').click();await p.waitForTimeout(100);assert.ok(await p.locator('#shorelyLegend-tsChart button').count()>0);return{earlySelectionAndLaterLegendPreserved:true};
});
writeReport(report);if(report.errors.length||report.checks.some(c=>!c.passed))process.exitCode=1;
