"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {APPS,selectApps}=require("../tools/refresh_dashboard_petss");
test("central refresh selection excludes dashboards with their own clocks",()=>{
 const selected=selectApps("flooddashboard--stone-harbor,flooddashboard--cape-may-harbor,flooddashboard--sandy-hook");
 assert.equal(selected.length,3);
 assert.ok(selected.every(a=>!["flooddashboard--avalon","flooddashboard--cape-may"].includes(a.id)));
 assert.deepEqual(selectApps(null),APPS);
});
test("a typo, retired town, duplicate or empty selection cannot broaden publication",()=>{
 for(const input of ["", "flooddashboard--seaside-heights", "flooddashboard--avalon,", "flooddashboard--avalon,flooddashboard--avalon"])
  assert.throws(()=>selectApps(input));
});
