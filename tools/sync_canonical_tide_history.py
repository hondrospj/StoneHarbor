#!/usr/bin/env python3
"""Hydrate a newer published canonical tide snapshot before a scheduled rebuild.

Public HTTPS history remains usable while private CI is paused. Validate the
complete archive/count/model bundle and source UI before replacing local files.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.request

APPS = {'flooddashboard--stone-harbor': ('stone-harbor', '01411360'),
        'flooddashboard--sandy-hook': ('sandy-hook', '8531680'),
        'flooddashboard--cape-may-harbor': ('cape-may-harbor', '01411390')}
NAMES = ('peaks_navd88.json', 'annual_flood_counts.json', 'future_flood_counts.json')
MAX_BYTES = 64 * 1024 * 1024
MIN_TIME = dt.datetime.min.replace(tzinfo=dt.timezone.utc)


def instant(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(dt.timezone.utc) if parsed.tzinfo else None
    except ValueError:
        return None


def timestamp(cache):
    cursor = instant(cache.get('lastProcessedISO'))
    if cursor is None:
        raise ValueError('Canonical tide observation cursor must include a valid timezone')
    revisions = [cache.get(k) for k in ('generatedAt', 'generatedUTC', 'generatedAtUtc',
                 'latestObservationUtc', 'observedThrough', 'observedThroughISO')]
    if isinstance(cache.get('liveUpdate'), dict):
        revisions.append(cache['liveUpdate'].get('observedThrough'))
    return cursor, max((instant(value) or MIN_TIME for value in revisions), default=MIN_TIME)


def get(url):
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=120) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('Canonical tide file exceeds size bound')
    return data


def object_json(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise ValueError('Canonical tide file must be bounded JSON bytes')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('Canonical tide JSON object required')
    return value


def validate_bundle(bodies, cache):
    sha = hashlib.sha256(bodies[NAMES[0]]).hexdigest()
    annual, future = (object_json(bodies[name]) for name in NAMES[1:])
    for value, schema in ((annual, 'individual-high-tide-counts-v3'),
                          (future, 'individual-high-tide-projections-v3')):
        if value.get('sourceSHA256') != sha:
            raise ValueError('Published count/model files do not bind the same tide archive')
        if value.get('schema') != schema or value.get('countUnit') != 'individual-high-tide':
            raise ValueError('Published count/model schema is not canonical v3')
    scenarios = future.get('scenarios')
    if not isinstance(scenarios, dict) or not scenarios or any(
            not isinstance(rows, list) or not rows for rows in scenarios.values()):
        raise ValueError('Published future tide scenarios are missing or invalid')
    # Reject nonfinite values before embedding JSON into the source HTML.
    json.dumps(scenarios, allow_nan=False)
    events = cache.get('events')
    if not isinstance(events, list) or not events:
        raise ValueError('Published canonical tide archive has no events')
    identities = set()
    for event in events:
        if not isinstance(event, dict):
            raise ValueError('Invalid published tide event')
        key, height = event.get('cycleId'), event.get('ft')
        if (not isinstance(key, str) or not key or key in identities
                or isinstance(height, bool) or not isinstance(height, (int, float))
                or not math.isfinite(height) or abs(height) >= 100
                or event.get('kind') not in ('HighTide', 'OfficialCrest')):
            raise ValueError('Invalid or duplicate published cycle identity/elevation/kind')
        if event.get('timeUnknown') is not True and instant(event.get('t')) is None:
            raise ValueError('Published measured tide lacks an observation timestamp')
        identities.add(key)
    return sha, future, len(identities)


def install_snapshot(root, staged):
    """Stage every file first, and restore prior bytes if replacement fails."""
    originals = {dest: dest.read_bytes() for dest in staged}
    with tempfile.TemporaryDirectory(prefix='.canonical-tide-sync-', dir=root) as temporary:
        directory = Path(temporary)
        pending, backups = {}, {}
        for number, (dest, body) in enumerate(staged.items()):
            pending[dest] = directory / (str(number) + '.new')
            backups[dest] = directory / (str(number) + '.old')
            pending[dest].write_bytes(body)
            backups[dest].write_bytes(originals[dest])
        replaced = []
        try:
            for dest, pending_file in pending.items():
                os.replace(pending_file, dest)
                replaced.append(dest)
        except OSError:
            for dest in reversed(replaced):
                os.replace(backups[dest], dest)
            raise


def sync(root, app, fetch=get):
    if app not in APPS:
        raise ValueError('Application is outside the selected three-dashboard scope')
    if os.environ.get('SHORELYSAFE_FORCE_TIDE_SOURCE') == 'reviewed':
        return {'app': app, 'synced': False, 'reason': 'explicit reviewed source rebuild'}
    root = Path(root)
    local = object_json((root / 'data' / NAMES[0]).read_bytes())
    slug, station = APPS[app]
    if (local.get('method') != 'individual_high_tides_v3'
            or local.get('countUnit') != 'individual-high-tide'):
        raise ValueError('Canonical v3 source archive required before synchronization')
    if str(local.get('site')) != station or local.get('datum') != 'NAVD88':
        raise ValueError('Local tide gauge/datum does not match the selected dashboard')
    local_timestamp = timestamp(local)
    for attempt in range(3):
        nonce = str(time.time_ns())
        base = 'https://cupajoe.live/shorelysafe/flooddashboard/' + slug + '/data/'
        try:
            bodies = {name: fetch(base + name + '?canonical-sync=' + nonce) for name in NAMES}
            live = object_json(bodies[NAMES[0]])
            compatible = all(live.get(k) == local.get(k) for k in
                             ('site', 'datum', 'method', 'countUnit', 'thresholdsNAVD88', 'schema'))
            if not compatible:
                return {'app': app, 'synced': False,
                        'reason': 'published archive is a different reviewed schema/gauge/threshold revision'}
            sha, future, event_count = validate_bundle(bodies, live)
            if timestamp(live) <= local_timestamp:
                return {'app': app, 'synced': False, 'reason': 'local canonical archive is current or newer'}
            index = root / 'index.html'
            html = index.read_bytes().decode('utf-8')
            constant = 'const FUTURE_FLOOD_PREDICTIONS = ' + json.dumps(
                future['scenarios'], separators=(',', ':'), allow_nan=False) + ';'
            html, count = re.subn(r'^const FUTURE_FLOOD_PREDICTIONS = .*;$',
                                  lambda match: constant, html, flags=re.M)
            if count != 1:
                raise ValueError('One embedded tide projection constant required')
            staged = {root / 'data' / name: body for name, body in bodies.items()}
            staged[index] = html.encode('utf-8')
        except (ValueError, KeyError):
            if attempt == 2:
                raise
            time.sleep(.4)
            continue
        install_snapshot(root, staged)
        return {'app': app, 'synced': True, 'events': event_count,
                'sourceSHA256': sha, 'lastProcessedISO': live['lastProcessedISO']}
    raise RuntimeError('Could not read a consistent published canonical tide bundle')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app', choices=APPS, required=True)
    args = parser.parse_args()
    print(json.dumps(sync(Path.cwd(), args.app)))


if __name__ == '__main__':
    main()
