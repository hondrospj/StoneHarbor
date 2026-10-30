"""Offline publication regressions: source UI must not roll back live tides."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('tide_source_publisher', ROOT / '.shorelysafe/publish.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


def encoded(value):
    return (json.dumps(value, separators=(',', ':')) + '\n').encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def bundle(cursor='2026-10-28T12:00:00Z', generated='2026-10-28T13:00:00Z', count=3, **changes):
    cache = {'method': 'individual_high_tides_v3', 'countUnit': 'individual-high-tide',
             'site': '01411360', 'datum': 'NAVD88',
             'thresholdsNAVD88': {'minorLow': 3.44, 'moderateLow': 4.44, 'majorLow': 5.44},
             'lastProcessedISO': cursor, 'generatedAt': generated, 'events': []}
    cache.update(changes)
    raw = encoded(cache)
    return {publisher.TIDE_PATHS[0]: raw,
            publisher.TIDE_PATHS[1]: encoded({'schema': 'individual-high-tide-counts-v3',
                'countUnit': 'individual-high-tide', 'sourceSHA256': digest(raw),
                'station': [{'year': 2026, 'total': count}]}),
            publisher.TIDE_PATHS[2]: encoded({'schema': 'individual-high-tide-projections-v3',
                'countUnit': 'individual-high-tide', 'sourceSHA256': digest(raw),
                'scenarios': {'Baseline': [{'year': 2026, 'totalMean': count}]}})}


def prepared(contents):
    files = [{'path': name, 'sha256': digest(data), 'size': len(data)}
             for name, data in sorted(contents.items())]
    return {'files': files, 'commit': 'reviewed-new-ui'}, {
        digest(data): (Path('/source') / name, data) for name, data in contents.items()}


class TidePublicationTests(unittest.TestCase):
    def setUp(self):
        self.app = {'id': 'flooddashboard--stone-harbor', 'path': '/shorelysafe/flooddashboard/stone-harbor/',
                    'repository': 'owner/StoneHarbor'}
        self.source = Path('/source')
        self.local = bundle()
        self.index = (b'<h1>NEW SOURCE UI</h1>\n<script>\n'
                      b'const FUTURE_FLOOD_PREDICTIONS = {"old":1};\n'
                      b'const NEW_UI_FEATURE = true;\n</script>\n')
        self.local.update({'index.html': self.index, 'data/observations.json': b'{"sourceWeather":true}\n'})
        self.live = bundle('2026-10-29T12:00:00Z', '2026-10-29T13:00:00Z', count=20)
        self.state = {'published': True, 'deployment': 'live-base', 'manifest': {'files': {
            name: {'sha256': digest(data), 'size': len(data)} for name, data in self.live.items()}}}
        self.calls = []
        self.uploads = {}
        self.planned = None
        self.concurrent = False
        self.connection = {'site': 'https://example.test', 'tokens': {self.app['id']: 'never-log-this'}}

    def public(self, site, app, name, entry):
        return self.live[name]

    def api(self, site, app, token, endpoint, method='GET', data=None, raw=False):
        self.calls.append(endpoint)
        if endpoint == 'state?manifest=1':
            return copy.deepcopy(self.state)
        if endpoint == 'state':
            return {'deployment': 'concurrent-newer' if self.concurrent else self.state['deployment']}
        if endpoint == 'plan':
            self.planned = copy.deepcopy(data)
            return {'deployment': 'planned', 'missing': list(dict.fromkeys(f['sha256'] for f in data['files']))}
        if endpoint.startswith('batch?'):
            self.uploads.update({b['sha256']: base64.b64decode(b['data']) for b in data['blobs']})
            return {'complete': True}
        if endpoint.startswith('blobs/'):
            sha = endpoint.split('/')[1].split('?')[0]
            self.uploads[sha] = self.uploads.get(sha, b'') + data
            return {'complete': True, 'offset': len(self.uploads[sha])}
        if endpoint == 'commit':
            return {'published': True, 'deployment': data['deployment']}
        raise AssertionError('Unexpected publisher request: ' + endpoint)

    def run_publish(self):
        manifest, payloads = prepared(self.local)
        with patch.object(publisher, 'prepare', return_value=(manifest, payloads)), \
                patch.object(publisher, 'api', side_effect=self.api), \
                patch.object(publisher, 'public_tide_file', side_effect=self.public) as fetch:
            summary = publisher.publish(self.app, self.source, [self.app], self.connection)
        return summary, fetch

    def planned_bytes(self, name):
        entry = next(f for f in self.planned['files'] if f['path'] == name)
        return self.uploads[entry['sha256']]

    def rebind_live_entry(self, name, data):
        self.live[name] = data
        self.state['manifest']['files'][name] = {'sha256': digest(data), 'size': len(data)}

    def test_new_source_ui_preserves_newer_live_archive_statistics_and_model(self):
        summary, fetch = self.run_publish()
        self.assertTrue(summary['preservedLiveTideData'])
        self.assertEqual(summary['tideSourceSHA256'], digest(self.live[publisher.TIDE_PATHS[0]]))
        self.assertEqual([call.args[2] for call in fetch.call_args_list], list(publisher.TIDE_PATHS))
        for name in publisher.TIDE_PATHS:
            self.assertEqual(self.planned_bytes(name), self.live[name])
        index = self.planned_bytes('index.html')
        self.assertIn(b'NEW SOURCE UI', index)
        self.assertIn(b'const NEW_UI_FEATURE = true;', index)
        self.assertIn(b'"totalMean":20', index)
        self.assertNotIn(b'{"old":1}', index)
        self.assertEqual(self.planned_bytes('data/observations.json'), self.local['data/observations.json'])
        self.assertEqual(self.local['index.html'], self.index)
        self.assertLess(self.calls.index('state'), self.calls.index('commit'))

    def test_public_cache_hash_mismatch_refuses_plan(self):
        self.live[publisher.TIDE_PATHS[0]] += b' '
        with self.assertRaisesRegex(ValueError, 'manifest'):
            self.run_publish()
        self.assertNotIn('plan', self.calls)

    def test_public_statistics_size_mismatch_refuses_plan(self):
        self.state['manifest']['files'][publisher.TIDE_PATHS[1]]['size'] += 1
        with self.assertRaisesRegex(ValueError, 'manifest'):
            self.run_publish()
        self.assertNotIn('plan', self.calls)

    def test_live_statistics_must_bind_exact_live_cache_hash(self):
        name = publisher.TIDE_PATHS[2]
        future = json.loads(self.live[name]); future['sourceSHA256'] = '0' * 64
        self.rebind_live_entry(name, encoded(future))
        with self.assertRaisesRegex(ValueError, 'bind'):
            self.run_publish()
        self.assertNotIn('plan', self.calls)

    def test_newer_local_archive_is_published(self):
        self.local.update(bundle('2026-10-30T12:00:00Z', '2026-10-30T13:00:00Z', count=30))
        summary, _ = self.run_publish()
        self.assertFalse(summary['preservedLiveTideData'])
        self.assertEqual(self.planned_bytes('index.html'), self.index)
        for name in publisher.TIDE_PATHS:
            self.assertEqual(self.planned_bytes(name), self.local[name])

    def test_existing_health_receipt_rebinds_only_adopted_tide_fingerprints(self):
        for field in ('files', 'payloads'):
            with self.subTest(field=field):
                self.setUp()
                receipt = {'checkedAtUtc': '2026-10-28T13:00:00Z', 'status': 'healthy',
                           'latestPeakProcessedUtc': '2026-10-28T12:00:00Z',
                           'latestObservationUtc': '2026-10-28T12:45:00Z',
                           field: {name: {'sha256': digest(self.local[name]),
                                          'bytes': len(self.local[name]), 'size': len(self.local[name]),
                                          'source': 'retain this metadata'} for name in publisher.TIDE_PATHS}}
                weather = 'data/observations.json'
                receipt[field][weather] = {'sha256': digest(self.local[weather]), 'bytes': len(self.local[weather])}
                expected = copy.deepcopy(receipt)
                for name in publisher.TIDE_PATHS:
                    expected[field][name].update(sha256=digest(self.live[name]), bytes=len(self.live[name]), size=len(self.live[name]))
                self.local['data/refresh_status.json'] = encoded(receipt)
                self.run_publish()
                self.assertEqual(json.loads(self.planned_bytes('data/refresh_status.json')), expected)

    def test_health_receipt_retains_existing_fingerprint_shape_and_path_set(self):
        peak = publisher.TIDE_PATHS[0]
        receipt = {'files': {peak: {'sha256': digest(self.local[peak]), 'bytes': len(self.local[peak])}},
                   'latestUpstreamCycleUtc': '2026-10-28T06:00:00Z'}
        self.local['data/refresh_status.json'] = encoded(receipt)
        self.run_publish()
        actual = json.loads(self.planned_bytes('data/refresh_status.json'))
        self.assertEqual(actual['files'], {peak: {'sha256': digest(self.live[peak]), 'bytes': len(self.live[peak])}})
        self.assertEqual(actual['latestUpstreamCycleUtc'], receipt['latestUpstreamCycleUtc'])

    def test_newer_local_bundle_keeps_existing_health_receipt_bytes(self):
        self.local.update(bundle('2026-10-30T12:00:00Z', '2026-10-30T13:00:00Z'))
        receipt = b'{"checkedAtUtc":"retain original bytes", "files": {}}\n'
        self.local['data/refresh_status.json'] = receipt
        self.run_publish()
        self.assertEqual(self.planned_bytes('data/refresh_status.json'), receipt)

    def test_absent_health_receipt_is_not_created(self):
        self.run_publish()
        self.assertNotIn('data/refresh_status.json', {f['path'] for f in self.planned['files']})

    def test_reviewed_identity_or_schema_changes_are_not_replaced_by_live(self):
        changes = [{'site': 'different-gauge'}, {'datum': 'MLLW'},
                   {'thresholdsNAVD88': {'minorLow': 4, 'moderateLow': 5, 'majorLow': 6}},
                   {'schema': 'reviewed-new-cache-schema'},
                   {'method': 'daily_maxima_v2', 'countUnit': 'flood-day'}]
        for change in changes:
            with self.subTest(change=change):
                self.setUp()
                data = json.loads(self.live[publisher.TIDE_PATHS[0]]); data.update(change)
                self.rebind_live_entry(publisher.TIDE_PATHS[0], encoded(data))
                summary, fetch = self.run_publish()
                self.assertFalse(summary['preservedLiveTideData'])
                self.assertEqual(fetch.call_count, 1)
                self.assertEqual(self.planned_bytes(publisher.TIDE_PATHS[0]), self.local[publisher.TIDE_PATHS[0]])

    def test_same_cursor_uses_newer_generation_timestamp(self):
        self.live = bundle('2026-10-28T12:00:00Z', '2026-10-28T14:00:00Z', count=22)
        for name, data in self.live.items(): self.rebind_live_entry(name, data)
        summary, _ = self.run_publish()
        self.assertTrue(summary['preservedLiveTideData'])

    def test_same_cursor_keeps_newer_local_revision(self):
        self.live = bundle('2026-10-28T12:00:00Z', '2026-10-28T11:00:00Z', count=22)
        for name, data in self.live.items(): self.rebind_live_entry(name, data)
        summary, _ = self.run_publish()
        self.assertFalse(summary['preservedLiveTideData'])

    def test_same_cursor_uses_harbor_generation_timestamp(self):
        self.local.update(bundle(generated=None, generatedUTC='2026-10-28T13:00:00Z'))
        self.live = bundle('2026-10-28T12:00:00Z', None, count=22, generatedUTC='2026-10-28T14:00:00Z')
        for name, data in self.live.items(): self.rebind_live_entry(name, data)
        summary, _ = self.run_publish()
        self.assertTrue(summary['preservedLiveTideData'])

    def test_same_cursor_uses_live_update_observation_timestamp(self):
        self.local.update(bundle(generated=None, liveUpdate={'observedThrough': '2026-10-28T13:00:00Z'}))
        self.live = bundle('2026-10-28T12:00:00Z', None, count=22,
                           liveUpdate={'observedThrough': '2026-10-28T14:00:00Z'})
        for name, data in self.live.items(): self.rebind_live_entry(name, data)
        summary, _ = self.run_publish()
        self.assertTrue(summary['preservedLiveTideData'])

    def test_ambiguous_same_cursor_different_archive_fails_closed(self):
        self.live = bundle('2026-10-28T12:00:00Z', '2026-10-28T13:00:00Z', events=[{'revision': 2}])
        for name, data in self.live.items(): self.rebind_live_entry(name, data)
        with self.assertRaisesRegex(ValueError, 'ordered revision'):
            self.run_publish()
        self.assertNotIn('plan', self.calls)

    def test_concurrent_deployment_change_blocks_commit_after_upload(self):
        self.concurrent = True
        with self.assertRaisesRegex(RuntimeError, 'refresh state and retry'):
            self.run_publish()
        self.assertTrue(self.uploads)
        self.assertNotIn('commit', self.calls)

    def test_missing_live_deployment_identity_fails_before_plan(self):
        self.state['deployment'] = None
        with self.assertRaisesRegex(ValueError, 'deployment identity'):
            self.run_publish()
        self.assertNotIn('plan', self.calls)

    def test_missing_embedded_model_fails_before_plan(self):
        self.local['index.html'] = b'<h1>NEW UI without its required model constant</h1>'
        with self.assertRaisesRegex(ValueError, 'embedded future'):
            self.run_publish()
        self.assertNotIn('plan', self.calls)

    def test_dry_run_keeps_existing_offline_behavior(self):
        manifest, payloads = prepared(self.local)
        with patch.object(publisher, 'prepare', return_value=(manifest, payloads)), \
                patch.object(publisher, 'api') as api, patch.object(publisher, 'public_tide_file') as fetch:
            summary = publisher.publish(self.app, self.source, [self.app], None, dry_run=True)
        api.assert_not_called()
        fetch.assert_not_called()
        self.assertEqual(summary['commit'], 'reviewed-new-ui')

    def test_initial_publication_and_v3_migration_can_publish(self):
        self.state.update(published=False, deployment=None)
        summary, fetch = self.run_publish()
        self.assertFalse(summary['preservedLiveTideData'])
        fetch.assert_not_called()
        self.assertIn('commit', self.calls)

    def test_other_app_retains_existing_publication_behavior(self):
        self.app['id'] = 'flooddashboard--unselected'
        self.connection['tokens'] = {self.app['id']: 'never-log-this'}
        summary, fetch = self.run_publish()
        self.assertNotIn('preservedLiveTideData', summary)
        fetch.assert_not_called()
        self.assertNotIn('state?manifest=1', self.calls)
        self.assertNotIn('state', self.calls)
        self.assertEqual(self.planned_bytes('index.html'), self.index)

    def test_all_three_selected_ids_use_the_guard(self):
        for app_id in sorted(publisher.TIDE_APPS):
            with self.subTest(app=app_id):
                self.setUp()
                self.app['id'] = app_id
                self.connection['tokens'] = {app_id: 'never-log-this'}
                summary, _ = self.run_publish()
                self.assertTrue(summary['preservedLiveTideData'])

    def test_public_reader_checks_hash_size_and_has_no_token_header(self):
        name = publisher.TIDE_PATHS[0]
        entry = self.state['manifest']['files'][name]
        from unittest.mock import MagicMock
        response = MagicMock()
        response.__enter__.return_value.read.return_value = self.live[name]
        with patch.object(publisher.urllib.request, 'urlopen', return_value=response) as opened:
            actual = publisher.public_tide_file('https://example.test', self.app, name, entry)
        self.assertEqual(actual, self.live[name])
        request = opened.call_args.args[0]
        self.assertIn('?tide_sha256=' + entry['sha256'], request.full_url)
        self.assertNotIn('X-shorelysafe-token', request.headers)
        response.__enter__.return_value.read.assert_called_once_with(entry['size'] + 1)
        response.__enter__.return_value.read.return_value += b' '
        with patch.object(publisher.urllib.request, 'urlopen', return_value=response):
            with self.assertRaisesRegex(ValueError, 'manifest'):
                publisher.public_tide_file('https://example.test', self.app, name, entry)


if __name__ == '__main__':
    unittest.main()
