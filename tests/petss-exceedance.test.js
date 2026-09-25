const test = require('node:test');
const assert = require('node:assert/strict');
const {parseStationCsv, forecastMetadata} = require('../tools/petss-exceedance');
const header='TIME,TIDE,TWL,BIAS,TWL90p,TWL10p';
test('selects NOAA lower TWL90p exactly, without applying BIAS, mean, tide or estimated bounds',()=>{
 const rows=parseStationCsv(header+'\n202609250100,2,6,0.75,4.321,8.765\n202609250200,3,7,-1,5.432,9.876');
 assert.deepEqual(rows.map(r=>r.twl),[4.321,5.432]);
 assert.deepEqual(rows.map(r=>r.source_twl90p),[4.321,5.432]);
 assert.equal(rows[0].twl_min,undefined);assert.equal(rows[0].twl_max,undefined);
 assert.equal(forecastMetadata.custom_bias_correction,false);
});
test('missing TWL90p is never replaced by zero, the mean, or the upper curve',()=>{
 for(const value of ['','9999.000','NaN']) assert.throws(()=>parseStationCsv(header+'\n202609250100,2,6,0.75,'+value+',8.765'));
 assert.throws(()=>parseStationCsv('TIME,TWL\n202609250100,6'));
 const rows=parseStationCsv(header+'\n202609250100,2,9999,9999,0,8.765');assert.equal(rows[0].twl,0);
});
test('invalid dates and duplicate times cannot produce invented forecast timestamps',()=>{
 assert.throws(()=>parseStationCsv(header+'\n202602300100,2,6,0,4,8'));
 assert.throws(()=>parseStationCsv(header+'\n202609250100,2,6,0,4,8\n202609250100,2,6,0,5,8'));
});
