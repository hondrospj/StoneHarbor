import assert from 'node:assert/strict';
import {createHarness,sourceSha256,writeReport} from './dashboard-browser-harness.mjs';
const record={sourceSha256,checks:[],errors:[],mode:'Actual dashboard/data with pinned offline vendors; fresh isolated headless contexts and native inputs'};
async function run(name,options,test){
  if(process.env.DASHBOARD_UI_TEST_FILTER&&!new RegExp(process.env.DASHBOARD_UI_TEST_FILTER).test(name))return;
  const row={name};let h;
  try{h=await createHarness(options);record.browser=h.browser.version();row.observations=await test(h);assert.deepEqual(h.errors,[]);row.passed=true;}
  catch(error){row.passed=false;row.failure=error.stack||String(error);}
  finally{if(h){record.errors.push(...h.errors);await h.close();}}
  record.checks.push(row);console.log(`${row.passed?'PASS':'FAIL'} ${name}`);if(!row.passed)console.log(row.failure);
}
async function range(page){return page.evaluate(()=>({min:document.querySelector('#minElev').value,max:document.querySelector('#maxElev').value,from:document.querySelector('#fromDate').value,to:document.querySelector('#toDate').value,datum:document.querySelector('#datumSelect').value,rows:[...document.querySelectorAll('#histBody tr')].map(row=>({date:row.cells[0].textContent,rank:row.cells[1].textContent,height:row.cells[2].textContent}))}));}
const identities=value=>value.rows.map(row=>[row.date,row.rank]);
async function focused(page){return page.evaluate(()=>({tag:document.activeElement.tagName,id:document.activeElement.id,year:document.activeElement.dataset?.doyYear||null,legend:document.activeElement.closest('.shorelyChartLegend')?.id||null,text:document.activeElement.textContent?.trim()}));}
await run('unbounded historic range keeps the same tides through every datum',{},async({page:p,ready})=>{
  await ready();await p.locator('#minElev').fill('');await p.locator('#maxElev').fill('');await p.locator('#sortMode').selectOption('asc');await p.locator('#applyBtn').click();const initial=await range(p);
  for(const datum of['NAVD88','MSL','MHHW','MLLW']){await p.locator('#datumSelect').selectOption(datum);const next=await range(p);assert.equal(next.min,'');assert.equal(next.max,'');assert.deepEqual(identities(next),identities(initial));}
  return{rows:initial.rows.length,first:initial.rows[0],allFourDatums:true};
});
await run('an upper-only historic range stays upper-only after datum conversion',{},async({page:p,ready})=>{
  await ready();await p.locator('#minElev').fill('');await p.locator('#maxElev').fill('4.00');await p.locator('#sortMode').selectOption('asc');await p.locator('#applyBtn').click();const initial=await range(p);assert.equal(initial.rows.length,10);
  for(const datum of['NAVD88','MSL','MHHW','MLLW']){await p.locator('#datumSelect').selectOption(datum);const next=await range(p);assert.equal(next.min,'');assert.notEqual(next.max,'');assert.deepEqual(identities(next),identities(initial));}
  return{first:initial.rows[0],last:initial.rows.at(-1),allFourDatums:true};
});
await run('datum conversion preserves a lower-only range and chosen year visibility',{},async({page:p,ready})=>{
  await ready();await p.locator('#minElev').fill('6.10');await p.locator('#maxElev').fill('');await p.locator('#applyBtn').click();
  const yearButton=p.locator('#doyYearTable button').first(),year=await yearButton.getAttribute('data-doy-year');await yearButton.click();const initial=await range(p);
  for(const datum of['NAVD88','MSL','MHHW','MLLW']){await p.locator('#datumSelect').selectOption(datum);const next=await range(p);assert.notEqual(next.min,'');assert.equal(next.max,'');assert.deepEqual(identities(next),identities(initial));assert.equal(await p.locator(`[data-doy-year="${year}"]`).getAttribute('aria-pressed'),'false');}
  return{year,lowerOnlyRangeAndHiddenYearPreserved:true};
});
await run('mobile Reset keeps the complete record through resize and rotation',{viewport:{width:390,height:844}},async({page:p,ready})=>{
  await ready();const initial=await range(p);assert.match(initial.from,/^2026-01-01$/);await p.locator('#resetBtn').click();const reset=await range(p);assert.equal(reset.from,'');assert.equal(reset.to,'');
  for(const viewport of[{width:391,height:844},{width:844,height:390},{width:390,height:844}]){await p.setViewportSize(viewport);await p.waitForTimeout(100);const next=await range(p);assert.equal(next.from,'');assert.equal(next.to,'');assert.deepEqual(identities(next),identities(reset));}
  return{resetFirst:reset.rows[0],initialFirst:initial.rows[0],rotationsPreserveRange:true};
});
await run('mobile cleared and typed dates survive later viewport changes',{viewport:{width:390,height:844}},async({page:p,ready})=>{
  await ready();await p.locator('#fromDate').fill('');await p.locator('#toDate').fill('2012-12-31');await p.locator('#applyBtn').click();const initial=await range(p);await p.setViewportSize({width:400,height:780});await p.waitForTimeout(150);const after=await range(p);assert.equal(after.from,'');assert.equal(after.to,'2012-12-31');assert.deepEqual(identities(after),identities(initial));return{first:after.rows[0],upperOnlyDatePreserved:true};
});
await run('Reset during history loading survives delayed startup callbacks',{viewport:{width:390,height:844},localDelays:{'data/peaks_navd88.json':1800}},async({page:p,ready})=>{
  await p.locator('#resetBtn').click();assert.equal((await range(p)).from,'');await ready({settleMs:2500});const after=await range(p);assert.equal(after.from,'');assert.equal(after.to,'');assert.match(after.rows[0].date,/1962/);return{first:after.rows[0],datesRemainCleared:true};
});
await run('year visibility keyboard toggles preserve their focused year',{},async({page:p,ready})=>{
  await ready();const button=p.locator('#doyYearTable button').first(),year=await button.getAttribute('data-doy-year'),pressed=await button.getAttribute('aria-pressed');await button.focus();await p.keyboard.press('Enter');await p.waitForTimeout(150);assert.equal((await focused(p)).year,year);assert.notEqual(await p.locator(`[data-doy-year="${year}"]`).getAttribute('aria-pressed'),pressed);await p.keyboard.press('Enter');await p.waitForTimeout(150);assert.equal((await focused(p)).year,year);assert.equal(await p.locator(`[data-doy-year="${year}"]`).getAttribute('aria-pressed'),pressed);return{year,keyboardCanRetoggle:true};
});
await run('chart legend keyboard toggles preserve focused dataset identity',{},async({page:p,ready})=>{
  await ready();const button=p.locator('#shorelyLegend-annualChart button').first(),text=(await button.textContent()).trim(),pressed=await button.getAttribute('aria-pressed');await button.focus();await p.keyboard.press('Enter');await p.waitForTimeout(200);const after=await focused(p);assert.equal(after.legend,'shorelyLegend-annualChart');assert.equal(after.text,text);assert.notEqual(await p.locator('#shorelyLegend-annualChart button').first().getAttribute('aria-pressed'),pressed);await p.keyboard.press('Enter');await p.waitForTimeout(200);assert.equal((await focused(p)).text,text);assert.equal(await p.locator('#shorelyLegend-annualChart button').first().getAttribute('aria-pressed'),pressed);return{dataset:text,keyboardCanRetoggle:true};
});
await run('queued redraws respect newer field focus and open tutorial focus',{},async({page:p,ready})=>{
  await ready();await p.locator('#shorelyLegend-annualChart button').first().focus();await p.keyboard.press('Enter');await p.locator('#minElev').focus();await p.evaluate(()=>{annualChart.update('none');refreshDOYFromHistory();});await p.waitForTimeout(200);assert.equal((await focused(p)).id,'minElev');
  await p.locator('#dashboardTutorialBtn').click();assert.equal((await focused(p)).id,'dashboardTutorialNext');await p.evaluate(()=>{annualChart.update('none');refreshDOYFromHistory();});await p.waitForTimeout(200);assert.equal((await focused(p)).id,'dashboardTutorialNext');await p.keyboard.press('Escape');return{newerInputAndDialogFocusPreserved:true};
});
await run('annual and monthly category buttons override the previous legend selection',{},async({page,ready})=>{
  await ready();
  for (const [chartId, segmentId, label] of [
    ['annualChart', 'annualViewSeg', 'Moderate'],
    ['monthAvgChart', 'monthViewSeg', 'Average Moderate']
  ]) {
    const legend = page.locator(`#shorelyLegend-${chartId}`);
    const segment = page.locator(`#${segmentId}`);
    const visible = () => page.evaluate(id => {
      const chart = Chart.getChart(id);
      return chart.data.datasets.map((_, index) => chart.isDatasetVisible(index));
    }, chartId);

    await legend.getByRole('button', {name:label, exact:true}).click();
    assert.deepEqual(await visible(), [true, false, true]);
    assert.equal(await segment.locator('[aria-pressed=true]').count(), 0);
    await segment.getByRole('button', {name:'Moderate', exact:true}).click();
    assert.deepEqual(await visible(), [false, true, false]);
    await page.evaluate(() => {renderAnnual(); updateMonthAveragesFromHistory();});
    assert.deepEqual(await visible(), [false, true, false]);
    await segment.getByRole('button', {name:'Total', exact:true}).click();
    assert.deepEqual(await visible(), [true, true, true]);
  }
  return {annualAndMonthlyPresetsVerified:true};
});
await run('the tutorial keeps focus after Back and returns it to the launch button',{},async({page,ready})=>{
  await ready();
  await page.locator('#dashboardTutorialBtn').click();
  await page.locator('#dashboardTutorialNext').click();
  await page.locator('#dashboardTutorialBack').focus();
  await page.keyboard.press('Enter');
  assert.equal((await focused(page)).id, 'dashboardTutorialNext');
  await page.keyboard.press('Tab');
  assert.equal((await focused(page)).id, 'dashboardTutorialClose');
  assert.ok(await page.locator('#datumSelect').evaluate(el => Boolean(el.closest('[inert]'))));
  await page.keyboard.press('Escape');
  assert.equal((await focused(page)).id, 'dashboardTutorialBtn');
  assert.equal(await page.locator('.wrap[inert]').count(), 0);
  return {modalFocusVerified:true};
});
writeReport(record);if(record.errors.length||record.checks.some(row=>!row.passed))process.exitCode=1;
