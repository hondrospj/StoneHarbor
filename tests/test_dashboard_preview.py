import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from serve_dashboard_preview import LiveBundle


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
