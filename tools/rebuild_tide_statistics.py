#!/usr/bin/env python3
"""Rebuild every stored count/model from canonical individual high tides.

Python standard library only. Independent sea-level trajectories are inputs, not
refitted from flood counts. A source hash binds every result to its tide archive.
"""
from __future__ import annotations
import argparse
from bisect import bisect_left
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics
from zoneinfo import ZoneInfo

TZ = ZoneInfo('America/New_York')
EPS = 1e-9

def instant(value):
    if not isinstance(value,str) or not value.strip(): return None
    try: return datetime.fromisoformat(value.replace('Z','+00:00')).astimezone(timezone.utc)
    except ValueError: return None

def atomic(path, data):
    path=Path(path); temp=path.with_name(path.name+'.tmp')
    temp.write_text(data); os.replace(temp,path)

def number(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)

def category(ft, thresholds):
    if ft >= thresholds['majorLow']-EPS: return 'major'
    if ft >= thresholds['moderateLow']-EPS: return 'moderate'
    if ft >= thresholds['minorLow']-EPS: return 'minor'
    return None

def event_date(event):
    date=event.get('localDate')
    if isinstance(date,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}',date): return date
    time=instant(event.get('t'))
    return time.astimezone(TZ).date().isoformat() if time else None

def unique_events(cache):
    if cache.get('countUnit')!='individual-high-tide' or cache.get('method')!='individual_high_tides_v3':
        raise ValueError('Canonical v3 individual-high-tide archive required; daily maxima cannot be inferred into tides.')
    byid={}
    for event in cache.get('events',[]):
        key=event.get('cycleId'); ft=event.get('ft'); date=event_date(event)
        if not isinstance(key,str) or not key or not number(ft) or abs(ft)>=100 or not date:
            raise ValueError('Invalid cycle identity, elevation, or local date.')
        if event.get('kind') not in ['HighTide','OfficialCrest']: raise ValueError('Legacy non-tide event in canonical archive.')
        if event.get('timeUnknown') is not True and instant(event.get('t')) is None:
            raise ValueError('Measured tide lacks a real observation time.')
        if key in byid:
            raise ValueError('Duplicate cycle identity: '+key)
        byid[key]=event
    return list(byid.values())

def binomial_quantiles(n,p,levels=(.05,.5,.95)):
    if n<0 or not 0<=p<=1: raise ValueError('Invalid binomial parameters.')
    if p==0: return [0]*len(levels)
    if p==1: return [n]*len(levels)
    # Log PMF avoids underflow from starting at p(0) when p is near one.
    logs=[math.lgamma(n+1)-math.lgamma(k+1)-math.lgamma(n-k+1)+k*math.log(p)+(n-k)*math.log1p(-p) for k in range(n+1)]
    peak=max(logs); weights=[math.exp(x-peak) for x in logs]; total=math.fsum(weights)
    result=[]; cumulative=0.; j=0
    for k,w in enumerate(weights):
        cumulative += w/total
        while j<len(levels) and cumulative >= levels[j]-1e-14:
            result.append(k); j+=1
    return result+[n]*(len(levels)-len(result))

def year_fraction(t):
    start=datetime(t.year,1,1,tzinfo=timezone.utc); end=datetime(t.year+1,1,1,tzinfo=timezone.utc)
    return t.year+(t-start).total_seconds()/(end-start).total_seconds()

