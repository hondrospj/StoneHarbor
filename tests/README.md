# Dashboard regression checks

Start a local preview with current Stone Harbor forecast and high-tide data:

```sh
python3 tools/serve_dashboard_preview.py
```

The preview listens on `http://127.0.0.1:51414/`. Pass `--port` to select a different port. The page and its assets come from the checkout. The server checks Cup A Joe for current data when the page requests it and retains the last validated snapshot during a temporary upstream failure. If the server has no validated snapshot, the affected data requests return HTTP 503. Inspect the `X-Dashboard-Data` response header for `live` or `retained` status.

Run the deterministic source and pipeline tests from the repository root:

```sh
node --test tests/*.test.cjs tests/*.test.js
python3 -m unittest discover -s tests -p 'test_*.py'
node tools/test_dashboard_input_guards.mjs index.html
node tools/test_dashboard_observations.mjs index.html
node tools/test_forecast_coverage.mjs index.html
```

The browser suites serve the actual application and retained data on localhost. They use fresh isolated headless contexts, verify vendor checksums, and replace external requests with controlled responses. They never attach to an existing browser or user profile. An advancing wall-clock offset keeps the tested date reproducible while allowing Chart.js animations to complete.

Prepare the three vendor files outside the checkout, then select an existing local Playwright installation and headless browser:

```sh
python3 tests/cache-dashboard-vendors.py --out /tmp/stone-harbor-dashboard-vendors
export DASHBOARD_VENDOR_DIR=/tmp/stone-harbor-dashboard-vendors
export DASHBOARD_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs
export DASHBOARD_BROWSER_ENGINE=chromium
export DASHBOARD_BROWSER_EXECUTABLE=/absolute/path/to/chromium
node tests/browser-ui-state-regressions.mjs
node tests/browser-observation-calculation-regressions.mjs
node tests/browser-sea-level-fallback-regressions.mjs
node tests/browser-loading-visibility-regressions.mjs
```

`DASHBOARD_BROWSER_ENGINE` also accepts `firefox` and `webkit` with a compatible installed Playwright driver/browser. Unset `DASHBOARD_BROWSER_EXECUTABLE` to use that driver's installed browser. `DASHBOARD_BROWSER_REPORT` saves a JSON receipt; `DASHBOARD_SOURCE_HTML` selects an older HTML snapshot for failure-first comparison. `cache-dashboard-vendors.py --offline` verifies an existing cache without downloading anything.

The regressions cover missing observations without rejecting genuine zero levels; recovery after observation gaps; threshold classifications, inclusive filters and flood hours across all four datums; blank and finite filter bounds; mobile startup and Reset; and keyboard focus during year/legend redraws.

Follow-up checks retain known forecast samples at long-gap endpoints while keeping unknown intervals disconnected, preserve monthly provider resolution during sea-level fallback, retain sea-level visibility choices during real five-minute refreshes, and install keyboard legend controls for charts created after slow successful requests. Only the refresh tests opt into the harness's advancing Playwright clock; its default behavior is unchanged.

Full Stone Harbor source/UI publication retains a coherent live PETSS bundle when its model issuance is equal to or newer than the source checkout. The live forecast is authoritative for same-cycle revisions. Explicit forecast rebuilds use the data-only refresher. Ordering uses the issued cycle, and retained forecasts keep their original bytes and timestamps, including when expired. Missing, partial or inconsistent bundles fail before publication. Forecast-publication tests use a fake API and perform no external writes.
