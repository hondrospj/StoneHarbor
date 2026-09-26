const test = require("node:test");
const assert = require("node:assert/strict");
const {fetchObservations} = require("../tools/usgs-observations");
const config = {site:"01411360", parameter:"72279", startISO:"2026-09-26T00:00:00Z", endISO:"2026-09-27T00:00:00Z", warn() {}};
const feature = (time, value, fields={}) => ({properties:{monitoring_location_id:"USGS-01411360",parameter_code:"72279",unit_of_measure:"ft",time,value,...fields}});
const response = json => ({ok:true,json:async()=>json});

test("reads all pages, preserves NAVD88 values, and rejects wrong units, station, parameter and missing values", async()=>{
  let calls=0;
  const rows=await fetchObservations({...config,fetchImpl:async url=>{
    calls++;
    if(calls===2) {
      assert.equal(new URL(url).searchParams.get("offset"),"2");
      return response({features:[feature("2026-09-26T13:36:00Z","5.78"),feature("2026-09-26T13:42:00Z","5.78")],links:[]});
    }
    assert.equal(new URL(url).searchParams.get("parameter_code"),"72279");
    return response({features:[feature("2026-09-26T13:42:00Z","5.78"),feature("2026-09-26T13:48:00Z",null),
      feature("2026-09-26T13:48:00Z",""),feature("2026-09-26T13:48:00Z","99",{unit_of_measure:"m"}),
      feature("2026-09-26T13:48:00Z","99",{parameter_code:"00065"}),feature("2026-09-26T13:48:00Z","99",{monitoring_location_id:"USGS-other"}),
      feature("invalid","99"),feature("2026-09-25T13:36:00Z","99"),feature("2026-09-26T13:48:00Z","-999999")],
      links:[{rel:"next",href:"?offset=2"}]});
  }});
  assert.equal(calls,2);
  assert.deepEqual(rows,[{t:"2026-09-26T13:36:00.000Z",ft:5.78},{t:"2026-09-26T13:42:00.000Z",ft:5.78}]);
});

test("falls back to the matching legacy NAVD88 series when the current service fails", async()=>{
  let calls=0;
  const rows=await fetchObservations({...config,fetchImpl:async url=>{
    if(++calls===1)return {ok:false,status:503};
    assert.equal(new URL(url).hostname,"waterservices.usgs.gov");
    return response({value:{timeSeries:[{sourceInfo:{siteCode:[{value:"01411360"}]},
      variable:{variableCode:[{value:"72279"}],unit:{unitCode:"ft"},noDataValue:-999999},
      values:[{value:[{dateTime:"2026-09-26T13:36:00Z",value:"5.78"},{dateTime:"2026-09-26T13:42:00Z",value:"-999999"}]}]}]}});
  }});
  assert.deepEqual(rows,[{t:"2026-09-26T13:36:00.000Z",ft:5.78}]);
});

test("does not return partial observations when pagination and the fallback fail",async()=>{
  let calls=0;
  await assert.rejects(fetchObservations({...config,fetchImpl:async()=>{
    if(++calls===1)return response({features:[feature("2026-09-26T13:36:00Z","5.78")],links:[{rel:"next",href:"?offset=1"}]});
    return {ok:false,status:503};
  }}),/Both USGS observation feeds failed/);
});