def rebuild(cache,previous_future,projections,cache_hash):
    events=unique_events(cache); T=cache['thresholdsNAVD88']; byyear=defaultdict(Counter); nbyyear=Counter(); agencies=defaultdict(Counter)
    for event in events:
        date=event_date(event); year=int(date[:4]); nbyyear[year]+=1
        cat=category(event['ft'],T)
        if cat: byyear[year][cat]+=1
        agencies[year][event.get('sourceRole','unknown')]+=1
    coverage={int(x['year']):x for x in cache.get('coverage',[]) if 'year' in x}
    years=sorted(set(coverage)|set(nbyyear))
    annual=[]
    for year in years:
        c=coverage.get(year,{})
        available=nbyyear[year]>0
        record={'year':year,**{k:byyear[year][k] if available else None for k in ['minor','moderate','major']},
                'total':sum(byyear[year].values()) if available else None,
                'acceptedCycles':c.get('acceptedCycles',nbyyear[year]),'expectedCycles':c.get('expectedCycles'),
                'missingCycles':c.get('missingCycles'),'sourceRoles':dict(agencies[year]),
                'status':c.get('status','available-records' if available else 'unavailable')}
        annual.append(record)
    annual_payload={'schema':'individual-high-tide-counts-v3','countUnit':'individual-high-tide','sourceSHA256':cache_hash,'station':annual,'fallback':[],
                    'method':'One count per canonical tide cycle at or above the local gauge threshold; incomplete periods are available-record counts, never annualized.'}
    origin=int(projections.get('originYear',projections.get('rebaseYear',datetime.now(TZ).year)))
    slope=float(projections.get('baseline',{}).get('trendFtPerYear',previous_future.get('trendFtPerYear',0)))
    # Keep qualified measured tides even in years with a few missing cycles.
    # Requiring 100% complete years selectively discards real extreme storms.
    # Exclude the first (partial) primary archive year and unfinished target year,
    # then standardize month-specific probabilities by EXPECTED tide exposure.
    primary_events=[e for e in events if e.get('sourceRole')=='primary' and e.get('modelEligible') is True
                    and not e.get('timeUnknown') and not e.get('officialCrestOverride')
                    and instant(e.get('t')) is not None and instant(e.get('crest')) is not None]
    if not primary_events: raise ValueError('No measured primary tide archive.')
    first_year=min(instant(e['crest']).astimezone(TZ).year for e in primary_events)
    training_years=sorted({instant(e['crest']).astimezone(TZ).year for e in primary_events
                           if first_year < instant(e['crest']).astimezone(TZ).year < origin})
    if not training_years: raise ValueError('No completed primary-gauge training years after the partial first year.')
    eligible=[]; monthly_residuals=defaultdict(list)
    for event in primary_events:
        anchor=instant(event['crest']).astimezone(TZ); actual=instant(event['t'])
        if anchor.year not in training_years: continue
        eligible.append((event,actual))
        monthly_residuals[anchor.month].append(event['ft']-slope*(year_fraction(actual)-origin))
    if len(eligible)<600: raise ValueError('Insufficient qualified primary high tides for annual count projections.')
    for values in monthly_residuals.values(): values.sort()
    exposure=Counter()
    for row in cache.get('monthlyCoverage',[]):
        if int(row['year']) in training_years: exposure[int(row['month'])]+=int(row['expectedCycles'])
    if any(not exposure[m] or not monthly_residuals[m] for m in range(1,13)):
        raise ValueError('Every calendar month requires both expected exposure and measured primary training tides.')
    weights={m:exposure[m]/sum(exposure.values()) for m in range(1,13)}
    draws=int(round(statistics.median(coverage[y].get('fullYearExpectedCycles',coverage[y]['expectedCycles']) for y in training_years)))
    bounds=[T['minorLow'],T['moderateLow'],T['majorLow']]
    forecasts={}
    for scenario in projections.get('scenarios',[]):
        records=[]
        for point in scenario.get('points',[]):
            year=int(point['year']); delta=float(point['ft'])
            exceed=[sum(weights[m]*(len(monthly_residuals[m])-bisect_left(monthly_residuals[m],b-delta-EPS))/len(monthly_residuals[m]) for m in range(1,13)) for b in bounds]
            probs={'minor':max(0.,exceed[0]-exceed[1]),'moderate':max(0.,exceed[1]-exceed[2]),'major':exceed[2],'total':exceed[0]}
            row={'year':year,'seaLevelDeltaFt':delta,'drawsPerYear':draws}
            for kind,p in probs.items():
                mean=round(draws*p,6); q05,q50,q95=binomial_quantiles(draws,p)
                row.update({kind+'Mean':mean,kind+'P05':q05,kind+'P50':q50,kind+'P95':q95,
                            kind+'Minus':round(max(0.,mean-q05),6),kind+'Plus':round(max(0.,q95-mean),6)})
                row[kind+'Spread']=f'-{row[kind+"Minus"]:g} / +{row[kind+"Plus"]:g} tides'
            assert sum(row[k+'Mean'] for k in ['minor','moderate','major'])<=draws+1e-6
            assert abs(sum(row[k+'Mean'] for k in ['minor','moderate','major'])-row['totalMean'])<2e-6
            records.append(row)
        forecasts[scenario['id']]=records
    future={'schema':'individual-high-tide-projections-v3','source':'canonical_primary_high_tides_v3','countUnit':'individual-high-tide','status':'generated',
            'sourceSHA256':cache_hash,'highTideCount':len(eligible),'trainingYears':training_years,'excludedFirstPrimaryYear':first_year,'monthlyTrainingHighTides':{str(m):len(monthly_residuals[m]) for m in range(1,13)},'monthlyExpectedWeights':weights,'drawsPerYear':draws,'trendFtPerYear':slope,
            'trendSource':{'file':'sea_level_projections.json','sourceStation':projections.get('sourceStation'),'method':projections.get('baseline',{}).get('trendMethod'),'independentOfFloodCounts':True},
            'method':{'count':'individual astronomical high-tide cycles','training':'Qualified measured primary tides in completed calendar years after the first partial archive year; probability fitted by calendar month and standardized by expected astronomical tide exposure. Unobserved cycles are not zeros. Current partial year, backup estimates and selected official-crest supplements excluded.',
                      'detrending':f'measured height - independent relative-sea-level trend * (event decimal year - {origin})',
                      'futureFit':'Month-stratified empirical detrended high-tide exceedance, weighted by full-calendar expected tide exposure, under existing gauge sea-level scenarios.',
                      'uncertainty':'Analytical binomial planning approximation using seasonally standardized annual probabilities. Exact binomial marginal quantiles conditional on that iid approximation; total intervals use total exceedance probability, never sums of category intervals. Excludes storm clustering, probability-estimation uncertainty, and sea-level-scenario uncertainty.',
                      'annualDraws':'Median full-calendar expected predicted-high count in completed training years; fixed annual planning draw count.',
                      'bins':'Exclusive minor/moderate/major; total equals their sum.'},'scenarios':forecasts}
    return annual_payload,future

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--cache',default='data/peaks_navd88.json');parser.add_argument('--output-dir',default='data');parser.add_argument('--index',default='index.html');parser.add_argument('--skip-index',action='store_true');args=parser.parse_args()
    cache_path=Path(args.cache);out=Path(args.output_dir);raw=cache_path.read_bytes(); cache=json.loads(raw)
    previous=json.loads((out/'future_flood_counts.json').read_text());projections=json.loads((out/'sea_level_projections.json').read_text())
    annual,future=rebuild(cache,previous,projections,hashlib.sha256(raw).hexdigest())
    annual_bytes=json.dumps(annual,separators=(',',':'))+'\n'; future_bytes=json.dumps(future,separators=(',',':'))+'\n'
    index_bytes=None
    if not args.skip_index:
        index=Path(args.index).read_text()
        index,n=re.subn(r'^const FUTURE_FLOOD_PREDICTIONS = .*;$','const FUTURE_FLOOD_PREDICTIONS = '+json.dumps(future['scenarios'],separators=(',',':'))+';',index,flags=re.M)
        if n!=1: raise ValueError('Expected one embedded future tide-count dataset.')
        # No unrelated station count fallback survives alongside canonical history.
        index=re.sub(r'^const ATLANTIC_CITY_ANNUAL_COUNTS = .*;$','const ATLANTIC_CITY_ANNUAL_COUNTS = [];',index,flags=re.M)
        index_bytes=index
    atomic(out/'annual_flood_counts.json',annual_bytes);atomic(out/'future_flood_counts.json',future_bytes)
    if index_bytes is not None:atomic(args.index,index_bytes)
    print(json.dumps({'countUnit':cache['countUnit'],'events':len(cache['events']),'trainingYears':future['trainingYears'],'modelHighTides':future['highTideCount'],
                      'drawsPerYear':future['drawsPerYear'],'baseline2026':future['scenarios'].get('Baseline',[None])[0],
                      'recentObserved':annual['station'][-4:],'sourceSHA256':future['sourceSHA256']},indent=2))
if __name__=='__main__':main()
