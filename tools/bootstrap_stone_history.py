#!/usr/bin/env python3
"""One-time conversion of independently audited Stone Harbor tide-cycle records.
The raw source hashes and calibration evidence are retained in the repository.
No daily maxima are accepted as substitute tide observations.
"""
import argparse,csv,gzip,hashlib,json,math
from collections import Counter,defaultdict
from datetime import datetime,timezone
from pathlib import Path
from zoneinfo import ZoneInfo
TZ=ZoneInfo('America/New_York')
def dt(s):return datetime.fromisoformat(s.replace('Z','+00:00'))
def iso(s):return dt(s).astimezone(timezone.utc).isoformat().replace('+00:00','Z')
def local(s):return dt(s).astimezone(TZ)
def loadcsv(p):
 with (gzip.open(p,'rt') if str(p).endswith('.gz') else open(p)) as f:return list(csv.DictReader(f))
def main():
 p=argparse.ArgumentParser();p.add_argument('--cycles',required=True);p.add_argument('--grid',required=True);p.add_argument('--metadata',required=True);p.add_argument('--output',required=True);a=p.parse_args()
 inputs=[Path(a.cycles),Path(a.grid),Path(a.metadata)];rows=loadcsv(inputs[0]);grid=loadcsv(inputs[1]);meta=json.loads(inputs[2].read_text());events=[]
 for r in rows:
  primary=r['source']=='stone';backup=r['source']=='lewes';official=not(primary or backup);date=r['local_date'];year,month,day=map(int,date.split('-'))
  timed=bool(r['cycle_time']);anchor=iso(r['cycle_time']) if timed else None
  e={'cycleId':'8557380@'+anchor if timed else 'official:'+r['crest_id'],
     't':iso(r['peak_time']) if r['peak_time'] and not official else None,'ft':float(r['height_ft']),
     'crest':anchor,'kind':'HighTide','sourceRole':'primary' if primary else 'backup' if backup else 'official-crest',
     'historyAgency':'USGS' if primary or official else 'NOAA','source':'USGS 01411360' if primary else 'NOAA 8557380 calibrated gap fill' if backup else r['source'],
     'localDate':date,'y':year,'m':month,'d':day,'modelEligible':primary,
     'windowStart':iso(r['start']) if r['start'] else None,'windowEnd':iso(r['end']) if r['end'] else None}
  if official:e.update(timeUnknown=True,officialCrestOverride=True,officialCrestOnly=not timed,officialCrestSourceSite=r['source'].rsplit(' ',1)[-1],officialId=r['crest_id'])
  events.append(e)
 assert len({e['cycleId'] for e in events})==len(events)
 latest=max(dt(r['end']) for r in rows if r['end'])
 # Use only windows completed in the verified source pull, not future predictions.
 expected=[r for r in grid if 1919<=local(r['cycle_time']).year<=2026 and dt(r['end'])<=latest]
 full=Counter(local(r['cycle_time']).year for r in grid if 1919<=local(r['cycle_time']).year<=2026)
 accepted={e['cycleId']:e for e in events if e['crest']}
 annual=defaultdict(Counter);months=defaultdict(Counter)
 for r in expected:
  t=local(r['cycle_time']);year=t.year;key=(t.year,t.month);event=accepted.get('8557380@'+iso(r['cycle_time']))
  for dest,k in [(annual,year),(months,key)]:
   dest[k]['expectedCycles']+=1
   if event:
    dest[k]['acceptedCycles']+=1
    if event['sourceRole']=='primary':dest[k]['primaryCycles']+=1
    elif event['sourceRole']=='backup':dest[k]['backupCycles']+=1
    else:dest[k]['officialCycles']+=1
 coverage=[];monthly=[]
 for y,c in sorted(annual.items()):
  c=dict(c);c['acceptedCycles']=c.get('acceptedCycles',0);c['primaryCycles']=c.get('primaryCycles',0)
  c['missingCycles']=c['expectedCycles']-c['acceptedCycles']
  coverage.append({'year':y,**c,'fullYearExpectedCycles':full[y],'status':'ytd' if y==2026 else 'complete' if not c['missingCycles'] else 'partial' if c['acceptedCycles'] else 'unavailable'})
 for (y,m),c in sorted(months.items()):
  c=dict(c);c['acceptedCycles']=c.get('acceptedCycles',0);c['primaryCycles']=c.get('primaryCycles',0);c['missingCycles']=c['expectedCycles']-c['acceptedCycles'];monthly.append({'year':y,'month':m,**c})
 data={'schema':'shorelysafe-high-tide-events-v3','method':'individual_high_tides_v3','countUnit':'individual-high-tide','site':'01411360','parameterCd':'72279','datum':'NAVD88',
       'thresholdsNAVD88':{'minorLow':3.44,'moderateLow':4.44,'majorLow':5.44},'clockStation':'8557380','generatedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
       'lastProcessedISO':latest.astimezone(timezone.utc).isoformat().replace('+00:00','Z'),
       'sourcePriority':['qualified-primary-usgs','flooding-high-tide-calibrated-lewes-gap-only','supported-official-crest-gap-only'],
       'backup':{'agency':'NOAA','site':'8557380','biasCorrectionFt':meta['backup']['correction_ft'],'fit':meta['calibration']},
       'qualityRules':{'minimumOccupiedHourlyFraction':.9,'requiredCentralHours':6,'minimumPeakEdgeHours':1,'completeWindowsOnly':True,'timeZone':'America/New_York','coverageDateBasis':'predicted-high anchor; event count date is actual peak date or documented crest date'},
       'coverage':coverage,'monthlyCoverage':monthly,'events':sorted(events,key=lambda e:(e['localDate'],e['t'] or '',e['cycleId']))}
 out=Path(a.output);out.write_text(json.dumps(data,separators=(',',':'))+'\n')
 provenance={'bootstrapInputs':[{'name':x.name,'sha256':hashlib.sha256(x.read_bytes()).hexdigest()} for x in inputs],
             'reference':meta['reference'],'backup':meta['backup'],'method':meta['method'],'calibration':meta['calibration'],
             'supportedNearbyCrestTransfers':meta['nearby_crest_calibration'],'crestAudit':meta['official_crest_audit'],'primaryIntegrity':meta['primary_integrity'],'sources':meta['sources'],'limitations':meta['limitations']}
 (out.parent/'high_tide_provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
 n=Counter(e['y'] for e in events if e['ft']>=3.44-1e-9)
 assert n[2026]==36 and n[2024]==62 and n[2023]==38 and n[2025]==38
 print(json.dumps({'events':len(events),'bytes':out.stat().st_size,'yearCounts':{y:n[y] for y in range(2018,2027)},'completePrimaryYears':[r['year'] for r in coverage if r['primaryCycles']==r['fullYearExpectedCycles']]},indent=2))
if __name__=='__main__':main()
