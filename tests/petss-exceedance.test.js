"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {parseStationCsv,forecastMetadata,forecastCsv,applyForecastAdjustment}=require('../tools/petss-exceedance');
const header='TIME,TIDE,SURGE,TWL,TWL90p,TWL10p';
test('select the exact issued mean, preserving both distinct bounds',()=>{const rows=parseStationCsv(header+'\n202610170600,2,1,3,1.2,5.8');assert.equal(rows[0].twl,3);assert.equal(rows[0].source_twl_mean,3);assert.equal(rows[0].source_twl90p,1.2);assert.equal(rows[0].source_twl10p,5.8);assert.equal(forecastMetadata.forecast_product,'TWL');assert.equal(forecastMetadata.exceedance_probability_percent,null);assert.equal(applyForecastAdjustment(rows)[0].twl,3);assert.match(forecastCsv(rows),/,3,/);});
test('missing mean cannot silently select an exceedance curve',()=>{assert.throws(()=>parseStationCsv('TIME,TWL90p,TWL10p\n202610170600,1,6'),/mean TWL/);assert.throws(()=>parseStationCsv(header+'\n202610170600,2,1,9999,1,6'),/usable mean/);});
test('an unavailable uncertainty column does not discard valid mean guidance',()=>{assert.equal(parseStationCsv('TIME,TWL\n202610170600,3.125')[0].twl,3.125);});
test('reject duplicate valid times and invalid dates, retain zero and negative means',()=>{assert.throws(()=>parseStationCsv(header+'\n202610170600,2,1,3,1,6\n202610170600,2,1,4,1,6'),/Duplicate/);assert.throws(()=>parseStationCsv('TIME,TWL\n202602300600,3'),/usable mean/);const rows=parseStationCsv('TIME,TWL\n202610170600,0\n202610170700,-1.23');assert.deepEqual(rows.map(r=>r.twl),[0,-1.23]);});
