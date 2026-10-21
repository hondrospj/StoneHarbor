import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const files=process.argv.slice(2);let total=0;const results=[];
for(const file of files){
 const source=fs.readFileSync(file,'utf8');let checks=0;
 function extract(name){
  const matches=[...source.matchAll(new RegExp('(?:async\\s+)?function\\s+'+name+'\\s*\\(','g'))];
  assert(matches.length,`missing ${name}`);const start=matches.at(-1).index;
  for(let end=source.indexOf('}',start);end>=0;end=source.indexOf('}',end+1)){
   const c=source.slice(start,end+1);try{new vm.Script('('+c+')');return c;}catch{}
  }throw Error(name);
 }
 let payload;
 const ctx={URL,Date,WEST_WILDWOOD_CONTROL_STATION:'8534720',WEST_WILDWOOD_HIGH_TIME_OFFSET_MINUTES:57,WEST_WILDWOOD_HIGH_HEIGHT_FACTOR:1.04,COOPS_APP:'regression',USGS_SITE:'test',USGS_PARAM_PRIMARY:'62620',NOAA_SEA_LEVEL_STATION_CANDIDATES:['test'],SEA_LEVEL_HISTORY_BEGIN_DATE:'19000101',nowISO:()=> '2026-10-21T00:00:00Z',ymdCompactFromISO:()=> '20261021',isoFromNOAAPoint:t=>t.replace(' ','T')+':00Z',fetchWithTimeout:async()=>({ok:true,json:async()=>payload})};
 vm.createContext(ctx);
 for(const f of ['dashboardGaugeNumber','dashboardNoaaTimeIsValid','normalizePetssJsonToPoints','fetchNOAAHiloHighs','fetchUSGSDailySeaLevel','fetchNOAAMonthlySeaLevel'])vm.runInContext(extract(f),ctx);
 const check=(label,fn)=>{fn();checks++;};
 const valid=[{t:'2026-10-21T00:00:00Z',source_twl_mean:0,twl:9},{t:'2026-10-21T01:00:00Z',source_twl_mean:'-1.25',twl:9},{t:'2026-10-21T02:00:00Z',twl:2.75}];
 const parsed=ctx.normalizePetssJsonToPoints({points:[null,undefined,[],42,'bad',...valid,{t:'2026-10-21T03:00:00Z',twl:[]},{t:'2026-10-21T03:00:00Z',twl:true},{t:'bad date',twl:4}]});
 check('forecast null/object guards retain mean and actual zero',()=>assert.deepEqual(Array.from(parsed,p=>p.ft),[0,-1.25,2.75]));
 const baseline=ctx.normalizePetssJsonToPoints({points:valid});
 check('valid forecast scalar/clock values unchanged',()=>assert.deepEqual(Array.from(parsed,p=>[p.t,p.ft,p.minFt,p.maxFt]),Array.from(baseline,p=>[p.t,p.ft,p.minFt,p.maxFt])));
 payload={predictions:[null,{type:'H',t:'2026-02-31 01:00',v:8},{type:'H',t:'bad',v:9},{type:'H',t:'2026-10-21 24:00',v:10},{type:'H',t:'2026-10-21 00:00',v:''},{type:'H',t:'2026-10-21 01:00',v:null},{type:'L',t:'2026-10-21 02:00',v:4},{type:'H',t:'2026-10-21 03:00',v:'0'},{type:'H',t:'2026-10-21 04:00',v:'7.5'}]};
 const hilo=await ctx.fetchNOAAHiloHighs({station:'test',beginYMD:'20261021',endYMD:'20261022'});
 check('one invalid NOAA high clock cannot discard valid batch',()=>assert.deepEqual(Array.from(hilo,p=>p.ft),[0,7.5]));
 check('NOAA high clocks canonical UTC',()=>assert.deepEqual(Array.from(hilo,p=>p.t),['2026-10-21T03:00:00.000Z','2026-10-21T04:00:00.000Z']));
 payload={value:{timeSeries:[{variable:{noDataValue:-9},values:[{value:[null,{dateTime:'bad date',value:'3'},{dateTime:'2026-10-21T01:00:00Z',value:''},{dateTime:'2026-10-21T02:00:00Z',value:-9},{dateTime:'2026-10-21T03:00:00Z',value:'0'},{dateTime:'2026-10-21T04:00:00Z',value:'-1.25'}]}]}]}};
 const daily=await ctx.fetchUSGSDailySeaLevel();
 check('USGS declared finite sentinel and invalid times excluded',()=>assert.deepEqual(Array.from(daily,p=>p.ft),[0,-1.25]));
 payload={data:[null,{year:2026,month:0,MSL:1},{year:2026,month:13,MSL:1},{year:2026,month:1.5,MSL:1},{year:'',month:1,MSL:1},{year:2026.5,month:1,MSL:1},{year:2026,month:1,MSL:null},{year:2026,month:1,MSL:''},{year:2026,month:1,MSL:[]},{year:2026,month:1,MSL:'0'},{year:'2026',month:'2',MSL:'-0.1'},{year:2026,month:3,MSL:0.2}]};
 const monthly=await ctx.fetchNOAAMonthlySeaLevel();
 check('monthly means retain actual zero, drop missing and invalid calendar fields',()=>assert.deepEqual(Array.from(monthly,p=>p.ft),[0,-.1,.2]));
 check('monthly means have real canonical UTC clocks',()=>assert.deepEqual(Array.from(monthly,p=>p.t),['2026-01-15T00:00:00Z','2026-02-15T00:00:00Z','2026-03-15T00:00:00Z']));
 // Compile every actual inline script, catching syntax and accidental edit damage.
 let scripts=0;for(const m of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(m[2].trim()&&!/application\/(?:ld\+)?json/.test(m[1])){new vm.Script(m[2]);scripts++;}
 check('all scripts compile',()=>assert(scripts>0));
 total+=checks;results.push({source:file,sha256:crypto.createHash('sha256').update(source).digest('hex'),checks,scripts,passed:true});
}
console.log(JSON.stringify({files:results,totalChecks:total,passed:true},null,2));
