const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");

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
