"""Offline tests for adopting published canonical tides before private updates."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('canonical_tide_sync', ROOT / 'tools/sync_canonical_tide_history.py')
syncer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(syncer)
APP = 'flooddashboard--stone-harbor'


def encoded(value):
    return (json.dumps(value, separators=(',', ':')) + '\n').encode()


def bundle(cursor='2026-10-28T12:00:00Z', generated='2026-10-28T13:00:00Z',
           station='01411360', count=3, **changes):
    cache = {'schema': 'high-tide-events-v3', 'method': 'individual_high_tides_v3',
             'countUnit': 'individual-high-tide', 'site': station, 'datum': 'NAVD88',
             'thresholdsNAVD88': {'minorLow': 3.44, 'moderateLow': 4.44, 'majorLow': 5.44},
             'lastProcessedISO': cursor, 'generatedAt': generated,
             'events': [{'cycleId': 'clock@2026-10-28T01:00:00Z', 'kind': 'HighTide',
                         't': '2026-10-28T01:00:00Z', 'ft': 4.2}]}
    cache.update(changes)
    raw = encoded(cache)
    sha = hashlib.sha256(raw).hexdigest()
    return {syncer.NAMES[0]: raw,
            syncer.NAMES[1]: encoded({'schema': 'individual-high-tide-counts-v3',
                'countUnit': 'individual-high-tide', 'sourceSHA256': sha,
                'station': [{'year': 2026, 'total': count}]}),
            syncer.NAMES[2]: encoded({'schema': 'individual-high-tide-projections-v3',
                'countUnit': 'individual-high-tide', 'sourceSHA256': sha,
                'scenarios': {'Baseline': [{'year': 2026, 'totalMean': count}]}})}


class CanonicalTideSyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'data').mkdir()
        self.local = bundle()
        self.live = bundle('2026-10-29T12:00:00Z', '2026-10-29T13:00:00Z', count=20)
        self.index = (b'<h1>REVIEWED SOURCE UI</h1>\n<script>\n'
                      b'const FUTURE_FLOOD_PREDICTIONS = {"old":1};\n'
                      b'const NEW_FEATURE = true;\n</script>\n')
        self.write_local()
        self.urls = []
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.sleep = patch.object(syncer.time, 'sleep')
        self.sleep.start()
        self.addCleanup(self.sleep.stop)

    def write_local(self):
        for name, body in self.local.items():
            (self.root / 'data' / name).write_bytes(body)
        (self.root / 'index.html').write_bytes(self.index)
        (self.root / 'data' / 'unrelated-weather.json').write_bytes(b'{"weather":"keep"}\n')

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.read_bytes()
                for p in self.root.rglob('*') if p.is_file()}

    def fetch(self, url):
        self.urls.append(url)
        return self.live[Path(urlparse(url).path).name]

    def run_sync(self, app=APP, fetch=None):
        return syncer.sync(self.root, app, fetch=fetch or self.fetch)

    def test_newer_live_bundle_and_model_are_installed_without_replacing_source_ui(self):
        result = self.run_sync()
        self.assertTrue(result['synced'])
        self.assertEqual(result['sourceSHA256'], hashlib.sha256(self.live[syncer.NAMES[0]]).hexdigest())
        for name in syncer.NAMES:
            self.assertEqual((self.root / 'data' / name).read_bytes(), self.live[name])
        html = (self.root / 'index.html').read_bytes()
        self.assertIn(b'REVIEWED SOURCE UI', html)
        self.assertIn(b'const NEW_FEATURE = true;', html)
        self.assertIn(b'"totalMean":20', html)
        self.assertNotIn(b'{"old":1}', html)
        self.assertEqual((self.root / 'data/unrelated-weather.json').read_bytes(), b'{"weather":"keep"}\n')
        self.assertEqual(len(self.urls), 3)
        self.assertEqual(len({urlparse(url).query for url in self.urls}), 1)
        self.assertTrue(all(url.startswith('https://cupajoe.live/shorelysafe/flooddashboard/stone-harbor/data/')
                            for url in self.urls))

    def test_older_cursor_is_not_adopted_even_if_generation_timestamp_is_newer(self):
        self.live = bundle('2026-10-27T12:00:00Z', '2026-10-30T13:00:00Z')
        before = self.snapshot()
        self.assertFalse(self.run_sync()['synced'])
        self.assertEqual(self.snapshot(), before)

    def test_identical_or_older_equal_cursor_revision_is_not_adopted(self):
        for generated in ('2026-10-28T13:00:00Z', '2026-10-28T12:00:00Z'):
            with self.subTest(generated=generated):
                self.live = bundle(generated=generated, count=20)
                before = self.snapshot()
                self.assertFalse(self.run_sync()['synced'])
                self.assertEqual(self.snapshot(), before)

    def test_equal_cursor_uses_harbor_generation_timestamp(self):
        self.local = bundle(generated=None, generatedUTC='2026-10-28T13:00:00Z')
        self.live = bundle(generated=None, generatedUTC='2026-10-28T14:00:00Z', count=20)
        self.write_local()
        self.assertTrue(self.run_sync()['synced'])

    def test_equal_cursor_uses_observed_through_timestamp(self):
        self.local = bundle(generated=None, liveUpdate={'observedThrough': '2026-10-28T13:00:00Z'})
        self.live = bundle(generated=None, liveUpdate={'observedThrough': '2026-10-28T14:00:00Z'}, count=20)
        self.write_local()
        self.assertTrue(self.run_sync()['synced'])

    def test_incompatible_published_identity_or_schema_never_mutates_local_files(self):
        changes = [{'site': 'other-gauge'}, {'datum': 'MLLW'}, {'schema': 'next-reviewed-schema'},
                   {'thresholdsNAVD88': {'minorLow': 4, 'moderateLow': 5, 'majorLow': 6}},
                   {'method': 'daily_maxima_v2'}, {'countUnit': 'flood-day'}]
        for change in changes:
            with self.subTest(change=change):
                self.live = bundle('2026-10-29T12:00:00Z', '2026-10-29T13:00:00Z', **change)
                before = self.snapshot()
                self.assertFalse(self.run_sync()['synced'])
                self.assertEqual(self.snapshot(), before)

    def test_bad_count_or_model_binding_never_partially_mutates_files(self):
        for name in syncer.NAMES[1:]:
            with self.subTest(file=name):
                self.live = bundle('2026-10-29T12:00:00Z')
                value = json.loads(self.live[name]); value['sourceSHA256'] = '0' * 64
                self.live[name] = encoded(value)
                before = self.snapshot()
                with self.assertRaisesRegex(ValueError, 'bind'):
                    self.run_sync()
                self.assertEqual(self.snapshot(), before)

    def test_bad_statistics_schema_or_unit_never_partially_mutates_files(self):
        for name in syncer.NAMES[1:]:
            for field, value in [('schema', 'legacy-v2'), ('countUnit', 'flood-day')]:
                with self.subTest(file=name, field=field):
                    self.live = bundle('2026-10-29T12:00:00Z')
                    data = json.loads(self.live[name]); data[field] = value
                    self.live[name] = encoded(data)
                    before = self.snapshot()
                    with self.assertRaisesRegex(ValueError, 'schema'):
                        self.run_sync()
                    self.assertEqual(self.snapshot(), before)

    def test_bad_future_scenarios_never_partially_mutate_files(self):
        for scenarios in (None, {}, {'Baseline': []}, {'Baseline': [{'totalMean': float('nan')}]}):
            with self.subTest(scenarios=scenarios):
                self.live = bundle('2026-10-29T12:00:00Z')
                future = json.loads(self.live[syncer.NAMES[2]]); future['scenarios'] = scenarios
                self.live[syncer.NAMES[2]] = encoded(future)
                before = self.snapshot()
                with self.assertRaises(ValueError):
                    self.run_sync()
                self.assertEqual(self.snapshot(), before)

    def test_invalid_or_duplicate_cycles_never_partially_mutate_files(self):
        event = {'cycleId': 'valid', 'kind': 'HighTide', 't': '2026-10-28T01:00:00Z', 'ft': 2.5}
        cases = [[], [event, event], [dict(event, ft=True)], [dict(event, ft=float('inf'))],
                 [dict(event, kind='DailyMax')], [dict(event, t=None)], ['not an event']]
        for events in cases:
            with self.subTest(events=events):
                self.live = bundle('2026-10-29T12:00:00Z', events=events)
                before = self.snapshot()
                with self.assertRaises(ValueError):
                    self.run_sync()
                self.assertEqual(self.snapshot(), before)

    def test_documented_date_only_official_crest_remains_acceptable(self):
        event = {'cycleId': 'official:documented-crest', 'kind': 'OfficialCrest',
                 't': None, 'timeUnknown': True, 'ft': 5.2, 'localDate': '1962-03-06'}
        self.live = bundle('2026-10-29T12:00:00Z', events=[event])
        self.assertTrue(self.run_sync()['synced'])

    def test_invalid_live_cursor_never_partially_mutates_files(self):
        for cursor in ('invalid', '2026-10-29T12:00:00', None):
            with self.subTest(cursor=cursor):
                self.live = bundle(cursor)
                before = self.snapshot()
                with self.assertRaisesRegex(ValueError, 'cursor'):
                    self.run_sync()
                self.assertEqual(self.snapshot(), before)

    def test_invalid_local_cursor_or_selected_gauge_stops_before_fetching(self):
        for change in ({'lastProcessedISO': 'invalid'}, {'site': 'another-gauge'}, {'datum': 'MLLW'}):
            with self.subTest(change=change):
                self.local = bundle(**change)
                self.write_local()
                before = self.snapshot()
                self.urls.clear()
                with self.assertRaises(ValueError):
                    self.run_sync()
                self.assertFalse(self.urls)
                self.assertEqual(self.snapshot(), before)

    def test_missing_or_duplicate_index_constant_never_partially_mutates_files(self):
        for html in (b'<h1>Source UI with missing model</h1>', self.index + self.index):
            with self.subTest(html=html):
                (self.root / 'index.html').write_bytes(html)
                before = self.snapshot()
                with self.assertRaisesRegex(ValueError, 'embedded'):
                    self.run_sync()
                self.assertEqual(self.snapshot(), before)

    def test_malformed_json_does_not_mutate_files(self):
        self.live[syncer.NAMES[2]] = b'{"incomplete"'
        before = self.snapshot()
        with self.assertRaises(ValueError):
            self.run_sync()
        self.assertEqual(self.snapshot(), before)

    def test_read_race_retries_whole_bundle_then_installs_consistent_snapshot(self):
        count = 0
        def changing_fetch(url):
            nonlocal count
            count += 1
            name = Path(urlparse(url).path).name
            if count <= 3 and name == syncer.NAMES[2]:
                return self.local[name]
            return self.fetch(url)
        self.assertTrue(self.run_sync(fetch=changing_fetch)['synced'])
        self.assertEqual(count, 6)
        for name in syncer.NAMES:
            self.assertEqual((self.root / 'data' / name).read_bytes(), self.live[name])

    def test_file_replacement_failure_rolls_back_prior_replacements(self):
        before = self.snapshot()
        original_replace = os.replace
        calls = 0
        def failing_replace(source, dest):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('simulated replacement failure')
            return original_replace(source, dest)
        with patch.object(syncer.os, 'replace', side_effect=failing_replace):
            with self.assertRaisesRegex(OSError, 'replacement failure'):
                self.run_sync()
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(list(self.root.glob('.canonical-tide-sync-*')))

    def test_all_selected_app_ids_use_their_own_public_gauge_path(self):
        for app, (slug, station) in syncer.APPS.items():
            with self.subTest(app=app):
                self.local = bundle(station=station)
                self.live = bundle('2026-10-29T12:00:00Z', station=station)
                self.write_local()
                self.urls.clear()
                self.assertTrue(self.run_sync(app=app)['synced'])
                self.assertTrue(all('/flooddashboard/' + slug + '/data/' in url for url in self.urls))

    def test_unselected_app_is_rejected_without_fetch_or_mutation(self):
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'scope'):
            self.run_sync(app='flooddashboard--unselected')
        self.assertFalse(self.urls)
        self.assertEqual(self.snapshot(), before)

    def test_explicit_reviewed_rebuild_bypass_does_not_fetch_or_mutate(self):
        before = self.snapshot()
        with patch.dict(os.environ, {'SHORELYSAFE_FORCE_TIDE_SOURCE': 'reviewed'}):
            result = self.run_sync()
        self.assertFalse(result['synced'])
        self.assertIn('reviewed', result['reason'])
        self.assertFalse(self.urls)
        self.assertEqual(self.snapshot(), before)

    def test_public_reader_has_bounded_read_and_no_credential_header(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = self.live[syncer.NAMES[0]]
        with patch.object(syncer.urllib.request, 'urlopen', return_value=response) as opened:
            self.assertEqual(syncer.get('https://cupajoe.live/example'), self.live[syncer.NAMES[0]])
        response.__enter__.return_value.read.assert_called_once_with(syncer.MAX_BYTES + 1)
        self.assertEqual(opened.call_args.args[0].headers, {'Cache-control': 'no-cache'})


if __name__ == '__main__':
    unittest.main()
