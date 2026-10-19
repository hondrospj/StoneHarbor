import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const requested=process.argv[2];
const sourcePath=requested || ['index.html','site/flooddashboard/index.html'].find(p=>fs.existsSync(p)&&fs.readFileSync(p,'utf8').includes('function normalizePetssJsonToPoints'));
const source=fs.readFileSync(sourcePath,'utf8');
function extract(name){
  const matches=[...source.matchAll(new RegExp('(?:async\\s+)?function\\s+'+name+'\\s*\\(','g'))];
  assert(matches.length,'Missing function '+name);
  const start=matches.at(-1).index;
  for(let end=source.indexOf('}',start);end>=0;end=source.indexOf('}',end+1)){
    const candidate=source.slice(start,end+1);
    try{new vm.Script('('+candidate+')');return candidate;}catch{}
  }
  throw new Error('Could not parse '+name);
}

let checks=0;
function check(name,fn){fn();checks++;}
const node=()=>({textContent:'',value:'',style:{}});
const state={lastNavd:{t:'2026-10-19T12:00:00Z',ft:2},todayNavd:[{t:'2026-10-19T12:00:00Z',ft:2}]};
const context={console,URL,Date,AbortController,setTimeout,clearTimeout,STATE:state,liveFeedLabel:()=> 'NOAA',
  classifyByNavd:()=>({short:'minor',color:'yellow',glow:'gold'}),fmtESTFull:t=>t,fmtESTTime:t=>t,
  hoursSinceISO:()=>0,lastPill:node(),stageTextEl:node(),stageDotEl:node(),setStage:()=>{context.stageTextEl.textContent='FRESH';},
  DATUMS:['MLLW','NAVD88'],THRESH:{MLLW:{minorLow:6},NAVD88:{minorLow:4}},
  DISPLAY_DATUM:'MLLW',datumSelect:node(),minElevEl:Object.assign(node(),{value:'6'}),maxElevEl:node(),
  datumToDatum:v=>v,toDisplayFtFromNavd:v=>v,curFtEl:node(),dayMaxFtEl:node(),dayMinFtEl:node(),dayMaxWhenEl:node(),dayMinWhenEl:node(),
  maxPoint:points=>points.reduce((a,b)=>a.ft>b.ft?a:b),minPoint:points=>points.reduce((a,b)=>a.ft<b.ft?a:b),
  USGS_SITE:'TEST',NorthWildwoodStoneHarbor:{stationId:'STONE-HARBOR',adjustValue:v=>v+1},USGS_PARAM_PRIMARY:'62620',NOAA_STATION_CANDIDATES:['TEST'],NOAA_OBS_STATION:'TEST',COOPS_STATION:'TEST',COOPS_APP:'regression',
  startOfUTCDate:d=>new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())),addDaysUTC:(d,n)=>new Date(d.getTime()+n*86400000),
  yyyymmddUTC:d=>d.toISOString().slice(0,10).replaceAll('-',''),startFromPeriod:()=> '2026-10-19T00:00:00Z',isoFromNOAAPoint:t=>String(t||'').replace(' ','T')+':00Z'};
for(const fn of ['refreshDOYFromHistory','updateUnitsAndBadges','applyFilter','updateMonthAveragesFromHistory','renderAnnual','setCurrentNumberColorByNavd','updateTsChartFromState','updateFloodOutlook48'])context[fn]=()=>{};
vm.createContext(context);
for(const name of ['dashboardGaugeNumber','dashboardNoaaTimeIsValid','renderLiveReadingStatus','extractWaterLevelSeries_NAVD88','fetchNOAAObservedSeries','normalizePetssJsonToPoints','setDatum'])vm.runInContext(extract(name),context);

