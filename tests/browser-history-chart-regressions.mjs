import assert from 'node:assert/strict';
import {createHarness} from './dashboard-browser-harness.mjs';

async function run(name, options, test) {
  const harness = await createHarness(options);
  try {
    await harness.ready({settleMs:0});
    await test(harness.page);
    assert.deepEqual(harness.errors, []);
    console.log(`PASS ${name}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`FAIL ${name}`, error);
  } finally {
    await harness.close();
  }
}

async function observedSeries(page, kind) {
  return page.evaluate(kind => {
    const chart = Chart.getChart('doyCumChart');
    const index = chart.data.datasets.findIndex(dataset => dataset._kind === kind);
    const dataset = chart.data.datasets[index];
    return {
      year:dataset?._year,
      visible:index >= 0 && chart.isDatasetVisible(index),
      hasData:dataset?.data.some(Number.isFinite) || false,
      note:document.querySelector('#doyRangeNote').textContent
    };
  }, kind);
}

await run('past forecast observations use independent chart visibility', {now:'2026-11-22T13:00:00Z'}, async page => {
  await page.locator('#doyForecastToggle').click();
  await page.locator('#doyBulkActions [data-doy-preset=none]').click();
  assert.equal((await observedSeries(page, 'current')).visible, false);
  await page.locator('[data-doy-mode=past]').click();
  const shown = await observedSeries(page, 'current');
  assert.equal(shown.hasData, true);
  assert.equal(shown.visible, true);
  assert.match(shown.note, /2026 observed in red/);

  const observedLegend = page.locator('#shorelyLegend-doyCumChart').getByRole('button', {name:'2026 Observed', exact:true});
  await observedLegend.click();
  const hidden = await observedSeries(page, 'current');
  assert.equal(hidden.visible, false);
  assert.doesNotMatch(hidden.note, /observed in red/);
  await page.locator('[data-doy-mode=years]').click();
  assert.equal((await observedSeries(page, 'current')).visible, false);
  await page.locator('[data-doy-mode=past]').click();
  assert.equal((await observedSeries(page, 'current')).visible, false);
  await observedLegend.click();
  assert.equal((await observedSeries(page, 'current')).visible, true);
});

await run('prior forecast year shows its historical observations by default', {now:'2027-01-10T13:00:00Z'}, async page => {
  await page.locator('[data-doy-mode=past]').click();
  await page.locator('#doyYearTable [data-doy-year="2026"]').click();
  const prior = await observedSeries(page, 'pastObserved');
  assert.equal(prior.year, 2026);
  assert.equal(prior.hasData, true);
  assert.equal(prior.visible, true);
  assert.doesNotMatch(prior.note, /2027 observed in red/);
});

await run('monthly tooltip total follows the visible stages', {now:'2026-11-22T13:00:00Z'}, async page => {
  const result = () => page.evaluate(() => {
    const chart = Chart.getChart('monthAvgChart');
    const index = chart.$monthAvgTotals.findIndex((total, month) =>
      Number.isFinite(total) && total.toFixed(1) !== chart.data.datasets[0].data[month].toFixed(1)
    );
    const visible = chart.data.datasets.flatMap((dataset, datasetIndex) =>
      chart.isDatasetVisible(datasetIndex) ? [{datasetIndex, index}] : []
    );
    chart.tooltip.setActiveElements(visible, {x:0,y:0});
    chart.update('none');
    const total = visible.length === chart.data.datasets.length
      ? chart.$monthAvgTotals[index]
      : visible.reduce((sum, {datasetIndex}) => sum + chart.data.datasets[datasetIndex].data[index], 0);
    return {footer:chart.tooltip.footer, expected:`Total: ${total.toFixed(1)}`};
  });
  const stages = page.locator('#monthViewSeg');
  await stages.getByRole('button', {name:'Minor', exact:true}).click();
  const minor = await result();
  assert.deepEqual(minor.footer, [minor.expected]);

  await page.locator('#shorelyLegend-monthAvgChart').getByRole('button', {name:'Average Moderate', exact:true}).click();
  const mixed = await result();
  assert.deepEqual(mixed.footer, [mixed.expected]);

  await stages.getByRole('button', {name:'Total', exact:true}).click();
  const all = await result();
  assert.deepEqual(all.footer, [all.expected]);
});

await run('mobile historic dates follow Eastern time across UTC New Year', {
  viewport:{width:390,height:844}, now:'2027-01-01T02:30:00Z'
}, async page => {
  assert.equal(await page.locator('#fromDate').inputValue(), '2026-01-01');
  assert.equal(await page.locator('#toDate').inputValue(), '2026-12-31');
});
