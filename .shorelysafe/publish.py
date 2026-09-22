#!/usr/bin/env python3
"""Publish static GitHub app files to the ShorelySafe WordPress plugin."""
import argparse
import base64
import hashlib
import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ALLOWED = {'.html','.htm','.js','.mjs','.css','.json','.geojson','.csv','.txt','.png','.jpg','.jpeg',
           '.gif','.webp','.svg','.ico','.tif','.tiff','.wasm','.woff','.woff2','.ttf','.map'}
TEXT = {'.html','.htm','.js','.mjs','.css','.json','.geojson','.csv','.txt','.svg','.map'}

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
