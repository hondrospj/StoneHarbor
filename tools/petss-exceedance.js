"use strict";

// Select NOAA's issued ensemble mean TWL, never a percentile or a locally shifted curve.
function parseStationCsv(text) {
  const lines=String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  const start=lines.findIndex(line=>{const h=line.split(',').map(x=>x.trim().toUpperCase());return h.includes('TIME')&&h.includes('TWL');});
  if(start<0)throw new Error('NOAA station CSV is missing TIME or mean TWL; no percentile fallback is allowed.');
  const header=lines[start].split(',').map(x=>x.trim().toUpperCase()),column=name=>header.indexOf(name);
  const number=value=>{if(value==null||String(value).trim()==='')return null;const n=Number(value);return Number.isFinite(n)&&Math.abs(n)!==9999&&n!==-400?n:null;};
  const rows=[],seen=new Set();
  for(const line of lines.slice(start+1)){
    const values=line.split(',').map(x=>x.trim()),raw=values[column('TIME')];if(!/^\d{12}$/.test(raw||''))continue;
    const t=`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T${raw.slice(8,10)}:${raw.slice(10,12)}:00.000Z`;
    if(!Number.isFinite(Date.parse(t))||new Date(t).toISOString()!==t)continue;
    const mean=number(values[column('TWL')]);if(mean===null)continue;
    if(seen.has(t))throw new Error(`Duplicate NOAA forecast timestamp: ${t}`);seen.add(t);
    rows.push({t,twl:mean,source_twl_mean:mean,source_twl90p:number(values[column('TWL90P')]),source_twl10p:number(values[column('TWL10P')]),tide:number(values[column('TIDE')]),surge:number(values[column('SURGE')]),src_time:raw});
  }
  if(!rows.length)throw new Error('NOAA station CSV has no usable mean TWL values.');
  return rows.sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
}
function forecastCsv(rows){
  const lines=['time_utc_iso,twl_ft_mllw,tide_ft_mllw,surge_ft,src_time,source_mean_ft_mllw,source_twl90p_ft_mllw,source_twl10p_ft_mllw'];
  for(const r of rows)lines.push([r.t,r.twl,r.tide??'',r.surge??'',r.src_time,r.source_twl_mean,r.source_twl90p??'',r.source_twl10p??''].join(','));
  return lines.join('\n')+'\n';
}
// Compatibility export for the North Wildwood updater; the operational curve stays unadjusted.
const FORECAST_ADJUSTMENT_FT=0;
function applyForecastAdjustment(rows){return rows.map(row=>{if(!Number.isFinite(row.source_twl_mean))throw new Error('Missing raw NOAA mean TWL.');return {...row,twl:row.source_twl_mean,forecast_adjustment_ft:0};});}
const forecastMetadata=Object.freeze({forecast_product:'TWL',forecast_statistic:'ensemble_mean',exceedance_probability_percent:null,non_exceedance_percentile:null,custom_bias_correction:false,forecast_adjustment_ft:0,percentile_method:'NOAA-published-ensemble-mean-TWL',notes:'NOAA PETSS ensemble mean total water level (TWL). Issued values are retained without local adjustment, percentile estimation or observation alignment.'});
module.exports={parseStationCsv,forecastCsv,applyForecastAdjustment,forecastMetadata,FORECAST_ADJUSTMENT_FT};
