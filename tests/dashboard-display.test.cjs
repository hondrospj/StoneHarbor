const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");

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
