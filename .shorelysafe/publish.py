#!/usr/bin/env python3
"""Publish static GitHub app files to the ShorelySafe WordPress plugin."""
import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
ALLOWED = {'.html','.htm','.js','.mjs','.css','.json','.geojson','.csv','.txt','.png','.jpg','.jpeg',
           '.gif','.webp','.svg','.ico','.tif','.tiff','.wasm','.woff','.woff2','.ttf','.map'}
TEXT = {'.html','.htm','.js','.mjs','.css','.json','.geojson','.csv','.txt','.svg','.map'}

TIDE_APPS = {'flooddashboard--stone-harbor', 'flooddashboard--sandy-hook',
             'flooddashboard--cape-may-harbor'}
TIDE_PATHS = ('data/peaks_navd88.json', 'data/annual_flood_counts.json',
              'data/future_flood_counts.json')

def _tide_json(data, entry, name):
    if (not isinstance(entry, dict) or entry.get('size') != len(data)
            or entry.get('sha256') != hashlib.sha256(data).hexdigest()):
        raise ValueError('Tide file differs from its manifest: ' + name)
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError('Tide JSON object required: ' + name)
    return value

def _prepared_tide_bytes(manifest, payloads, name):
    entry = next((f for f in manifest['files'] if f['path'] == name), None)
    if entry is None:
        raise ValueError('Missing prepared tide file: ' + name)
    path, data = payloads[entry['sha256']]
    return entry, data if data is not None else path.read_bytes()

