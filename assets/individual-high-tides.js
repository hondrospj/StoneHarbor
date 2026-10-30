/* One accepted observed crest per predicted high-tide cycle, shared by every history view. */
(function(root, factory){
  const api = factory();
  if(typeof module === "object" && module.exports) module.exports = api;
  else root.IndividualHighTides = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(){
  "use strict";
  const COUNT_UNIT = "individual-high-tide";
  const METHOD = "individual_high_tides_v3";
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const localFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit"
  });
  function number(value){
    if(value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return NaN;
    return Number(value);
  }
  function parts(event){
    const explicit = String(event?.localDate || "");
    if(DATE.test(explicit)){
      const [year,month,day] = explicit.split("-").map(Number);
      const date = new Date(Date.UTC(year,month-1,day));
      if(date.getUTCFullYear() !== year || date.getUTCMonth()+1 !== month || date.getUTCDate() !== day) return null;
      return {year,month,day};
    }
    if(!event?.t) return null;
    const date = new Date(event.t);
    if(!Number.isFinite(date.getTime())) return null;
    const values = Object.fromEntries(localFormatter.formatToParts(date).map(p=>[p.type,p.value]));
    return {year:Number(values.year),month:Number(values.month),day:Number(values.day)};
  }
  function localDate(event){
    const p = parts(event);
    return p ? `${p.year}-${String(p.month).padStart(2,"0")}-${String(p.day).padStart(2,"0")}` : "";
  }
  // A date anchor is used only for sorting; it is never stored as an observed timestamp.
  function sortTime(event){
    const actual = !event?.timeUnknown && event?.t ? Date.parse(event.t) : NaN;
    return Number.isFinite(actual) ? actual : Date.parse(`${localDate(event)}T12:00:00Z`);
  }
  function priority(event, primaryAgency){
    if(event?.sourceRole === "primary" && !event?.officialCrestOverride) return 70;
    if(event?.officialCrestOverride) return event?.officialCrestExactGauge ? 50 : 40;
    if(event?.sourceRole === "primary" || /primary|exact.gauge/i.test(String(event?.source || ""))) return 30;
    return String(event?.historyAgency || "").toUpperCase() === primaryAgency ? 20 : 10;
  }
  function canonicalEvents(events, options={}){
    const byCycle = new Map();
    const primaryAgency = String(options.primaryAgency || "").toUpperCase();
    for(const event of events || []){
      const cycleId = String(event?.cycleId || "").trim();
      if(!cycleId || event?.legacyDailyPeak || !Number.isFinite(number(event?.ft)) || !parts(event)) continue;
      if(event?.kind !== "HighTide" && !(event?.kind === "OfficialCrest" && (event.officialCrestOverride || event.officialCrestOnly))) continue;
      if(event?.timeUnknown ? !event?.officialCrestOverride && !event?.officialCrestOnly : !event?.t || !Number.isFinite(Date.parse(event.t))) continue;
      const previous = byCycle.get(cycleId);
      const p = priority(event,primaryAgency), previousPriority = priority(previous,primaryAgency);
      if(!previous || p > previousPriority || (p === previousPriority && number(event.ft) > number(previous.ft))){
        byCycle.set(cycleId,event);
      }
    }
    return Array.from(byCycle.values()).sort((a,b)=>sortTime(b)-sortTime(a) || a.cycleId.localeCompare(b.cycleId));
  }
  function normalizeCache(json, options={}){
    if(json?.countUnit !== COUNT_UNIT || json?.method !== METHOD || !Array.isArray(json.events)){
      throw new Error("Individual high-tide history requires the v3 cycle cache; legacy daily peaks cannot be counted.");
    }
    const events = json.events.map(row=>{
      const p = parts(row), ft = number(row?.ft);
      if(!p || !Number.isFinite(ft)) return null;
      const timeUnknown = Boolean(row.timeUnknown);
      const t = timeUnknown ? null : row.t && Number.isFinite(Date.parse(row.t)) ? new Date(row.t).toISOString() : null;
      return {...row, t, ft, y:p.year, m:p.month, d:p.day, localDate:localDate(row),
        timeUnknown, historyAgency:String(row.historyAgency || options.primaryAgency || "").toUpperCase(),
        source:row.historySource ?? row.source ?? "JSON"};
    }).filter(Boolean);
    return canonicalEvents(events,options);
  }
  function yearCounts(events, year, threshold){
    const counts = {minor:0,moderate:0,major:0};
    for(const event of events || []){
      if(parts(event)?.year !== Number(year)) continue;
      const ft = number(event.ft);
      if(ft >= threshold.majorLow) counts.major++;
      else if(ft >= threshold.moderateLow) counts.moderate++;
      else if(ft >= threshold.minorLow) counts.minor++;
    }
    return counts;
  }
  function calendarIndex365(year,month,day){
    // Keep both Feb 28 and Feb 29 counts in the Feb 28 plotting bin.
    if(month === 2 && day === 29) return 58;
    const leap = year%4 === 0 && (year%100 !== 0 || year%400 === 0);
    const idx = Math.floor((Date.UTC(year,month-1,day)-Date.UTC(year,0,1))/86400000) - (leap && month>2 ? 1 : 0);
    return idx >= 0 && idx < 365 ? idx : null;
  }
  function dailyCounts(events, minorThreshold){
    const byYear = new Map();
    for(const event of events || []){
      const p = parts(event), ft = number(event?.ft);
      if(!p || !Number.isFinite(ft)) continue;
      if(!byYear.has(p.year)) byYear.set(p.year,new Array(365).fill(0));
      const idx = calendarIndex365(p.year,p.month,p.day);
      if(idx !== null && ft >= minorThreshold) byYear.get(p.year)[idx]++;
    }
    return byYear;
  }
  function monthlyAverages(events, coverage, threshold, now=new Date()){
    const current = parts({t:now.toISOString()});
    const byMonth = new Map();
    for(const row of coverage || []){
      const year = Number(row?.year), month = Number(row?.month);
      const expected = number(row?.expectedCycles), accepted = number(row?.acceptedCycles);
      if(!Number.isInteger(year) || !Number.isInteger(month) || month<1 || month>12) continue;
      if(!(expected>0 && accepted>=expected)) continue;
      if(year>current.year || (year===current.year && month>=current.month)) continue;
      byMonth.set(`${year}-${month}`,{year,month,total:0,minor:0,moderate:0,major:0,expectedCycles:expected,acceptedCycles:accepted});
    }
    for(const event of events || []){
      const p = parts(event), ft = number(event?.ft);
      const row = p && byMonth.get(`${p.year}-${p.month}`);
      if(!row || !Number.isFinite(ft) || ft<threshold.minorLow) continue;
      row.total++;
      if(ft>=threshold.majorLow) row.major++;
      else if(ft>=threshold.moderateLow) row.moderate++;
      else row.minor++;
    }
    return Array.from({length:12},(_,i)=>{
      const month=i+1, eligible=Array.from(byMonth.values()).filter(row=>row.month===month);
      const mean = field => eligible.length ? eligible.reduce((sum,row)=>sum+row[field],0)/eligible.length : null;
      return {month,avgTotal:mean("total"),avgMinor:mean("minor"),avgModerate:mean("moderate"),avgMajor:mean("major"),years:eligible.length};
    });
  }
  function fitEvents(events){
    return (events || []).filter(event=>!event.timeUnknown && !event.officialCrestOnly && event.modelEligible !== false && event.t && Number.isFinite(Date.parse(event.t)));
  }
  function binomialQuantiles(n,p){
    n=Math.max(0,Math.round(n));p=Math.max(0,Math.min(1,p));
    if(!n || !p) return {p05:0,p50:0,p95:0};
    if(p===1) return {p05:n,p50:n,p95:n};
    const mode=Math.min(n,Math.floor((n+1)*p)),weights=new Array(n+1).fill(0);weights[mode]=1;
    for(let k=mode;k<n;k++) weights[k+1]=weights[k]*(n-k)/(k+1)*p/(1-p);
    for(let k=mode;k>0;k--) weights[k-1]=weights[k]*k/(n-k+1)*(1-p)/p;
    const sum=weights.reduce((a,b)=>a+b,0),levels=[.05,.5,.95],values=[];let cdf=0,j=0;
    for(let k=0;k<=n;k++){cdf+=weights[k]/sum;while(j<levels.length && cdf>=levels[j]-1e-14){values.push(k);j++;}}
    while(values.length<3)values.push(n);
    return {p05:values[0],p50:values[1],p95:values[2]};
  }
  function annualForecast(events,annualCoverage,monthlyCoverage,targetYear,trend,threshold){
    const measured=fitEvents(events).filter(e=>e.sourceRole==='primary' && e.modelEligible===true && e.crest && Number.isFinite(Date.parse(e.crest)));
    const anchorParts=e=>parts({t:e.crest});
    if(!measured.length) return null;
    const firstYear=measured.reduce((first,e)=>Math.min(first,anchorParts(e).year),Infinity);
    const trainingYears=[...new Set(measured.map(e=>anchorParts(e).year).filter(y=>y>firstYear && y<targetYear))].sort((a,b)=>a-b);
    const keep=new Set(trainingYears),byMonth=Array.from({length:13},()=>[]),exposure=new Array(13).fill(0);
    for(const e of measured){
      const anchor=anchorParts(e);if(!keep.has(anchor.year))continue;
      const time=new Date(e.t),y=time.getUTCFullYear(),start=Date.UTC(y,0,1),end=Date.UTC(y+1,0,1);
      const decimalYear=y+(time.getTime()-start)/(end-start);
      byMonth[anchor.month].push(Number(e.ft)-trend*(decimalYear-targetYear));
    }
    for(const row of monthlyCoverage||[])if(keep.has(Number(row.year)))exposure[Number(row.month)]+=Number(row.expectedCycles)||0;
    const coverage=new Map((annualCoverage||[]).map(r=>[Number(r.year),r]));
    const drawValues=trainingYears.map(y=>Number(coverage.get(y)?.fullYearExpectedCycles??coverage.get(y)?.expectedCycles)).filter(n=>Number.isFinite(n)&&n>600).sort((a,b)=>a-b);
    if(!drawValues.length || Array.from({length:12},(_,i)=>i+1).some(m=>!exposure[m] || !byMonth[m].length))return null;
    const mid=drawValues.length>>1,rawDraws=drawValues.length%2?drawValues[mid]:(drawValues[mid-1]+drawValues[mid])/2;
    const floor=Math.floor(rawDraws),draws=rawDraws-floor===.5&&floor%2===0?floor:Math.round(rawDraws);
    const totalExposure=exposure.reduce((a,b)=>a+b,0);
    let probability=0;
    for(let m=1;m<=12;m++)probability+=(exposure[m]/totalExposure)*(byMonth[m].filter(v=>v>=threshold.minorLow-1e-9).length/byMonth[m].length);
    const q=binomialQuantiles(draws,probability);
    return {meanRaw:draws*probability,low:q.p05,high:q.p95,median:q.p50,draws,trainingYears,sourceHighTides:byMonth.reduce((sum,a)=>sum+a.length,0)};
  }

  return {COUNT_UNIT,METHOD,parts,localDate,sortTime,canonicalEvents,normalizeCache,yearCounts,calendarIndex365,dailyCounts,monthlyAverages,fitEvents,binomialQuantiles,annualForecast};
});