for(const value of [null,undefined,'','  ',true,false,{},[],NaN,Infinity,-Infinity,'not a number']){
  check('reject invalid gauge scalar',()=>assert(Number.isNaN(context.dashboardGaugeNumber(value))));
}
for(const value of [0,'0',-1.25,'-1.25',2.75,'2.75'])check('retain valid gauge scalar',()=>assert.equal(context.dashboardGaugeNumber(value),Number(value)));
check('reject declared USGS sentinel',()=>assert(Number.isNaN(context.dashboardGaugeNumber('-999999','-999999'))));
check('zero sentinel honored when declared',()=>assert(Number.isNaN(context.dashboardGaugeNumber(0,0))));
for(const t of ['bad date','2026-02-31 00:00','2026-10-19 24:00'])check('reject malformed NOAA clock',()=>assert.equal(context.dashboardNoaaTimeIsValid(t),false));
const usgs={value:{timeSeries:[{variable:{variableCode:[{value:'62620'}],unit:{unitCode:'ft'},noDataValue:-999999},values:[{value:[
  {dateTime:'2026-10-19T00:00:00Z',value:''},{dateTime:'2026-10-19T00:06:00Z',value:null},
  {dateTime:'2026-10-19T00:12:00Z',value:'-999999'},{dateTime:'bad date',value:'3'},
  {dateTime:'2026-10-19T00:18:00Z',value:'0'},{dateTime:'2026-10-19T00:24:00Z',value:'-1.25'}]}]}]}};
check('actual USGS reader keeps only valid timed observations',()=>assert.deepEqual(Array.from(context.extractWaterLevelSeries_NAVD88(usgs),p=>p.ft),[0,-1.25]));
const noaa=[{t:'2026-10-19 00:00',v:''},{t:'2026-10-19 00:06',v:null},{t:'2026-10-19 00:12',v:true},
  {t:'bad date',v:'5'},{t:'2026-10-19 00:18',v:'0'},{t:'2026-10-19 00:24',v:'-1.25'},{t:'2026-10-19 00:30',v:'2.75'}];
context.fetch=async()=>({ok:true,json:async()=>({data:noaa})});
const observed=await context.fetchNOAAObservedSeries({startISO:'2026-10-19T00:00:00Z',endISO:'2026-10-19T01:00:00Z'});
check('actual NOAA reader excludes blanks, nulls, booleans and invalid times',()=>assert.deepEqual(Array.from(observed,p=>p.ft),[0,-1.25,2.75]));
check('PETSS issued mean values unchanged',()=>assert.deepEqual(Array.from(context.normalizePetssJsonToPoints({points:[{t:'2026-10-19T00:00:00Z',source_twl_mean:0,twl:9},{t:'2026-10-19T01:00:00Z',source_twl_mean:2.75,twl:9}]}),p=>p.ft),[0,2.75]));
state.lastObservationIsCachedHighTide=true;context.setDatum('NAVD88');
check('cached label survives datum change',()=>assert.match(context.stageTextEl.textContent,/CACHED HIGH/));
check('cached high tides do not claim a daily minimum',()=>assert.equal(context.dayMinFtEl.textContent,'—'));
check('cached high tides do not claim a minimum timestamp',()=>assert.equal(context.dayMinWhenEl.textContent,'—'));
state.lastObservationIsCachedHighTide=false;context.hoursSinceISO=()=>7;context.setDatum('MLLW');
check('stale reading label survives datum change',()=>assert.equal(context.stageTextEl.textContent,'LIVE DATA STALE'));
context.hoursSinceISO=()=>0;context.setDatum('NAVD88');
check('fresh readings retain normal category',()=>assert.equal(context.stageTextEl.textContent,'FRESH'));
check('valid observed minimum remains displayed',()=>assert.equal(context.dayMinFtEl.textContent,'2.00'));
check('unknown datum is ignored',()=>{const old=context.DISPLAY_DATUM;context.setDatum('UNKNOWN');assert.equal(context.DISPLAY_DATUM,old);});
console.log(JSON.stringify({source:sourcePath,checks,passed:true}));
