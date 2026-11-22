from hashlib import sha256
import json
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from serve_dashboard_preview import LiveBundle, TIDE_PATHS, validate_history


class LiveBundleTests(unittest.TestCase):
    def setUp(self):
        self.upstream = {"forecast": (b"2", '"forecast-2"'), "meta": (b"2", '"meta-2"')}

        def fetch(name, previous):
            try:
                current = self.upstream[name]
            except KeyError as error:
                raise OSError(f"Missing {name}") from error
            return previous if current == previous else current

        def validate(files):
            if files["forecast"] != files["meta"]:
                raise ValueError("Forecast and metadata do not match")
            return int(files["meta"])

        self.bundle = LiveBundle(("forecast", "meta"), validate, fetch=fetch)

    def recheck(self):
        self.bundle.next_check = 0
        return self.bundle.read()

    def test_replaces_bundle_only_after_all_current_members_validate(self):
        original, status = self.bundle.read()
        self.assertEqual(status, "live")
        self.upstream["forecast"] = (b"3", '"forecast-3"')
        self.assertEqual(self.recheck(), (original, "retained"))
        self.upstream["meta"] = (b"3", '"meta-3"')
        self.assertEqual(self.recheck(), (self.upstream, "live"))
        self.upstream = dict(original)
        current, status = self.recheck()
        self.assertEqual(status, "retained")
        self.assertEqual(current["meta"][0], b"3")

    def test_no_local_fallback_before_first_live_snapshot(self):
        del self.upstream["meta"]
        self.assertEqual(self.bundle.read(), ({}, "unavailable"))
        self.upstream["meta"] = (b"2", '"meta-2"')
        self.assertEqual(self.recheck(), (self.upstream, "live"))


    def test_retains_newer_history_revision_at_the_same_observation_cursor(self):
        archive_path, annual_path, future_path = TIDE_PATHS

        def snapshot(revision, height):
            archive = json.dumps({
                "site": "01411360",
                "datum": "NAVD88",
                "method": "individual_high_tides_v3",
                "countUnit": "individual-high-tide",
                "lastProcessedISO": "2026-11-22T10:00:00Z",
                "generatedAt": revision,
                "events": [{"cycleId": "test-a", "ft": height}],
            }).encode()
            source = {"sourceSHA256": sha256(archive).hexdigest(),
                      "countUnit": "individual-high-tide"}
            bodies = {
                archive_path: archive,
                annual_path: json.dumps(dict(source, schema="individual-high-tide-counts-v3")).encode(),
                future_path: json.dumps(dict(source, schema="individual-high-tide-projections-v3",
                                             scenarios={"Baseline": [{"year": 2027}]})).encode(),
            }
            return {name: (body, sha256(body).hexdigest()) for name, body in bodies.items()}

        newer = snapshot("2026-11-22T11:00:00Z", 4.2)
        older = snapshot("2026-11-22T10:30:00Z", 4.1)
        self.upstream = newer
        self.bundle = LiveBundle(TIDE_PATHS, validate_history, fetch=lambda name, _: self.upstream[name])
        self.assertEqual(self.bundle.read(), (newer, "live"))

        self.upstream = older
        self.assertEqual(self.recheck(), (newer, "retained"))

        newest = snapshot("2026-11-22T11:30:00Z", 4.3)
        self.upstream = newest
        self.assertEqual(self.recheck(), (newest, "live"))
