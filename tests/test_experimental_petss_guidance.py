import unittest

from tools.experimental_petss_guidance import build_root


class ExperimentalPetssGuidanceTest(unittest.TestCase):
    def test_adjusted_guidance_requires_raw_mean_and_lower_tail_levels(self):
        time = "2026-11-15T12:00:00Z"
        source_time = "2026-11-15T12:30:00Z"
        mean = {"timeUtc": time, "sourceTimeUtc": source_time, "mllwStageFt": 5, "tideMllwFt": 3}
        lower = {"timeUtc": time, "sourceTimeUtc": source_time, "mllwStageFt": 4}
        forecast = {
            "sourceDatum": "MLLW",
            "petssCycleUtc": "2026-11-15T00:00:00Z",
            "predictionStageAdjustmentFt": 1,
            "predictionTimeShiftMinutes": -30,
            "forecasts": {"mean": {"hours": [mean]}, "lowEnd": {"hours": [lower]}},
        }

        for raw_mean, raw_lower, expected in [(None, 3, "unavailable"), (4, None, "unavailable"), (4, 3, "experimental")]:
            with self.subTest(raw_mean=raw_mean, raw_lower=raw_lower):
                mean.pop("rawPetssTwlMllwFt", None)
                lower.pop("rawPetssTwlMllwFt", None)
                if raw_mean is not None:
                    mean["rawPetssTwlMllwFt"] = raw_mean
                if raw_lower is not None:
                    lower["rawPetssTwlMllwFt"] = raw_lower
                result = build_root(forecast)[0]["hours"][0]
                self.assertEqual(result["availability"], expected)
                if expected == "experimental":
                    self.assertEqual(result["issuedMeanMllwFt"], 5)
                    self.assertEqual(result["issued90ExceedanceMllwFt"], 4)

    def test_unadjusted_guidance_keeps_legacy_level_field(self):
        time = "2026-11-15T12:00:00Z"
        forecast = {
            "sourceDatum": "MLLW",
            "petssCycleUtc": "2026-11-15T00:00:00Z",
            "forecasts": {
                "mean": {"hours": [{"timeUtc": time, "mllwStageFt": 5, "tideMllwFt": 3}]},
                "lowEnd": {"hours": [{"timeUtc": time, "mllwStageFt": 4}]},
            },
        }

        result = build_root(forecast)[0]["hours"][0]
        self.assertEqual(result["issuedMeanMllwFt"], 5)
        self.assertEqual(result["issued90ExceedanceMllwFt"], 4)
