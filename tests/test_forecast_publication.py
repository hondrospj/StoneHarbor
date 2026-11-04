"""Offline full-publisher regressions: source/UI changes retain issued forecasts."""
import copy
import csv
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('forecast_tide_fixtures', ROOT / 'tests/test_tide_publication.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
publisher = fixtures.publisher
PATHS = ('data/petss_forecast.json', 'data/petss_forecast.csv', 'data/petss_meta.json', 'data/petss_station_debug.txt')


def forecast(cycle='t12z', height=3.25, updated='2099-01-01T00:00:00Z'):
    start = datetime(2026, 10, 28, 0, tzinfo=timezone.utc)
    rows = [{'t': (start + timedelta(hours=i)).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
             'twl': height + i / 1000, 'source_twl_mean': height + i / 1000,
             'tide': 2.5, 'surge': .75, 'source_twl90p': None, 'source_twl10p': None,
             'src_time': (start + timedelta(hours=i)).strftime('%Y%m%d%H%M')} for i in range(109)]
    output = io.StringIO(newline='')
    writer = csv.writer(output, lineterminator='\n')
    writer.writerow(['time_utc_iso', 'twl_ft_mllw', 'tide_ft_mllw', 'surge_ft', 'src_time',
                     'source_mean_ft_mllw', 'source_twl90p_ft_mllw', 'source_twl10p_ft_mllw'])
    for row in rows:
        writer.writerow([row['t'], row['twl'], row['tide'], row['surge'], row['src_time'], row['source_twl_mean'], '', ''])
    debug = 'TIME,TIDE,SURGE,TWL,TWL90P,TWL10P\n' + ''.join(
        f"{r['src_time']},{r['tide']},{r['surge']},{r['twl']},9999,-400\n" for r in rows[:20])
    meta = {'stid': '8535581', 'datum': 'MLLW', 'run_dir': 'petss.20261028', 'cycle': cycle,
            'model_time_utc': '2026-10-28T' + cycle[1:3] + ':00:00Z',
            'n_points': len(rows), 'updated_utc': updated,
            'forecast_valid_until_utc': rows[-1]['t'], 'forecast_product': 'TWL',
            'forecast_statistic': 'ensemble_mean', 'custom_bias_correction': False, 'forecast_adjustment_ft': 0}
    return {PATHS[0]: fixtures.encoded(rows), PATHS[1]: output.getvalue().encode(),
            PATHS[2]: fixtures.encoded(meta), PATHS[3]: debug.encode()}


class ForecastPublicationTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TidePublicationTests()
        self.case.setUp()
        self.case.local.update(forecast())
        self.case.live.update(forecast('t18z', 4.25, updated='2000-01-01T00:00:00Z'))
        self.bind_live()

    def bind_live(self):
        self.case.state['manifest']['files'] = {
            name: {'sha256': fixtures.digest(data), 'size': len(data)} for name, data in self.case.live.items()}

    def publish(self, dry_run=False, corrupt_prepared=None):
        manifest, payloads = fixtures.prepared(self.case.local)
        if corrupt_prepared:
            corrupt_prepared(manifest)
        with patch.object(publisher, 'prepare', return_value=(manifest, payloads)), \
                patch.object(publisher, 'api', side_effect=self.case.api), \
                patch.object(publisher, 'public_tide_file', side_effect=self.case.public), \
                patch.object(publisher, 'public_forecast_file', side_effect=self.case.public, create=True) as fetch:
            result = publisher.publish(self.case.app, self.case.source, [self.case.app],
                                       None if dry_run else self.case.connection, dry_run=dry_run)
        return result, fetch

    def assert_forecast(self, expected):
        for name in PATHS:
            self.assertEqual(self.case.planned_bytes(name), expected[name], name)

    def assert_rejected(self, message=None):
        context = self.assertRaisesRegex(ValueError, message) if message else self.assertRaises(ValueError)
        with context:
            self.publish()
        self.assertNotIn('plan', self.case.calls)
        self.assertNotIn('commit', self.case.calls)

    def test_newer_live_bundle_survives_source_ui_publish_and_newer_tides_still_survive(self):
        result, _ = self.publish()
        self.assert_forecast(self.case.live)
        self.assertTrue(result['preservedLiveForecastData'])
        self.assertTrue(result['preservedLiveTideData'])
        for name in publisher.TIDE_PATHS:
            self.assertEqual(self.case.planned_bytes(name), self.case.live[name])
        self.assertIn(b'NEW SOURCE UI', self.case.planned_bytes('index.html'))
        self.assertIn(b'"totalMean":20', self.case.planned_bytes('index.html'))
        self.assertEqual(self.case.planned_bytes('data/observations.json'), self.case.local['data/observations.json'])
        self.assertEqual(self.case.calls.count('state?manifest=1'), 1)

    def test_newer_local_issuance_replaces_the_whole_live_forecast(self):
        self.case.local.update(forecast('t18z', 4.25, updated='2000-01-01T00:00:00Z'))
        self.case.live.update(forecast('t12z', 3.25, updated='2099-01-01T00:00:00Z'))
        self.bind_live()
        result, _ = self.publish()
        self.assert_forecast(self.case.local)
        self.assertFalse(result['preservedLiveForecastData'])

    def test_same_cycle_coherent_live_revision_remains_authoritative(self):
        self.case.live.update(forecast('t12z', 4.25, updated='2000-01-01T00:00:00Z'))
        self.bind_live()
        result, _ = self.publish()
        self.assert_forecast(self.case.live)
        self.assertTrue(result['preservedLiveForecastData'])

    def test_same_cycle_metadata_only_enrichment_keeps_the_complete_bundle(self):
        self.case.live.update(copy.deepcopy({p: self.case.local[p] for p in PATHS}))
        meta = json.loads(self.case.live[PATHS[2]])
        meta['source_archive_sha256'] = 'a' * 64
        self.case.live[PATHS[2]] = fixtures.encoded(meta)
        self.bind_live()
        self.publish()
        self.assert_forecast(self.case.live)

    def test_identical_bundle_keeps_the_existing_bytes(self):
        self.case.live.update({p: self.case.local[p] for p in PATHS})
        self.bind_live()
        self.publish()
        self.assert_forecast(self.case.local)

    def test_newer_expired_live_forecast_is_not_rolled_back_or_restamped(self):
        self.publish()
        self.assert_forecast(self.case.live)
        meta = json.loads(self.case.planned_bytes(PATHS[2]))
        self.assertEqual(meta['updated_utc'], '2000-01-01T00:00:00Z')
        self.assertEqual(meta['model_time_utc'], '2026-10-28T18:00:00Z')
        self.assertEqual(meta['forecast_valid_until_utc'], '2026-11-01T12:00:00.000Z')

    def test_legacy_run_metadata_without_explicit_model_time_is_supported(self):
        for mapping in [self.case.local, self.case.live]:
            meta = json.loads(mapping[PATHS[2]])
            del meta['model_time_utc']
            mapping[PATHS[2]] = fixtures.encoded(meta)
        self.bind_live()
        self.publish()
        self.assert_forecast(self.case.live)

    def test_initial_publication_can_publish_a_complete_local_bundle(self):
        self.case.state.update(published=False, deployment=None)
        _, fetch = self.publish()
        self.assert_forecast(self.case.local)
        fetch.assert_not_called()

    def test_first_forecast_can_be_added_to_an_existing_application(self):
        for name in PATHS:
            del self.case.live[name]
        self.bind_live()
        _, fetch = self.publish()
        self.assert_forecast(self.case.local)
        fetch.assert_not_called()

    def test_complete_absence_on_both_sides_preserves_existing_data_less_fixture(self):
        for name in PATHS:
            del self.case.local[name]
            del self.case.live[name]
        self.bind_live()
        _, fetch = self.publish()
        fetch.assert_not_called()
        self.assertFalse(set(PATHS) & {f['path'] for f in self.case.planned['files']})

    def test_missing_source_bundle_cannot_delete_live_forecasts(self):
        for name in PATHS:
            del self.case.local[name]
        self.assert_rejected()

    def test_partial_source_or_live_bundle_fails_before_plan(self):
        for side in ['local', 'live']:
            for name in PATHS:
                with self.subTest(side=side, path=name):
                    self.setUp()
                    del getattr(self.case, side)[name]
                    self.bind_live()
                    self.assert_rejected()

    def test_corrupt_newer_live_or_source_files_fail_before_plan(self):
        for side in ['local', 'live']:
            for name in PATHS:
                with self.subTest(side=side, path=name):
                    self.setUp()
                    getattr(self.case, side)[name] = b'not the required file format\n'
                    self.bind_live()
                    self.assert_rejected()

    def test_live_file_hash_and_size_mismatches_fail_before_plan(self):
        for field in ['sha256', 'size']:
            for name in PATHS:
                with self.subTest(field=field, path=name):
                    self.setUp()
                    self.case.state['manifest']['files'][name][field] = '0' * 64 if field == 'sha256' else len(self.case.live[name]) + 1
                    self.assert_rejected()

    def test_prepared_bytes_must_match_their_manifest(self):
        def corrupt(manifest):
            entry = next(f for f in manifest['files'] if f['path'] == PATHS[1])
            entry['size'] += 1
        with self.assertRaises(ValueError):
            self.publish(corrupt_prepared=corrupt)
        self.assertNotIn('plan', self.case.calls)

    def test_metadata_identity_count_timestamps_and_model_flags_are_validated(self):
        changes = [{'stid': '8536110'}, {'datum': 'NAVD88'}, {'run_dir': 'petss.20260230'},
                   {'cycle': 't25z'}, {'model_time_utc': '2026-10-28T12:00:00Z'},
                   {'model_time_utc': '2026-10-28T18:00:00'}, {'model_time_utc': None},
                   {'n_points': 108}, {'n_points': True}, {'forecast_valid_until_utc': 'bad'},
                   {'forecast_statistic': 'percentile'}, {'custom_bias_correction': True},
                   {'forecast_adjustment_ft': .5}]
        for change in changes:
            with self.subTest(change=change):
                self.setUp()
                meta = json.loads(self.case.live[PATHS[2]])
                meta.update(change)
                self.case.live[PATHS[2]] = fixtures.encoded(meta)
                self.bind_live()
                self.assert_rejected()

    def test_rows_csv_and_debug_must_describe_the_same_issued_means(self):
        for kind in ['duplicate-time', 'false-zero', 'nonfinite', 'adjusted-mean', 'csv-value', 'csv-count', 'debug-value']:
            with self.subTest(kind=kind):
                self.setUp()
                if kind in ['duplicate-time', 'false-zero', 'nonfinite', 'adjusted-mean']:
                    rows = json.loads(self.case.live[PATHS[0]])
                    if kind == 'duplicate-time': rows[1]['t'] = rows[0]['t']
                    if kind == 'false-zero': rows[1]['source_twl_mean'] = False
                    if kind == 'nonfinite': rows[1]['source_twl_mean'] = float('nan')
                    if kind == 'adjusted-mean': rows[1]['source_twl_mean'] += 1
                    self.case.live[PATHS[0]] = fixtures.encoded(rows)
                elif kind == 'csv-value':
                    self.case.live[PATHS[1]] = self.case.live[PATHS[1]].replace(b',4.25,', b',1.25,', 1)
                elif kind == 'csv-count':
                    self.case.live[PATHS[1]] = b'\n'.join(self.case.live[PATHS[1]].splitlines()[:-1]) + b'\n'
                else:
                    self.case.live[PATHS[3]] = self.case.live[PATHS[3]].replace(b',4.25,', b',1.25,', 1)
                self.bind_live()
                self.assert_rejected()

    def test_older_bad_data_can_be_replaced_after_its_valid_issue_metadata_is_ordered(self):
        self.case.local.update(forecast('t18z'))
        self.case.live.update(forecast('t12z'))
        self.case.live[PATHS[0]] = b'bad previous forecast\n'
        self.bind_live()
        self.publish()
        self.assert_forecast(self.case.local)

    def test_valid_debug_prefix_without_usable_means_does_not_block_publication(self):
        self.case.live[PATHS[3]] = b'TIME,TIDE,SURGE,TWL\n202610280000,2.5,.75,9999\n'
        self.bind_live()
        self.publish()
        self.assert_forecast(self.case.live)

    def test_optional_numeric_fields_and_csv_shape_cannot_hide_corruption_as_null(self):
        for kind in ['json-bool', 'json-nan', 'csv-bad-null', 'csv-duplicate-column', 'csv-extra-column', 'debug-tide']:
            with self.subTest(kind=kind):
                self.setUp()
                if kind.startswith('json-'):
                    rows = json.loads(self.case.live[PATHS[0]])
                    rows[0]['tide'] = False if kind == 'json-bool' else float('nan')
                    self.case.live[PATHS[0]] = fixtures.encoded(rows)
                elif kind == 'csv-bad-null':
                    self.case.live[PATHS[1]] = self.case.live[PATHS[1]].replace(b',,\n', b',bad,\n', 1)
                elif kind == 'csv-duplicate-column':
                    self.case.live[PATHS[1]] = self.case.live[PATHS[1]].replace(b'source_twl10p_ft_mllw', b'twl_ft_mllw', 1)
                elif kind == 'csv-extra-column':
                    self.case.live[PATHS[1]] = self.case.live[PATHS[1]].replace(b',,\n', b',,,extra\n', 1)
                else:
                    self.case.live[PATHS[3]] = self.case.live[PATHS[3]].replace(b',2.5,', b',9.5,', 1)
                self.bind_live()
                self.assert_rejected()

    def test_forecast_only_malformed_live_state_is_rejected_before_plan(self):
        for name in publisher.TIDE_PATHS:
            del self.case.local[name]
            del self.case.live[name]
        self.bind_live()
        self.case.state['manifest'] = None
        self.assert_rejected()

    def test_malformed_existing_forecast_receipt_fingerprint_is_rejected(self):
        receipt = {'files': {PATHS[0]: 'not a fingerprint'}}
        self.case.local['data/refresh_status.json'] = fixtures.encoded(receipt)
        self.assert_rejected()

    def test_forecast_only_application_still_rechecks_deployment_before_commit(self):
        for name in publisher.TIDE_PATHS:
            del self.case.local[name]
            del self.case.live[name]
        self.bind_live()
        self.case.concurrent = True
        with self.assertRaisesRegex(RuntimeError, 'refresh state and retry'):
            self.publish()
        self.assertTrue(self.case.uploads)
        self.assertNotIn('commit', self.case.calls)

    def test_forecast_capture_failure_or_missing_deployment_blocks_plan(self):
        self.case.state['deployment'] = None
        self.assert_rejected()

    def test_existing_receipt_fingerprints_are_rebound_without_changing_status_or_weather(self):
        weather = 'data/observations.json'
        receipt = {'checkedAtUtc': 'retain original', 'status': 'retain status', 'latestUpstreamCycleUtc': 'retain original',
                   'files': {name: {'sha256': fixtures.digest(self.case.local[name]), 'bytes': len(self.case.local[name]), 'source': 'retain'}
                             for name in [*publisher.TIDE_PATHS, *PATHS, weather]}}
        self.case.local['data/refresh_status.json'] = fixtures.encoded(receipt)
        self.publish()
        actual = json.loads(self.case.planned_bytes('data/refresh_status.json'))
        self.assertEqual(actual['checkedAtUtc'], receipt['checkedAtUtc'])
        self.assertEqual(actual['status'], receipt['status'])
        self.assertEqual(actual['latestUpstreamCycleUtc'], receipt['latestUpstreamCycleUtc'])
        self.assertEqual(actual['files'][weather], receipt['files'][weather])
        for name in [*publisher.TIDE_PATHS, *PATHS]:
            self.assertEqual(actual['files'][name], {'sha256': fixtures.digest(self.case.live[name]), 'bytes': len(self.case.live[name]), 'source': 'retain'})

    def test_dry_run_is_offline_even_with_forecasts(self):
        result, fetch = self.publish(dry_run=True)
        self.assertEqual(result['commit'], 'reviewed-new-ui')
        fetch.assert_not_called()
        self.assertEqual(self.case.calls, [])

    def test_generic_app_retains_existing_source_publication_behavior(self):
        self.case.app['id'] = 'flooddashboard--unselected'
        self.case.connection['tokens'] = {self.case.app['id']: 'never-log-this'}
        self.publish()
        self.assert_forecast(self.case.local)
        self.assertNotIn('state?manifest=1', self.case.calls)
        self.assertNotIn('state', self.case.calls)

    @unittest.skipUnless(hasattr(publisher, 'public_forecast_file'), 'Forecast byte reader not present in baseline')
    def test_public_forecast_reader_is_bounded_hash_verified_and_credential_free(self):
        name = PATHS[3]
        entry = self.case.state['manifest']['files'][name]
        response = MagicMock()
        response.__enter__.return_value.read.return_value = self.case.live[name]
        with patch.object(publisher.urllib.request, 'urlopen', return_value=response) as opened:
            self.assertEqual(publisher.public_forecast_file('https://example.test', self.case.app, name, entry), self.case.live[name])
        request = opened.call_args.args[0]
        self.assertIn(entry['sha256'], request.full_url)
        self.assertNotIn('X-shorelysafe-token', request.headers)
        response.__enter__.return_value.read.assert_called_once_with(entry['size'] + 1)
        response.__enter__.return_value.read.return_value += b'changed'
        with patch.object(publisher.urllib.request, 'urlopen', return_value=response):
            with self.assertRaises(ValueError):
                publisher.public_forecast_file('https://example.test', self.case.app, name, entry)


if __name__ == '__main__':
    unittest.main()
