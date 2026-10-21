import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const files=process.argv.slice(2);const results=[];let checks=0;
for(const file of files){
 const source=fs.readFileSync(file,'utf8');
 function extract(name){const start=[...source.matchAll(new RegExp('function\\s+'+name+'\\s*\\(','g'))].at(-1)?.index;assert(start!=null,name);for(let end=source.indexOf('}',start);end>=0;end=source.indexOf('}',end+1)){const c=source.slice(start,end+1);try{new vm.Script('('+c+')');return c;}catch{}}throw Error(name)}
 const base=Date.parse('2026-10-21T00:00:00Z'),H=3600000;
 class FixedDate extends Date{static now(){return base;}}
 const node=()=>({textContent:'',innerHTML:'',querySelector:()=>null});
 const ctx={console,Date:FixedDate,THRESH:{MLLW:{minorLow:6,moderateLow:7,majorLow:8}},DISPLAY_DATUM:'MLLW',STATE:{},f48MinorHrsEl:node(),f48ModerHrsEl:node(),f48MajorHrsEl:node(),f48ListEl:node(),f48MetaEl:node(),toDisplayFtFromMllw:x=>x,unitText:()=> 'ft MLLW',fmtNiceDate:x=>x,fmtESTTime:x=>x};vm.createContext(ctx);
 if(source.includes('function petssForecastEndMs('))vm.runInContext(extract('petssForecastEndMs'),ctx);
 for(const f of ['stageNameFromDisplayFt','stageColorVar','interpFtAtMs','isoFromMs','stageRank','splitIntervalByFloodThresholds','buildExactFloodAccounting','updateFloodOutlook48'])vm.runInContext(extract(f),ctx);
 let n=0;const check=(label,f)=>{f();checks++;n++;};
 const pts=rows=>rows.map(([h,ftDisplay])=>({ms:base+h*H,ftDisplay}));
 let a=ctx.buildExactFloodAccounting(pts([[0,5],[1,9],[2,5]]),base,base+2*H);
 check('threshold crossing integrates exact exclusive hours',()=>{assert.equal(a.coveredMs,2*H);assert.equal(a.minorMs,.5*H);assert.equal(a.moderateMs,.5*H);assert.equal(a.majorMs,.5*H);assert.equal(a.segments.length,1)});
 a=ctx.buildExactFloodAccounting(pts([[0,9],[1,9],[10,9],[11,9]]),base,base+72*H);
 check('missing nine-hour bracket contributes no forecast hours',()=>{assert.equal(a.coveredMs,2*H);assert.equal(a.majorMs,2*H)});
 check('flood periods separated by unknown support remain separate',()=>assert.equal(a.segments.length,2));
 ctx.STATE.pred72Mllw=[{t:new Date(base-4*H).toISOString(),ft:9},{t:new Date(base-H).toISOString(),ft:9}];ctx.updateFloodOutlook48();
 check('expired forecast is unavailable, never all-clear or zero flood hours',()=>{assert.equal(ctx.f48MajorHrsEl.textContent,'—');assert.match(ctx.f48ListEl.innerHTML,/Forecast unavailable/);assert.doesNotMatch(ctx.f48ListEl.innerHTML,/flooding free/)});
 ctx.STATE.pred72Mllw=[{t:new Date(base).toISOString(),ft:5},{t:new Date(base+H).toISOString(),ft:5},{t:new Date(base+72*H).toISOString(),ft:5}];ctx.updateFloodOutlook48();
 check('partial quiet forecast explicitly leaves missing hours unknown',()=>{assert.match(ctx.f48ListEl.innerHTML,/1.0 of 72.0 forecast hours/);assert.match(ctx.f48ListEl.innerHTML,/remaining hours are unknown/);assert.doesNotMatch(ctx.f48ListEl.innerHTML,/Next 72 hours stay flooding free/)});
 ctx.STATE.pred72Mllw=Array.from({length:73},(_,i)=>({t:new Date(base+i*H).toISOString(),ft:5}));ctx.updateFloodOutlook48();
 check('complete quiet forecast retains existing all-clear behavior',()=>{assert.match(ctx.f48ListEl.innerHTML,/No flood periods forecast/);assert.doesNotMatch(ctx.f48ListEl.innerHTML,/unknown|Partial forecast/)});
 ctx.STATE.pred72Mllw=[{t:new Date(base).toISOString(),ft:9},{t:new Date(base+H).toISOString(),ft:9},{t:new Date(base+72*H).toISOString(),ft:9}];ctx.updateFloodOutlook48();
 check('partial flood totals labelled as available periods only',()=>{assert.equal(ctx.f48MajorHrsEl.textContent,'1.0');assert.match(ctx.f48ListEl.innerHTML,/Partial forecast coverage/)});
 results.push({source:file,checks:n,passed:true});
}
console.log(JSON.stringify({files:results,totalChecks:checks,passed:true},null,2));
