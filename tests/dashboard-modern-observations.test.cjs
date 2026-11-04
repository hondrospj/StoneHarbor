const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const html = fs.readFileSync(process.env.DASHBOARD_SOURCE_HTML || path.join(__dirname, '../index.html'), 'utf8');
function source(name) {
  const start = [...html.matchAll(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g'))].at(-1)?.index;
  assert.notEqual(start, undefined, name);
  for (let end = html.indexOf('}', start); end >= 0; end = html.indexOf('}', end + 1)) {
    const value = html.slice(start, end + 1);
    try { new vm.Script('(' + value + ')'); return value; } catch {}
  }
  throw new Error('Cannot extract actual function ' + name);
}
function fixture(rows, {legacyError = null, legacyRows = []} = {}) {
  let legacyCalls = 0;
  const context = {
    Date, URL, USGS_SITE:'01411360', USGS_PARAM_PRIMARY:'72279',
    console:{warn() {}}, startFromPeriod:() => null,
    fetchWithTimeout:async () => ({ok:true, json:async () => ({
      type:'FeatureCollection', features:rows.map((row, index) => ({
        type:'Feature', geometry:null, properties:{monitoring_location_id:'USGS-01411360',
          parameter_code:'72279', unit_of_measure:'ft', time:`2026-11-03T18:${String(index * 5).padStart(2, '0')}:00Z`, ...row}
      }))
    })}),
    fetchLegacyIV:async () => {
      legacyCalls++;
      if (legacyError) throw legacyError;
      return {value:{timeSeries:[{variable:{variableCode:[{value:'72279'}],unit:{unitCode:'ft'}},values:[{value:legacyRows}]}]}};
    }
  };
  vm.createContext(context);
  for (const name of ['dashboardGaugeNumber', 'fetchIV', 'extractWaterLevelSeries_NAVD88']) vm.runInContext(source(name), context);
  return {
    async read() {
      const json = await context.fetchIV({startISO:'2026-11-03T17:00:00Z', endISO:'2026-11-03T20:00:00Z'});
      return JSON.parse(JSON.stringify(context.extractWaterLevelSeries_NAVD88(json)));
    },
    get legacyCalls() { return legacyCalls; }
  };
}

for (const [label, value] of [['null', null], ['blank', ''], ['whitespace', '  '], ['false', false], ['true', true], ['empty array', []], ['object', {}]]) {
  test('actual modern dashboard reader rejects ' + label + ' without replacing the latest valid observation', async () => {
    const f = fixture([{value:3.5}, {value}]);
    assert.deepEqual(await f.read(), [{t:'2026-11-03T18:00:00Z',ft:3.5}]);
    assert.equal(f.legacyCalls, 0);
  });
}
test('actual modern dashboard reader retains zero, negative water levels and numeric strings', async () => {
  const f = fixture([{value:0}, {value:-1.25}, {value:'2.75'}, {value:'0'}]);
  assert.deepEqual((await f.read()).map(p => p.ft), [0,-1.25,2.75,0]);
  assert.equal(f.legacyCalls, 0);
});
test('only missing modern observations trigger the existing legacy fallback', async () => {
  const f = fixture([{value:null}, {value:''}, {value:false}], {legacyRows:[{dateTime:'2026-11-03T18:30:00Z',value:'4.0'}]});
  assert.deepEqual(await f.read(), [{t:'2026-11-03T18:30:00Z',ft:4}]);
  assert.equal(f.legacyCalls, 1);
});
test('missing modern values and unavailable legacy data reject instead of manufacturing a reading', async () => {
  const f = fixture([{value:null}], {legacyError:new Error('Controlled unavailable legacy feed')});
  await assert.rejects(f.read(), /Controlled unavailable legacy feed/);
  assert.equal(f.legacyCalls, 1);
});
