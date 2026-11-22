const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(process.env.DASHBOARD_SOURCE_HTML || path.join(__dirname, "../index.html"), "utf8");

test("flood bands are clipped when the water-level axis starts above a threshold", () => {
  const area = {left:40,right:440,top:20,bottom:220};
  const fills = [];
  let rectangle;
  let clipped = false;
  const chart = {
    canvas:{id:"tsChart"}, chartArea:area,
    scales:{y:{getPixelForValue:value => area.bottom - (value - 7) * (area.bottom - area.top) / 3}},
    ctx:{
      save() {},
      beginPath() {},
      rect(...bounds) { rectangle = bounds; },
      clip() { clipped = true; },
      fillRect(_x, y, _width, height) { fills.push({end:y+height, clipped}); },
      restore() {}
    }
  };
  const scope = vm.createContext({chart, DISPLAY_DATUM:"MLLW", THRESH:{
    MLLW:{minorLow:6.1,moderateLow:7.1,majorLow:8.1}
  }});
  const plugin = html.match(/^const floodBandsPlugin = \{[\s\S]*?^};/m)[0];
  vm.runInContext(plugin + "\nfloodBandsPlugin.beforeDatasetsDraw(chart);", scope);
  assert.equal(fills[0].end, 280);
  assert.ok(fills.every(fill => fill.clipped));
  assert.deepEqual(rectangle, [40,20,400,200]);
});

test("the outlook distinguishes overnight periods and repeated daylight-saving times", () => {
  const scope = vm.createContext({TZ:"America/New_York"});
  const dateFormat = html.match(/^const fmtPartsYMD = .*;$/m)[0];
  const outlookFormat = html.match(/^const fmtOutlookTime = [\s\S]*?^\}\);$/m)[0];
  vm.runInContext(dateFormat + "\n" + outlookFormat, scope);
  for(const name of ["fmtNiceDate","getESTParts","sameLocalDayISO","formatFloodWindow"]){
    const code = html.match(new RegExp(`^function ${name}\\([^\\n]*\\)\\{[\\s\\S]*?^}`, "m"))[0];
    vm.runInContext(code, scope);
  }
  const windowAt = (start, end) => scope.formatFloodWindow(Date.parse(start), Date.parse(end));
  assert.equal(windowAt("2026-11-16T04:00:00Z", "2026-11-16T06:00:00Z"),
    "November 15th, 2026 · 11:00 PM EST → November 16th, 2026 · 1:00 AM EST");
  assert.equal(windowAt("2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"),
    "November 1st, 2026 · 1:30 AM EDT → 1:30 AM EST");
  assert.match(html, /formatFloodWindow\(seg\.startMs, seg\.endMs\)/);
});

test("annual category tooltips retain the published quantiles for fractional means", () => {
  const model = JSON.parse(html.match(/^const FUTURE_FLOOD_PREDICTIONS = (.*);$/m)[1]);
  const row = model.Baseline.find(record => record.year === 2027);
  const scope = vm.createContext({
    annualPredictionLookup: new Map([[row.year, row]]),
    FLOOD_STAGE_VIEWS: ["minor", "moderate", "major"]
  });
  const bounds = html.match(/^function annualPredictionBounds\([^\n]+\)\{[\s\S]*?^}/m)[0];
  vm.runInContext(bounds, scope);
  for (const category of ["Minor", "Moderate", "Major"]) {
    const prefix = category.toLowerCase();
    const {low, high} = scope.annualPredictionBounds(row.year, category, row[`${prefix}Mean`]);
    assert.equal(low, row[`${prefix}P05`]);
    assert.equal(high, row[`${prefix}P95`]);
  }
  assert.match(html, /annualPredictionBounds\(year, ctx\.dataset\.label, v\)/);
});

test("annual tooltips display nonzero forecasts and totals as expected counts", () => {
  const model = JSON.parse(html.match(/^const FUTURE_FLOOD_PREDICTIONS = (.*);$/m)[1]);
  const row = model.Baseline.find(record => record.year === 2028);
  const scope = vm.createContext({
    $:() => null,
    Chart:class {
      constructor(_canvas, {data, options}) { Object.assign(this, {data, options}); }
      isDatasetVisible(index) { return !this.data.datasets[index].hidden; }
    },
    annualChart:null,
    YEARS:[2026, row.year],
    annualMinor:[45, row.minorMean],
    annualModerate:[4, row.moderateMean],
    annualMajor:[1, row.majorMean],
    annualColors:() => [],
    annualCoverageNote:() => "",
    annualPredictionLookup:new Map([[row.year, row]]),
    FLOOD_STAGE_VIEWS:["minor", "moderate", "major"],
    ANNUAL_VIEW:"total",
    rightFloodAxisConfig:() => ({}),
    attachChartZoom:() => {}
  });
  for (const name of ["annualPredictionBounds", "annualTooltipFooter", "ensureAnnual"]) {
    const source = html.match(new RegExp(`^function ${name}\\([^\\n]*\\)\\{[\\s\\S]*?^}(?=\\s*^function )`, "m"))[0];
    vm.runInContext(source, scope);
  }
  scope.ensureAnnual();
  const chart = scope.annualChart;
  const {label, footer} = chart.options.plugins.tooltip.callbacks;
  const items = index => chart.data.datasets.filter((_,i) => chart.isDatasetVisible(i)).map(dataset => ({
    chart, dataset, label:String(chart.data.labels[index]), parsed:{y:dataset.data[index]}
  }));
  assert.equal(label(items(1)[2]), "Major: 0.17 expected flooding high tides (0 - 1 flooding high tides)");
  assert.equal(footer(items(1))[0], "Total: 49.45 expected flooding high tides");
  assert.equal(label(items(0)[2]), "Major: 1 flooding high tides");
  assert.equal(footer(items(0))[0], "Total: 50 flooding high tides");
  chart.data.datasets[1].hidden = true;
  assert.equal(footer(items(1))[0], "Visible total: 45.61 expected flooding high tides");
});

test("the legacy Pages entry redirects only Stone Harbor and preserves the query and fragment", () => {
  const script = html.match(/<script id="stone-harbor-legacy-redirect">([\s\S]*?)<\/script>/)[1];
  for (const [host, route, shouldRedirect] of [
    ["hondrospj.github.io", "/StoneHarbor", true],
    ["hondrospj.github.io", "/StoneHarbor/", true],
    ["hondrospj.github.io", "/StoneHarbor/index.html", true],
    ["hondrospj.github.io", "/StoneHarbor/data/peaks_navd88.json", false],
    ["hondrospj.github.io", "/Avalon/", false],
    ["cupajoe.live", "/stone-harbor/flooddashboard/", false]
  ]) {
    const replacements = [];
    vm.runInNewContext(script, {location: {
      hostname: host,
      pathname: route,
      search: "?view=historic",
      hash: "#historicFloodAcc",
      replace: url => replacements.push(url)
    }});
    assert.deepEqual(replacements, shouldRedirect
      ? ["https://cupajoe.live/stone-harbor/flooddashboard/?view=historic#historicFloodAcc"]
      : []);
  }
});
