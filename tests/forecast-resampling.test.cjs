const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const html = fs.readFileSync(process.env.DASHBOARD_SOURCE_HTML || path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('function interpolateForecastLevels(');
assert.ok(start >= 0);
const code = html.slice(start, html.indexOf('\n}', start) + 2);
const context = vm.createContext({Date});
vm.runInContext(code, context);
const H = 3600000, base = Date.parse('2026-11-03T22:00:00Z');
const points = rows => rows.map(([hour, ft]) => ({t:new Date(base + hour * H).toISOString(), ft}));
function sample(rows, begin=0, end=12) {
  const labels = [];
  for(let hour=begin; hour<=end; hour+=.25) labels.push(base+hour*H);
  return {labels, values:Array.from(context.interpolateForecastLevels(points(rows), labels))};
}
const at = (result, hour) => result.values[result.labels.indexOf(base + hour * H)];

test('a known forecast peak survives a long gap while the unsupported interval stays missing', () => {
  const result = sample([[0,5],[1,5],[10,8.5],[11,5]],0,11);
  assert.equal(at(result,10),8.5);
  assert.equal(at(result,1),5);
  for (let hour=1.25;hour<10;hour+=.25) assert.equal(at(result,hour),null);
  assert.equal(at(result,10.25),7.625);
});
test('a known final point after a long gap is retained without needing a later bracket', () => {
  const result = sample([[0,5],[10,8.5]],0,10);
  assert.equal(at(result,10),8.5);
  assert.equal(at(result,9.75),null);
});
for (const value of [0,-1.25]) {
  test('a known ' + value + '-foot reading survives an unsupported preceding bracket', () => {
    const result = sample([[0,5],[10,value],[11,1]],0,11);
    assert.equal(at(result,10),value);
    assert.equal(at(result,9.75),null);
  });
}
test('normal hourly interpolation remains linear', () => {
  const result = sample([[0,5],[1,7],[2,5]],0,2);
  assert.deepEqual(result.values,[5,5.5,6,6.5,7,6.5,6,5.5,5]);
});
test('the existing three-hour bracket limit remains inclusive', () => {
  const result = sample([[0,2],[3,5]],0,3);
  assert.equal(at(result,0),2);assert.equal(at(result,1.5),3.5);assert.equal(at(result,3),5);
});
test('a bracket exceeding three hours stays unknown except at its known endpoints', () => {
  const result = sample([[0,2],[3.25,5]],0,3.25);
  assert.equal(at(result,0),2);assert.equal(at(result,3.25),5);
  assert.ok(result.values.slice(1,-1).every(v=>v===null));
});
test('empty forecasts return missing samples', () => {
  const result = sample([],0,1);
  assert.deepEqual(result.values,[null,null,null,null,null]);
});
test('resampling sorts a copy and preserves the input observations', () => {
  const input = points([[10,8.5],[0,5],[11,5]]),before=JSON.stringify(input);
  const result = context.interpolateForecastLevels(input,[base, base+10*H, base+11*H]);
  assert.equal(JSON.stringify(input),before);
  assert.equal(result[1],8.5);
});
test('forecast rendering leaves unsupported gaps disconnected', () => {
  const begin=html.indexOf('function tsPredictedDataset(');
  assert.ok(begin>=0);
  vm.runInContext(html.slice(begin,html.indexOf('\n}',begin)+2),context);
  const values=[5,null,null,8.5,7.625];
  const dataset=context.tsPredictedDataset(values);
  assert.equal(dataset.spanGaps,false);
  assert.deepEqual(Array.from(dataset.data),values);
});
test('isolated known forecast samples have visible markers without adding markers to continuous lines', () => {
  const begin=html.indexOf('function tsPredictedDataset(');
  vm.runInContext(html.slice(begin,html.indexOf('\n}',begin)+2),context);
  const dataset=context.tsPredictedDataset([5,5,null,8.5,null,0,null,-1.25,null]);
  assert.equal(typeof dataset.pointRadius,'function');
  for(const i of [3,5,7]){
    const ctx={dataset,dataIndex:i};
    assert.ok(dataset.pointRadius(ctx)>0);
    assert.ok(dataset.pointHoverRadius(ctx)>=dataset.pointRadius(ctx));
  }
  for(const i of [0,1,2,4,6,8])assert.equal(dataset.pointRadius({dataset,dataIndex:i}),0);
  assert.equal(dataset.spanGaps,false);
});
