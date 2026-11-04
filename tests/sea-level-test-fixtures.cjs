"use strict";
// Unmodified selected MSL values from NOAA monthly_mean station8557380,
// retrieved November3,2026. The sparse subset deliberately keeps real gaps.
const monthlyMeanResponse={
  metadata:{id:"8557380",name:"Lewes",lat:"38.7828",lon:"-75.1193"},
  data:[
    {year:"2013",month:"11",MSL:"0.0"},
    {year:"2026",month:"1",MSL:"-0.043"},
    {year:"2026",month:"3",MSL:"0.203"},
    {year:"2026",month:"7",MSL:"0.758"},
    {year:"2026",month:"10",MSL:"1.161"}
  ]
};
function dailyPayload(rows){
  return {value:{timeSeries:[{sourceInfo:{siteCode:[{value:"01411360"}]},
    variable:{variableCode:[{value:"72279"}],unit:{unitCode:"ft"},noDataValue:-999999},
    values:[{value:rows.map(row=>({dateTime:row.t||row.date,value:String(row.ft)}))}]}]}};
}
module.exports={monthlyMeanResponse,dailyPayload};
