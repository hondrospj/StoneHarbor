import assert from 'node:assert/strict';
import {createHarness, sourceSha256, writeReport} from './dashboard-browser-harness.mjs';

const noaa = 'https://api.weather.gov/alerts/active?';
const validReading = {
  body:{type:'FeatureCollection', features:[{type:'Feature', properties:{
    monitoring_location_id:'USGS-01411360', parameter_code:'72279', unit_of_measure:'ft',
    time:'2026-11-03T21:54:00Z', value:3.60
  }}]}
};
const coastalWarning = {properties:{
  event:'Coastal Flood Warning', sent:'2026-11-03T20:00:00Z',
  ends:'2026-11-04T02:00:00Z', expires:'2026-11-03T23:00:00Z'
}};
const coastalAdvisory = {properties:{
  event:'Coastal Flood Advisory', sent:'2026-11-03T21:00:00Z', expires:'2026-11-04T03:00:00Z'
}};
const alertOutage = {status:503, body:{}};
const alertResponse = (...features) => ({body:{type:'FeatureCollection', features}});
const record = {sourceSha256, checks:[]};

let alerts = alertOutage;
const alertTest = await createHarness({externalResponse:({url})=>url.startsWith(noaa) ? alerts : undefined});
try{
  const page = alertTest.page;
  const title = page.locator('#alertTitle');
  await page.waitForFunction(()=>document.getElementById('alertTitle').textContent === 'Coastal flood alerts unavailable');
  assert.equal(await page.locator('#alertBanner').isVisible(), true);
  assert.equal(await page.locator('script[src="assets/chart.umd.js"]').count(), 1);
  assert.equal(await page.evaluate(()=>window.Chart?.version), '4.4.1');

  alerts = alertResponse(coastalAdvisory, coastalWarning);
  await page.evaluate(()=>updateAlerts());
  assert.equal(await title.textContent(), 'Coastal Flood Warning');

  for(const outage of [alertOutage, {body:{unexpected:'format'}}]){
    alerts = outage;
    await page.evaluate(()=>updateAlerts());
    assert.equal(await title.textContent(), 'Coastal Flood Warning');
    assert.match(await page.locator('#alertBody').textContent(), /last confirmed alert/);
    assert.equal(await page.locator('#alertBanner').isVisible(), true);
  }

  await page.evaluate(()=>{ Date.now = () => Date.parse('2026-11-03T23:01:00Z'); });
  await page.evaluate(()=>updateAlerts());
  assert.equal(await title.textContent(), 'Coastal Flood Advisory');

  await page.evaluate(()=>{ Date.now = () => Date.parse('2026-11-04T03:01:00Z'); });
  await page.evaluate(()=>updateAlerts());
  assert.equal(await title.textContent(), 'Coastal flood alerts unavailable');

  alerts = alertResponse();
  await page.evaluate(()=>updateAlerts());
  assert.equal(await page.locator('#alertBanner').isVisible(), false);
  assert.deepEqual(alertTest.errors, []);
  record.checks.push('Warnings outrank advisories and survive a failed refresh until expiration');
}finally{
  await alertTest.close();
}

const runIssued = '2026-11-03T18:00:00Z';
const forecastStart = Date.parse('2026-11-03T21:00:00Z');
const forecast = Array.from({length:75}, (_, i)=>({
  t:new Date(forecastStart + i*3600000).toISOString(), source_twl_mean:5
}));
const chartTest = await createHarness({
  responseForRequest:({url})=>{
    const path = new URL(url).pathname;
    if(path.endsWith('/assets/chart.umd.js') || path.endsWith('/dist/chart.umd.min.js')) return {status:503, body:{}};
    if(path === '/data/petss_forecast.json') return {body:forecast};
    if(path === '/data/petss_meta.json') return {body:{
      model_time_utc:runIssued, stid:'8535581', datum:'MLLW', forecast_valid_until_utc:forecast.at(-1).t
    }};
  },
  externalResponse:({url})=>{
    if(url.startsWith(noaa)) return alertResponse(coastalWarning);
    if(url.startsWith('https://api.waterdata.usgs.gov/')) return validReading;
  }
});
try{
  const page = chartTest.page;
  await page.waitForFunction(()=>document.getElementById('stageText').textContent === 'MINOR FLOODING' &&
    document.getElementById('alertTitle').textContent === 'Coastal Flood Warning' &&
    document.getElementById('f48Meta').textContent.includes('Issued') &&
    document.querySelectorAll('#histBody tr').length > 0);
  assert.equal(await page.locator('#chartStatus').isVisible(), true);
  assert.equal(await page.locator('#tsChart').isVisible(), false);
  assert.equal(await page.locator('#minorBadge').textContent(), '6.10–7.10 ft');
  assert.equal(await page.locator('#moderateBadge').textContent(), '7.10–8.10 ft');
  assert.equal(await page.locator('#majorBadge').textContent(), '≥ 8.10 ft');
  assert.deepEqual(chartTest.errors, []);
  record.checks.push('Gauge, warnings, forecast outlook and history load when the chart asset fails');
}finally{
  await chartTest.close();
}

writeReport(record);
