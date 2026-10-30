"""Independent distribution and persisted-data regressions for tide statistics."""
from pathlib import Path
import hashlib, importlib.util, json, math, unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('tide_statistics',ROOT/'tools/rebuild_tide_statistics.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class TideStatisticsTests(unittest.TestCase):
 def test_binomial_quantiles_against_independent_probability_mass(self):
  # Direct combinatorial PMF is independent of the production log-PMF algorithm.
  for n in [0,1,2,10,100,705,708]:
   for p in [0,.0001,.001,.01,.05,.1,.4,.5,.6,.95,.9999,1]:
    actual=m.binomial_quantiles(n,p)
    mass=[math.comb(n,k)*p**k*(1-p)**(n-k) for k in range(n+1)]
    for alpha,k in zip([.05,.5,.95],actual):
     self.assertGreaterEqual(math.fsum(mass[:k+1])+1e-11,alpha,(n,p,alpha,k))
     self.assertLessEqual(math.fsum(mass[:k])+(-1e-11),alpha,(n,p,alpha,k))
 def test_cache_rejects_legacy_and_duplicate_tide_identity(self):
  e={'cycleId':'clock@2024-01-01T00:00:00Z','t':'2024-01-01T00:00:00Z','ft':4,'localDate':'2023-12-31','kind':'HighTide'}
  with self.assertRaises(ValueError):m.unique_events({'events':[e]})
  with self.assertRaises(ValueError):m.unique_events({'method':'individual_high_tides_v3','countUnit':'individual-high-tide','events':[e,e]})
 def test_persisted_annual_counts_and_training_follow_actual_individual_tides(self):
  raw=(ROOT/'data/peaks_navd88.json').read_bytes();cache=json.loads(raw);future=json.loads((ROOT/'data/future_flood_counts.json').read_text());annual=json.loads((ROOT/'data/annual_flood_counts.json').read_text())
  self.assertEqual(future['sourceSHA256'],hashlib.sha256(raw).hexdigest());self.assertEqual(annual['sourceSHA256'],future['sourceSHA256'])
  self.assertNotIn(2026,future['trainingYears']);training=set(future['trainingYears'])
  source=[e for e in cache['events'] if e.get('sourceRole')=='primary' and e.get('modelEligible') and not e.get('timeUnknown')]
  first=min(m.instant(e['crest']).astimezone(m.TZ).year for e in source);self.assertNotIn(first,training)
  pool=[e for e in source if m.instant(e['crest']).astimezone(m.TZ).year in training]
  self.assertEqual(len(pool),future['highTideCount'])
  for row in annual['station']:
   values=[e['ft'] for e in cache['events'] if m.event_date(e).startswith(str(row['year'])+'-')]
   if not values:self.assertIsNone(row['total']);continue
   self.assertEqual(sum(v>=cache['thresholdsNAVD88']['minorLow']-1e-9 for v in values),row['total'])
   self.assertEqual(row['minor']+row['moderate']+row['major'],row['total'])
 def test_projection_exclusive_bins_total_and_intervals(self):
  future=json.loads((ROOT/'data/future_flood_counts.json').read_text())
  for scenario,rows in future['scenarios'].items():
   previous=-1
   for row in rows:
    n=row['drawsPerYear'];total=sum(row[k+'Mean'] for k in ['minor','moderate','major'])
    self.assertAlmostEqual(total,row['totalMean'],delta=2e-6);self.assertGreaterEqual(row['totalMean']+2e-6,previous);previous=row['totalMean']
    self.assertLessEqual(row['totalMean'],n+1e-6)
    for kind in ['minor','moderate','major','total']:
     self.assertTrue(0<=row[kind+'P05']<=row[kind+'P50']<=row[kind+'P95']<=n)
if __name__=='__main__':unittest.main()