def public_tide_file(site, app, name, entry):
    """Read public bytes, bounded and verified against authenticated state."""
    sha, size = entry.get('sha256'), entry.get('size')
    if (not isinstance(sha, str) or not re.fullmatch(r'[a-f0-9]{64}', sha)
            or type(size) is not int or not 0 <= size <= 128 * 1024 * 1024):
        raise ValueError('Invalid live tide manifest entry: ' + name)
    url = site.rstrip('/') + '/' + app['path'].strip('/') + '/' + name
    req = urllib.request.Request(url + '?tide_sha256=' + sha,
                                 headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(req, timeout=120) as response:
        data = response.read(size + 1)
    _tide_json(data, entry, name)
    return data

def _canonical_tides(cache):
    return (cache.get('method') == 'individual_high_tides_v3'
            and cache.get('countUnit') == 'individual-high-tide')

def _tide_bundle(cache_bytes, annual, future):
    sha = hashlib.sha256(cache_bytes).hexdigest()
    for value, schema in ((annual, 'individual-high-tide-counts-v3'),
                          (future, 'individual-high-tide-projections-v3')):
        if (value.get('sourceSHA256') != sha or value.get('schema') != schema
                or value.get('countUnit') != 'individual-high-tide'):
            raise ValueError('Tide statistics do not bind the canonical archive SHA256')
    if not isinstance(future.get('scenarios'), dict) or not future['scenarios']:
        raise ValueError('Canonical future tide scenarios are missing')
    return sha

def _tide_time(value):
    if not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except ValueError:
        return None

def _tide_revision_time(cache):
    values = [cache.get(k) for k in ('generatedAt', 'generatedAtUtc', 'generatedUTC',
              'latestObservationUtc', 'observedThrough', 'observedThroughISO')]
    if isinstance(cache.get('liveUpdate'), dict):
        values.append(cache['liveUpdate'].get('observedThrough'))
    times = [t for value in values if (t := _tide_time(value)) is not None]
    return max(times) if times else None

def preserve_live_tide_data(app, source, manifest, payloads, site, token):
    """Keep a newer compatible live v3 archive during a source/UI publication.

    Only prepared bytes change; tracked source files and all other assets retain
    normal publication behavior. The returned state is rechecked before commit.
    """
    if app['id'] not in TIDE_APPS:
        return {}, None
    entries = {f['path']: f for f in manifest['files']}
    if TIDE_PATHS[0] not in entries:
        return {}, None
    cache_entry, cache_bytes = _prepared_tide_bytes(manifest, payloads, TIDE_PATHS[0])
    cache = _tide_json(cache_bytes, cache_entry, TIDE_PATHS[0])
    if not _canonical_tides(cache):
        return {}, None
    local = {}
    for name in TIDE_PATHS[1:]:
        entry, data = _prepared_tide_bytes(manifest, payloads, name)
        local[name] = _tide_json(data, entry, name)
    local_sha = _tide_bundle(cache_bytes, *(local[p] for p in TIDE_PATHS[1:]))
    state = api(site, app['id'], token, 'state?manifest=1')
    summary = {'preservedLiveTideData': False, 'tideSourceSHA256': local_sha,
               'baseDeployment': state.get('deployment')}
    if not state.get('published'):
        return summary, state
    if not state.get('deployment'):
        raise ValueError('Published tide deployment identity is missing')
    live_files = state.get('manifest', {}).get('files')
    if not isinstance(live_files, dict):
        raise ValueError('Published tide manifest is missing')
    # A first v3 migration may replace a deployment with no canonical archive.
    if TIDE_PATHS[0] not in live_files:
        return summary, state
    live_bytes = {TIDE_PATHS[0]: public_tide_file(site, app, TIDE_PATHS[0], live_files[TIDE_PATHS[0]])}
    live_cache = _tide_json(live_bytes[TIDE_PATHS[0]], live_files[TIDE_PATHS[0]], TIDE_PATHS[0])
    identity = ('site', 'datum', 'thresholdsNAVD88', 'method', 'countUnit', 'schema')
    # Reviewed gauge/datum/threshold/schema changes must reach the live site.
    if (not _canonical_tides(live_cache)
            or any(live_cache.get(k) != cache.get(k) for k in identity)):
        return summary, state
    if any(cache.get(k) is None for k in ('site', 'datum', 'thresholdsNAVD88')):
        raise ValueError('Canonical tide identity is incomplete')
    live = {}
    for name in TIDE_PATHS[1:]:
        if name not in live_files:
            raise ValueError('Live canonical tide statistics are missing: ' + name)
        live_bytes[name] = public_tide_file(site, app, name, live_files[name])
        live[name] = _tide_json(live_bytes[name], live_files[name], name)
    live_sha = _tide_bundle(live_bytes[TIDE_PATHS[0]], *(live[p] for p in TIDE_PATHS[1:]))
    local_cursor, live_cursor = (_tide_time(c.get('lastProcessedISO')) for c in (cache, live_cache))
    if local_cursor is None or live_cursor is None:
        raise ValueError('Canonical tide observation cursor is invalid')
    newer = live_cursor > local_cursor
    if live_cursor == local_cursor and live_sha != local_sha:
        local_revision, live_revision = (_tide_revision_time(c) for c in (cache, live_cache))
        if local_revision is None or live_revision is None or local_revision == live_revision:
            raise ValueError('Different tide archives share a cursor without an ordered revision timestamp; refresh and retry')
        newer = live_revision > local_revision
    if not newer:
        return summary, state
    _, index_bytes = _prepared_tide_bytes(manifest, payloads, 'index.html')
    index = index_bytes.decode('utf-8')
    constant = 'const FUTURE_FLOOD_PREDICTIONS = ' + json.dumps(
        live[TIDE_PATHS[2]]['scenarios'], separators=(',', ':'), allow_nan=False) + ';'
    index, count = re.subn(r'^const FUTURE_FLOOD_PREDICTIONS = .*;$',
                           lambda match: constant, index, flags=re.M)
    if count != 1:
        raise ValueError('Expected one embedded future tide-count dataset')
    live_bytes['index.html'] = index.encode('utf-8')
    receipt_name = 'data/refresh_status.json'
    if receipt_name in entries:
        entry, data = _prepared_tide_bytes(manifest, payloads, receipt_name)
        receipt = _tide_json(data, entry, receipt_name)
        for field in ('files', 'payloads'):
            fingerprints = receipt.get(field)
            if not isinstance(fingerprints, dict):
                continue
            for name in TIDE_PATHS:
                if name not in fingerprints:
                    continue
                fingerprint = fingerprints[name]
                if not isinstance(fingerprint, dict):
                    raise ValueError('Invalid existing tide receipt fingerprint: ' + name)
                fingerprint['sha256'] = hashlib.sha256(live_bytes[name]).hexdigest()
                for size_key in ('size', 'bytes'):
                    if size_key in fingerprint:
                        fingerprint[size_key] = len(live_bytes[name])
        live_bytes[receipt_name] = (json.dumps(receipt, indent=2, allow_nan=False) + '\n').encode('utf-8')
    for name, data in live_bytes.items():
        sha = hashlib.sha256(data).hexdigest()
        entries[name].update(sha256=sha, size=len(data))
        payloads[sha] = (source / name, data)
    summary.update(preservedLiveTideData=True, tideSourceSHA256=live_sha)
    return summary, state

def prepare(app, source, apps):
    names = subprocess.check_output(['git','ls-files','-z'], cwd=source).decode().split('\0')
    replacements = [('https://hondrospj.github.io/' + a['repository'].split('/')[1] + '/', a['path']) for a in apps]
    files, payloads = [], {}
    for name in sorted(filter(None, names)):
        p = Path(name)
        if any(part.startswith('.') for part in p.parts) or p.parts[0] in {'tools','scripts','tests'}:
            continue
        if p.suffix.lower() not in ALLOWED and name != 'assets/shorelysafe': continue
        local = source / p
        if local.is_symlink(): raise ValueError('Symlink asset requires review: ' + name)
        data = local.read_bytes()
        if data.startswith(b'version https://git-lfs.github.com/spec/v1'):
            raise ValueError('Git LFS object was not downloaded: ' + name)
        if p.suffix.lower() in TEXT:
            text = data.decode('utf-8')
            for old,new in replacements: text = text.replace(old,new)
            data = text.encode('utf-8')
        sha = hashlib.sha256(data).hexdigest()
        files.append({'path':name,'sha256':sha,'size':len(data)})
        payloads.setdefault(sha, (local, data if p.suffix.lower() in TEXT else None))
    if not any(x['path']=='index.html' for x in files): raise ValueError('Application has no index.html')
    commit = subprocess.check_output(['git','rev-parse','HEAD'], cwd=source, text=True).strip()
    return {'files':files,'commit':commit}, payloads

def api(site, app_id, token, endpoint, method='GET', data=None, raw=False):
    url = site.rstrip('/') + '/wp-json/shorelysafe/v1/apps/' + app_id + '/' + endpoint
    body = data if raw else (json.dumps(data).encode() if data is not None else None)
    headers = {'X-ShorelySafe-Token':token, 'Content-Type':'application/octet-stream' if raw else 'application/json'}
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as response: return json.load(response)
        except urllib.error.HTTPError as error:
            response_body=error.read()
            try: result=json.loads(response_body)
            except (ValueError,UnicodeDecodeError): result={'message':'Server returned a non-JSON response; check the plugin and site URL.'}
            if error.code == 409 and raw: return result
            if (error.code < 500 and error.code != 429) or attempt == 3: raise RuntimeError(f'HTTP {error.code}: {result.get("message",result)}') from None
        except (urllib.error.URLError, TimeoutError):
            if attempt == 3: raise
        time.sleep(2 ** attempt)

def publish(app, source, apps, connection, dry_run=False):
    manifest, payloads = prepare(app, source, apps)
    summary = {'application':app['id'],'files':len(manifest['files']), 'bytes':sum(f['size'] for f in manifest['files']), 'commit':manifest['commit']}
    if dry_run: return summary
    site,token = connection['site'],connection['tokens'][app['id']]
    parsed = urllib.parse.urlparse(site)
    if parsed.scheme!='https' and parsed.hostname not in {'localhost','127.0.0.1'}: raise ValueError('HTTPS is required')
    tide_summary, tide_base = preserve_live_tide_data(app, source, manifest, payloads, site, token)
    summary.update(tide_summary)
    summary['bytes'] = sum(f['size'] for f in manifest['files'])
    plan = api(site,app['id'],token,'plan','POST',manifest)
    batch_supported=True
    uploaded=0
    def upload_one(sha,data):
        offset = 0
        while True:
            # Verified against cupajoe.live; also matches the plugin's chunk limit.
            chunk = data[offset:offset+4*1024*1024]
            endpoint = f'blobs/{sha}?deployment={plan["deployment"]}&offset={offset}'
            result = api(site,app['id'],token,endpoint,'PUT',chunk,raw=True)
            next_offset = result['offset']
            if next_offset<0 or next_offset>len(data): raise RuntimeError('Invalid upload offset from server')
            if result.get('complete'): break
            if next_offset==offset: raise RuntimeError('Upload made no progress')
            offset=next_offset
    def upload_batch(entries):
        nonlocal batch_supported,uploaded
        if not entries:return
        if batch_supported:
            try:
                api(site,app['id'],token,'batch?deployment='+plan['deployment'],'POST',
                    {'blobs':[{'sha256':sha,'data':base64.b64encode(data).decode('ascii')} for sha,data in entries]})
            except RuntimeError as error:
                if not str(error).startswith('HTTP 404:'):raise
                batch_supported=False
        if not batch_supported:
            for sha,data in entries:upload_one(sha,data)
        uploaded+=len(entries)
        print(f'{app["id"]}: uploaded {uploaded}/{len(plan["missing"])} changed files',flush=True)
    entries=[];batch_bytes=0
    for sha in plan['missing']:
        path,text_data=payloads[sha]
        data=text_data if text_data is not None else path.read_bytes()
        if len(data)>2*1024*1024:
            upload_batch(entries);entries=[];batch_bytes=0
            upload_one(sha,data);uploaded+=1
        else:
            if len(entries)>=128 or batch_bytes+len(data)>2*1024*1024:
                upload_batch(entries);entries=[];batch_bytes=0
            entries.append((sha,data));batch_bytes+=len(data)
    upload_batch(entries)
    if tide_base is not None:
        latest = api(site, app['id'], token, 'state')
        if latest.get('deployment') != tide_base.get('deployment'):
            raise RuntimeError('Live deployment changed during publication; refresh state and retry')
    result = api(site,app['id'],token,'commit','POST',{'deployment':plan['deployment']})
    summary.update(result); summary['uploaded_blobs']=len(plan['missing'])
    return summary

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app',required=True,help='An application ID, or all')
    parser.add_argument('--sources',type=Path,default=ROOT/'sources')
    parser.add_argument('--connection',type=Path)
    parser.add_argument('--catalog',type=Path,default=ROOT/'shorelysafe-products/apps.json')
    parser.add_argument('--dry-run',action='store_true')
    parser.add_argument('--clone-missing',action='store_true')
    args=parser.parse_args()
    apps=json.loads(args.catalog.read_text())
    selected=apps if args.app=='all' else [a for a in apps if a['id']==args.app]
    if not selected: parser.error('Unknown application ID')
    if not args.dry_run and not args.connection: parser.error('--connection is required for publishing')
    connection=json.loads(args.connection.read_text()) if args.connection else None
    results=[]
    for app in selected:
        source=args.sources/app['repository'].split('/')[1]
        try:
            if not source.exists() and args.clone_missing:
                source.parent.mkdir(parents=True,exist_ok=True)
                subprocess.run(['gh','repo','clone',app['repository'],str(source),'--','--depth=1'],check=True)
            if not source.exists(): raise RuntimeError(f'Missing checkout: {source}; use --clone-missing')
            result=publish(app,source,apps,connection,args.dry_run)
        except Exception as error:
            result={'application':app['id'],'error':str(error)}
        results.append(result)
        print(json.dumps(result),flush=True)
        (ROOT/'last-publish-report.json').write_text(json.dumps(results,indent=2)+'\n')
    if any('error' in r for r in results): raise SystemExit(1)

if __name__=='__main__': main()
