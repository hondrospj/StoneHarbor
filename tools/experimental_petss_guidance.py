"""Generate a non-operational PETSS comparison sidecar without changing official data.

This deliberately does not replace map or alert levels. The pooled formula is
not validated at all sites and its lower-quartile estimate is miscalibrated.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
from functools import lru_cache
import io
import json
import math
from pathlib import Path
import re
import tarfile
import urllib.request


VERSION = "research-pooled-v2-90-exceedance-20260923"
ANCHORS = (
    # Model lead hours, tide-relative gain, offset in feet, q25 residual offset.
    (12.0, 0.69, 0.17639, -0.201845),
    (24.0, 0.60, 0.23020, -0.217000),
    (48.0, 0.57, 0.24387, -0.220760),
    (72.0, 0.56, 0.24668, -0.230950),
)
SPREAD_GAIN = 0.1
MAX_MODEL_LEAD_HOURS = 72.0


def utc(value):
    if not isinstance(value, str):
        raise ValueError("Expected UTC timestamp")
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def finite(value):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) and -50 < result < 50 else None


def coefficients(lead):
    if lead < ANCHORS[0][0] or lead > MAX_MODEL_LEAD_HOURS:
        return None
    if lead <= ANCHORS[0][0]:
        return ANCHORS[0][1:], "in-range"
    if lead >= ANCHORS[-1][0]:
        return ANCHORS[-1][1:], "in-range"
    for left, right in zip(ANCHORS, ANCHORS[1:]):
        if left[0] <= lead <= right[0]:
            part = (lead - left[0]) / (right[0] - left[0])
            return tuple(left[i] + part * (right[i] - left[i]) for i in (1, 2, 3)), "in-range"
    raise AssertionError("Unreachable lead interpolation")


def guidance_row(valid_utc, cycle_utc, mean, tide, lower10):
    lead = (utc(valid_utc) - utc(cycle_utc)).total_seconds() / 3600
    values = {"validUtc": valid_utc, "modelLeadHours": round(lead, 3)}
    selected = coefficients(lead)
    if selected is None or mean is None or tide is None:
        return dict(values, availability="unavailable", reason="unsupported lead or missing mean/tide")
    (gain, offset, q25_offset), support = selected
    central = tide + gain * (mean - tide) + offset
    values.update(availability="experimental", support=support,
                  issuedMeanMllwFt=round(mean, 3), astronomicalTideMllwFt=round(tide, 3),
                  correctedCentralMllwFt=round(central, 3))
    if lower10 is not None and lower10 <= mean + 0.05:
        q25 = central + q25_offset + SPREAD_GAIN * (lower10 - mean)
        shifted_low = central + (lower10 - mean)
        values.update(issuedLower10MllwFt=round(lower10, 3),
                      issued90ExceedanceMllwFt=round(lower10, 3),
                      biasShifted90ExceedanceMllwFt=round(shifted_low, 3),
                      estimatedLowerQuartileMllwFt=round(q25, 3))
    else:
        values.update(issued90ExceedanceMllwFt=None,
                      biasShifted90ExceedanceMllwFt=None,
                      estimatedLowerQuartileMllwFt=None,
                      lowerTailReason="missing or inconsistent issued 90%-exceedance level")
    return values


def source_metadata():
    return {
        "version": VERSION,
        "official": False,
        "useForMapsOrAlerts": False,
        "primaryResearchLine": "biasShifted90ExceedanceMllwFt",
        "pointFormula": "tide + lead_gain*(issued_mean-tide) + lead_offset_ft",
        "biasShifted90ExceedanceFormula": "corrected_central + (issued_90_percent_exceedance - issued_mean)",
        "biasShifted90ExceedanceMeaning": "Research shift of NOAA's low-end 90%-exceedance guidance; NOT an observation-calibrated 90% exceedance level",
        "lowerQuartileFormula": "corrected_central + lead_q25_offset_ft + 0.1*(issued_lower10-issued_mean)",
        "lowerQuartileStatus": "Retained as a historical comparison, not the primary research line",
        "coefficients": [{"modelLeadHours": h, "gain": gain, "offsetFt": offset, "q25OffsetFt": q25}
                         for h, gain, offset, q25 in ANCHORS],
        "interpolation": "Linear between 12/24/48/72-hour anchors; unavailable outside the tested 12–72-hour model-lead range",
        "validation": "Ten directly observed NOAA gauges; 2021-2024 fit, 2025 and Jan-Aug 2026 test. NOT universal.",
        "above6FtBacktest": {
            "definition": "Hourly MLLW >6.0 ft; 10 observed gauges; forecast cases repeat tides across cycles and leads",
            "2025": {"issuedMeanMisses": 1552, "issuedMeanFalseAlarms": 1357,
                     "biasShifted90ExceedanceMisses": 1835,
                     "biasShifted90ExceedanceFalseAlarms": 761},
            "2026JanAug": {"issuedMeanMisses": 899, "issuedMeanFalseAlarms": 692,
                           "biasShifted90ExceedanceMisses": 955,
                           "biasShifted90ExceedanceFalseAlarms": 455},
        },
        "pooledBacktest": {
            "2025": {"issuedMaeFt": 0.458, "correctedMaeFt": 0.401,
                     "issuedHighThresholdMissCases": 236, "correctedHighThresholdMissCases": 300,
                     "estimatedLowerQuartileMissCases": 340},
            "2026JanAug": {"issuedMaeFt": 0.407, "correctedMaeFt": 0.352,
                           "issuedHighThresholdMissCases": 123, "correctedHighThresholdMissCases": 151,
                           "estimatedLowerQuartileMissCases": 216},
            "highThresholdDefinition": "Each station's training-period observed 99th percentile; counts repeat forecast cases, not storms",
        },
        "warning": "Research-only. The low-end line reduces false alarms but increases missed >6-ft tides. Issued NOAA 90%-exceedance guidance was not observed-calibrated to 90% at all sites; the bias-shifted line has no 90% probability guarantee. Keep issued PETSS for maps and alerts.",
    }


def root_forecasts(data):
    if "zones" in data:
        return [(name, (record.get("forecast") or record)) for name, record in data["zones"].items()]
    return [("default", data)]


def cycle_freshness(cycle):
    age = (datetime.now(timezone.utc) - utc(cycle)).total_seconds() / 3600
    return round(age, 2), 0 <= age <= 24


def build_root(data):
    zones = []
    for name, forecast in root_forecasts(data):
        if forecast.get("sourceDatum") != "MLLW":
            zones.append({"zoneId": name, "status": "unsupported", "reason": "source datum is not MLLW"})
            continue
        products = forecast.get("forecasts") or {}
        mean_hours = (products.get("mean") or {}).get("hours") or forecast.get("hours") or []
        low_hours = (products.get("lowEnd") or {}).get("hours") or []
        if not mean_hours or not forecast.get("petssCycleUtc"):
            zones.append({"zoneId": name, "status": "unsupported", "reason": "missing mean hours or cycle"})
            continue
        adjusted = "predictionStageAdjustmentFt" in forecast or "predictionTimeShiftMinutes" in forecast
        adjustment = finite(forecast.get("predictionStageAdjustmentFt")) if adjusted else 0.0
        if adjusted and (adjustment is None or forecast.get("predictionTimeShiftMinutes") is None):
            zones.append({"zoneId": name, "status": "unsupported", "reason": "incomplete local prediction adjustment metadata"})
            continue
        time_key = "sourceTimeUtc" if adjusted else "timeUtc"
        level_key = "rawPetssTwlMllwFt" if adjusted else "twlMllwFt"
        lower_by_time = {r.get(time_key): finite(r.get(level_key, r.get("mllwStageFt"))) for r in low_hours}
        hours = []
        for row in mean_hours:
            display_time = row.get("timeUtc")
            source_time = row.get(time_key)
            if not display_time or not source_time:
                continue
            mean = finite(row.get(level_key, row.get("mllwStageFt")))
            lower10 = lower_by_time.get(source_time)
            if adjusted and (mean is None or lower10 is None):
                # Never silently mix a locally shifted stage with the raw tide.
                result = {"validUtc": display_time, "sourceValidUtc": source_time,
                          "availability": "unavailable", "reason": "missing raw PETSS adjusted-product levels"}
            else:
                result = guidance_row(source_time, forecast["petssCycleUtc"], mean,
                                      finite(row.get("tideMllwFt")), lower10)
                if adjusted:
                    result["sourceValidUtc"] = source_time
                    result["validUtc"] = display_time
                    for field in ("issuedMeanMllwFt", "issuedLower10MllwFt",
                                  "issued90ExceedanceMllwFt", "biasShifted90ExceedanceMllwFt",
                                  "correctedCentralMllwFt", "estimatedLowerQuartileMllwFt"):
                        if result.get(field) is not None:
                            result[field] = round(result[field] + adjustment, 3)
            hours.append(result)
        age, fresh = cycle_freshness(forecast["petssCycleUtc"])
        zones.append({"zoneId": name, "stationId": forecast.get("stationId"),
                      "petssCycleUtc": forecast["petssCycleUtc"], "sourceUrl": forecast.get("sourceUrl"),
                      "cycleAgeHours": age,
                      "status": ("experimental" if fresh else "stale") if any(r["availability"] == "experimental" for r in hours) else "unavailable",
                      "hours": hours})
        if adjusted:
            zones[-1]["localStageAdjustmentFt"] = adjustment
            zones[-1]["localTimeShiftMinutes"] = forecast["predictionTimeShiftMinutes"]
            zones[-1]["adjustmentNote"] = "Model lead uses raw source time; displayed levels and validUtc include the dashboard's local shift."
    return zones


def legacy_cycle(meta):
    match_date = re.search(r"petss\.(\d{8})", str(meta.get("run_dir", "")))
    match_hour = re.fullmatch(r"t(\d{2})z", str(meta.get("cycle", "")))
    if not match_date or not match_hour:
        raise ValueError("Cannot determine PETSS model cycle from metadata")
    return datetime.strptime(match_date[1] + match_hour[1], "%Y%m%d%H").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


@lru_cache(maxsize=4)
def noaa_tarball(url):
    request = urllib.request.Request(url, headers={"User-Agent": "floodmapper-experimental-sidecar/1.0"})
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read()


def legacy_lower10(meta):
    url = meta.get("source_url")
    station = str(meta.get("stid", ""))
    if not url or not station or not url.startswith("https://nomads.ncep.noaa.gov/"):
        raise ValueError("Missing or untrusted NOAA source URL/station")
    payload = noaa_tarball(url)
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as tar:
        member = next((m for m in tar.getmembers() if m.isfile() and m.name.endswith("/" + station + ".csv")), None)
        if member is None:
            raise ValueError("Station CSV missing from matching NOAA cycle")
        extracted = tar.extractfile(member)
        if extracted is None:
            raise ValueError("Cannot extract station CSV")
        lines = extracted.read().decode("utf-8", "replace").splitlines()
    reader = csv.DictReader(lines, skipinitialspace=True)
    if not reader.fieldnames:
        raise ValueError("NOAA station CSV missing header")
    result = {}
    adjustment = finite(meta.get("local_adjustment_ft")) or 0.0
    for row in reader:
        clean = {str(k).strip().upper(): v for k, v in row.items() if k is not None}
        raw = finite(clean.get("TWL90P"))
        stamp = str(clean.get("TIME", "")).strip()
        if raw is not None and re.fullmatch(r"\d{12}", stamp):
            result[stamp] = raw + adjustment
    if not result:
        raise ValueError("No valid NOAA lower-10th hourly levels")
    return result


def build_legacy(rows, meta):
    if meta.get("datum") != "MLLW":
        return [{"zoneId": "default", "status": "unsupported", "reason": "metadata datum is not MLLW"}]
    cycle = legacy_cycle(meta)
    try:
        lower_by_source_time = legacy_lower10(meta)
        lower_error = None
    except (OSError, ValueError, tarfile.TarError) as exc:
        lower_by_source_time = {}
        lower_error = str(exc)
    hours = []
    for row in rows:
        valid = row.get("t")
        if not valid:
            continue
        lower = lower_by_source_time.get(str(row.get("src_time", "")))
        hours.append(guidance_row(valid, cycle, finite(row.get("twl")), finite(row.get("tide")), lower))
    age, fresh = cycle_freshness(cycle)
    zone = {"zoneId": "default", "stationId": meta.get("stid"), "petssCycleUtc": cycle,
            "sourceUrl": meta.get("source_url"), "cycleAgeHours": age,
            "status": ("experimental" if fresh else "stale") if any(r["availability"] == "experimental" for r in hours) else "unavailable",
            "hours": hours}
    if lower_error:
        zone["lowerTailSourceError"] = lower_error
    return [zone]


def build(data, meta=None):
    zones = build_legacy(data, meta or {}) if isinstance(data, list) else build_root(data)
    return {"schema": "experimental-petss-guidance-v1", "generatedUtc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "model": source_metadata(), "zones": zones}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--meta")
    parser.add_argument("--output", default="data/experimental_petss_guidance.json")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    data = json.loads(Path(args.input).read_text())
    meta = json.loads(Path(args.meta).read_text()) if args.meta else None
    result = build(data, meta)
    summary = [{"zone": z["zoneId"], "status": z["status"], "rows": len(z.get("hours", [])),
                "q25Rows": sum(r.get("estimatedLowerQuartileMllwFt") is not None for r in z.get("hours", []))}
               for z in result["zones"]]
    if not args.check:
        target = Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
