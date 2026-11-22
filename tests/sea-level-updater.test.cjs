const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const updaterPath = process.env.SEA_LEVEL_UPDATER_SOURCE || path.join(__dirname, "../tools/update_sealevel.js");
const source = fs.readFileSync(updaterPath, "utf8").replace(/^main\(\)\.catch\([\s\S]+/m, "");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const browserStations = JSON.parse(html.match(/^const NOAA_SEA_LEVEL_STATION_CANDIDATES = (.*);$/m)[1]);
const plain = result => JSON.parse(JSON.stringify(result));

function harness(fetchJson) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ["2026-11-22T15:00:00Z"])); }
  }
  const context = vm.createContext({require, URL, Date:FixedDate});
  vm.runInContext(source, context);
  context.fetchJson = fetchJson;
  return context;
}

function dailySeries(site, value) {
  return {
    sourceInfo:{siteCode:[{value:site}]},
    variable:{variableCode:[{value:"72279"}],unit:{unitCode:"ft"},noDataValue:-999999},
    values:[{value}]
  };
}

test("the cache updater only uses distinct, valid daily values for the configured gauge", async () => {
  const response = {value:{timeSeries:[
    dailySeries("01408168", [{dateTime:"2026-10-20",value:"5.2"}]),
    dailySeries("01411360", [
      {dateTime:"2026-02-31",value:"3"},
      {dateTime:"2026-10-20",value:"0.2"},
      {dateTime:"2026-10-20",value:"5.2"},
      {dateTime:"2026-10-21",value:null},
      {dateTime:"2026-10-22",value:" "},
      {dateTime:"2026-10-23",value:"0"},
      {dateTime:"2026-10-24",value:"-999999"},
      {dateTime:"2026-11-23",value:"0.9"}
    ])
  ]}};
  const context = harness(async () => response);
  assert.deepEqual(plain(await context.fetchUSGSDailyValues()), [
    {date:"2026-10-20",ft:0.2}, {date:"2026-10-23",ft:0}
  ]);
});

test("missing official trend rates are unavailable and missing standard errors stay unknown", () => {
  const context = harness();
  const entry = series => `<location><stationid>8536110</stationid><commonname>Cape May</commonname>${series}</location>`;
  assert.equal(context.parseNOAAOfficialTrend(entry(""), "8536110"), null);
  assert.equal(context.parseNOAAOfficialTrend(entry("<slt>0</slt>"), "8536110").millimetersPerYear, 0);
  const trend = context.parseNOAAOfficialTrend(entry("<slt>5.1</slt>"), "8536110");
  assert.equal(trend.millimetersPerYear, 5.1);
  assert.equal(trend.standardErrorMillimetersPerYear, null);
});

test("the cache updater uses an approved NOAA station and filters missing monthly values", async () => {
  const context = harness(async url => ({
    metadata:{id:url.searchParams.get("station")},
    data:[
      {year:"2026",month:"10",MSL:"0"},
      {year:"2026",month:"09",MSL:null},
      {year:"2026",month:"08",MSL:" "},
      {year:"2026",month:"13",MSL:"0.4"}
    ]
  }));
  const result = await context.fetchNOAAMonthlyMeans();
  assert(browserStations.includes(result.station));
  assert.deepEqual(plain(result.monthly), [{month:"2026-10",ft:0,days:null}]);
});
