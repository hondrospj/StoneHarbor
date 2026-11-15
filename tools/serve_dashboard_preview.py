#!/usr/bin/env python3
"""Serve the local Stone Harbor dashboard with current public data on loopback."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from hashlib import sha256
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
import re
import sys
from threading import Lock
from time import monotonic
from urllib.error import HTTPError
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".shorelysafe"))
from publish import FORECAST_PATHS, TIDE_PATHS, _forecast_bundle, _tide_bundle, _tide_time


PUBLIC_DASHBOARD = "https://cupajoe.live/stone-harbor/flooddashboard/"
MAX_DATA_BYTES = 32 * 1024 * 1024
FUTURE_COUNTS = re.compile(rb"^const FUTURE_FLOOD_PREDICTIONS = .*;$", re.M)


def download(path, previous):
    url = PUBLIC_DASHBOARD + path
    headers = {"Cache-Control": "no-cache"}
    if previous:
        headers["If-None-Match"] = previous[1]
    try:
        with urlopen(Request(url, headers=headers), timeout=6) as response:
            if response.geturl() != url:
                raise ValueError("Unexpected redirect from the public dashboard")
            data = response.read(MAX_DATA_BYTES + 1)
            if len(data) > MAX_DATA_BYTES:
                raise ValueError(f"Public dashboard file exceeds the size limit: {path}")
            return data, response.headers.get("ETag") or f'"{sha256(data).hexdigest()}"'
    except HTTPError as error:
        if error.code == 304 and previous is not None:
            return previous
        raise


def validate_history(bodies):
    archive = json.loads(bodies[TIDE_PATHS[0]])
    cursor = _tide_time(archive.get("lastProcessedISO"))
    if (archive.get("site") != "01411360" or archive.get("datum") != "NAVD88"
            or archive.get("method") != "individual_high_tides_v3"
            or archive.get("countUnit") != "individual-high-tide" or cursor is None):
        raise ValueError("Public tide archive does not match Stone Harbor")
    annual, future = (json.loads(bodies[path]) for path in TIDE_PATHS[1:])
    _tide_bundle(bodies[TIDE_PATHS[0]], annual, future)
    json.dumps(future["scenarios"], allow_nan=False)
    return cursor


class LiveBundle:
    def __init__(self, paths, validate, fetch=download):
        self.paths = paths
        self.validate = validate
        self.fetch = fetch
        self.files = {}
        self.revision = None
        self.next_check = 0
        self.status = "unavailable"
        self.lock = Lock()

    def read(self):
        with self.lock:
            if monotonic() < self.next_check:
                return self.files, self.status
            try:
                with ThreadPoolExecutor(max_workers=len(self.paths)) as pool:
                    files = dict(zip(self.paths, pool.map(
                        self.fetch, self.paths, [self.files.get(path) for path in self.paths]
                    ), strict=True))
                if files != self.files:
                    revision = self.validate({name: file[0] for name, file in files.items()})
                    if self.revision is not None and revision < self.revision:
                        raise ValueError("Public data is older than the retained snapshot")
                    self.files, self.revision = files, revision
                self.status = "live"
            except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
                self.status = "retained" if self.files else "unavailable"
                print(f"{self.paths[0]}: {self.status} ({error})", file=sys.stderr, flush=True)
            self.next_check = monotonic() + (60 if self.status == "live" else 15)
            return self.files, self.status


class PreviewHandler(SimpleHTTPRequestHandler):
    def guess_type(self, path):
        return "image/png" if Path(path).name == "shorelysafe" else super().guess_type(path)

    def send_head(self):
        if self.headers.get("Host") not in {f"127.0.0.1:{self.server.server_port}",
                                          f"localhost:{self.server.server_port}"}:
            self.send_error(421)
            return None
        route = unquote(urlsplit(self.path).path).lstrip("/")
        if route in self.server.live:
            files, status = self.server.live[route].read()
            if not files:
                self.send_error(503, "Current public dashboard data unavailable")
                return None
            data, etag = files[route]
            return self.respond(data, self.guess_type(route), status, etag)
        if route in ("", "index.html"):
            return self.local_dashboard()
        if route.startswith(("assets/", "data/")) and all(not part.startswith(".") for part in route.split("/")):
            file = (ROOT / route).resolve()
            if file.is_relative_to(ROOT) and file.is_file():
                return super().send_head()
        self.send_error(404)
        return None

    def local_dashboard(self):
        html = (ROOT / "index.html").read_bytes()
        history, status = self.server.live[TIDE_PATHS[0]].read()
        if history:
            future = json.loads(history[TIDE_PATHS[2]][0])["scenarios"]
            scenarios = json.dumps(future, separators=(",", ":"), allow_nan=False).replace("<", "\\u003c")
            constant = f"const FUTURE_FLOOD_PREDICTIONS = {scenarios};".encode()
            html = FUTURE_COUNTS.sub(lambda _: constant, html, count=1)
        return self.respond(html, "text/html; charset=utf-8", status)

    def respond(self, data, content_type, status, etag=None):
        not_modified = etag is not None and self.headers.get("If-None-Match") == etag
        self.send_response(304 if not_modified else 200)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Dashboard-Data", status)
        if etag is not None:
            self.send_header("ETag", etag)
        if not not_modified:
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        return None if not_modified else BytesIO(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=51414)
    args = parser.parse_args()
    forecast = LiveBundle(FORECAST_PATHS, _forecast_bundle)
    history = LiveBundle(TIDE_PATHS, validate_history)
    handler = partial(PreviewHandler, directory=ROOT)
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        server.live = {path: bundle for bundle in (forecast, history) for path in bundle.paths}
        print(f"Stone Harbor dashboard preview at http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
