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
function legacySeries(value, {site = '01411360', parameter = '72279', unit = 'ft'} = {}) {
  return {
    sourceInfo:{siteCode:[{value:site}]},
    variable:{variableCode:[{value:parameter}],unit:{unitCode:unit}},
    values:[{value}]
  };
}
function fixture(rows, {legacyError = null, legacyRows = [], legacyExtraSeries = []} = {}) {
  let legacyCalls = 0;
  const context = {
    Date, URL, GAUGE_TYPE:'USGS', USGS_SITE:'01411360', USGS_PARAM_PRIMARY:'72279',
    console:{warn() {}}, startFromPeriod:() => null,
    fetchWithTimeout:async (url) => {
      const request = new URL(url);
      if (request.hostname === 'waterservices.usgs.gov') {
        legacyCalls++;
        if (legacyError) throw legacyError;
        return {ok:true, json:async () => ({
          value:{timeSeries:[legacySeries(legacyRows), ...legacyExtraSeries]}
        })};
      }
      assert.equal(request.hostname, 'api.waterdata.usgs.gov');
      return {ok:true, json:async () => ({
        type:'FeatureCollection', features:rows.map((row, index) => ({
          type:'Feature', geometry:null, properties:{monitoring_location_id:'USGS-01411360',
            parameter_code:'72279', unit_of_measure:'ft', time:`2026-11-03T18:${String(index * 5).padStart(2, '0')}:00Z`, ...row}
        }))
      })};
    }
  };
  vm.createContext(context);
  for (const name of ['dashboardGaugeNumber', 'fetchIV', 'fetchLegacyIV', 'extractWaterLevelSeries_NAVD88', 'fetchObservedSeries']) {
    vm.runInContext(source(name), context);
  }
  return {
    async read() {
      const points = await context.fetchObservedSeries({startISO:'2026-11-03T17:00:00Z', endISO:'2026-11-03T20:00:00Z'});
      return JSON.parse(JSON.stringify(points));
    },
    get legacyCalls() { return legacyCalls; }
  };
}

for (const [label, value] of [['null', null], ['blank', ''], ['whitespace', '  '], ['false', false], ['true', true], ['empty array', []], ['object', {}], ['out-of-range level', 999]]) {
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
test('legacy fallback rejects other stations, parameters, and units even with more readings', async () => {
  const otherReadings = [
    {dateTime:'2026-11-03T18:45:00Z',value:'5.1'},
    {dateTime:'2026-11-03T19:00:00Z',value:'5.3'}
  ];
  const f = fixture([{value:null}], {
    legacyRows:[{dateTime:'2026-11-03T18:30:00Z',value:'2.4'}],
    legacyExtraSeries:[
      legacySeries(otherReadings, {site:'01408168'}),
      legacySeries(otherReadings, {parameter:'62620'}),
      legacySeries(otherReadings, {unit:'ft/s'}),
      legacySeries(otherReadings, {unit:''})
    ]
  });
  assert.deepEqual(await f.read(), [{t:'2026-11-03T18:30:00Z',ft:2.4}]);
  assert.equal(f.legacyCalls, 1);
});
test('legacy fallback rejects observations outside the requested interval', async () => {
  const f = fixture([{value:null}], {legacyRows:[
    null,
    {dateTime:'2026-11-03T18:25:00Z',value:'999'},
    {dateTime:'2026-11-03T16:45:00Z',value:'5.1'},
    {dateTime:'2026-11-03T17:00:00Z',value:'2.4'},
    {dateTime:'2026-11-03T20:00:00Z',value:'3'},
    {dateTime:'2026-11-03T20:15:00Z',value:'5.3'}
  ]});
  assert.deepEqual(await f.read(), [
    {t:'2026-11-03T17:00:00Z',ft:2.4},
    {t:'2026-11-03T20:00:00Z',ft:3}
  ]);
  assert.equal(f.legacyCalls, 1);
});
test('legacy fallback reports an unavailable feed when every series is from a different station', async () => {
  const f = fixture([], {legacyExtraSeries:[
    legacySeries([{dateTime:'2026-11-03T18:45:00Z',value:'5.1'}], {site:'01408168'})
  ]});
  await assert.rejects(f.read(), /WaterServices returned no usable tidal elevation observations/);
});
test('missing modern values and unavailable legacy data reject instead of manufacturing a reading', async () => {
  const f = fixture([{value:null}], {legacyError:new Error('Controlled unavailable legacy feed')});
  await assert.rejects(f.read(), /Controlled unavailable legacy feed/);
  assert.equal(f.legacyCalls, 1);
});
