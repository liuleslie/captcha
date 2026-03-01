# smellPGH — Investigative Pipeline

Airsniffing tool for the Pittsburgh / Mon Valley region.
Correlates community smell reports with wind data to trace pollution back to industrial sources.

---

## Goal

Three-part investigation:

1. **Filter** — smell reports within X miles of a given intersection, filtered for substantive narrative (not just checkbox symptoms)
2. **Contextualize** — pair each report with its AQI and wind direction at the time it was filed
3. **Trace** — check if a known pollutant source was upwind at that moment

---

## Data Sources

| Source | What it provides | Auth | Docs |
|--------|-----------------|------|------|
| [Smell PGH API](https://github.com/CMU-CREATE-Lab/smell-pittsburgh-rails/wiki/Smell-PGH-API) | Community smell reports (lat/lng, intensity 1–5, text, timestamp) | none | `GET /api/v2/smell_reports` |
| [Open-Meteo Archive](https://open-meteo.com/en/docs/historical-weather-api) | Hourly wind speed + direction, back to 1940 | none | `archive-api.open-meteo.com` |
| [Nominatim (OSM)](https://nominatim.org/release-docs/develop/api/Search/) | Geocoding — cross-street intersection → lat/lng | none | `nominatim.openstreetmap.org/search` |
| [Smell PGH AQI](https://github.com/CMU-CREATE-Lab/smell-pittsburgh-rails/wiki/Smell-PGH-API#get-apiv2get_aqi) | Current AQI by city name | none | `GET /api/v2/get_aqi?city=Pittsburgh` |

All free. No API keys required for any of these.

Optional (requires free EPA registration):
- [EPA AQS API](https://aqs.epa.gov/aqsweb/documents/data_api.html) — hourly PM2.5 / SO2 / ozone from Allegheny County monitoring stations

---

## Known Pollutant Sources

All in the Mon Valley, SE of Pittsburgh:

| Facility | Coordinates | Notes |
|----------|-------------|-------|
| Clairton Coke Works | 40.2923, -79.8796 | Largest coke plant in US; SSE of Pgh |
| Edgar Thomson Plant | 40.4027, -79.8595 | U.S. Steel; Braddock; E of Pgh |
| Irvin Plant | 40.3614, -79.8994 | U.S. Steel; West Mifflin; S of Pgh |
| Cheswick Power Plant | 40.5487, -79.7900 | NE of Pgh |

Bearing from each facility to Pittsburgh:
- Clairton → Pgh: ~337° (i.e., wind from SSE = ~157° puts Clairton upwind)
- Edgar Thomson → Pgh: ~275° (wind from E = ~90° puts it upwind)

---

## Core Algorithms

### 1. Haversine distance
Converts two lat/lng pairs to miles. Used to filter reports within radius of intersection.

### 2. Text depth
`len(smell_description) + len(feelings_symptoms) + len(additional_comments)`
Distinguishes personal narratives from quick intensity-only checkboxes.

### 3. Wind-to-source alignment
Wind direction in meteorology = direction **FROM** which wind blows (0° = from north).
- Get wind direction at report's hour from Open-Meteo
- Compute compass bearing from report location → each known facility
- If `|wind_from − bearing_to_facility| < tolerance` → facility is upwind → likely source

### 4. Angular difference
`min(|a − b| mod 360, |b − a| mod 360)` — smallest angle between two bearings.

---

## File Structure

```
smellPGH/
  META.md            this file — start here
  index.html         Phase 2+: browser tool, vanilla JS, no build
  lib/
    geo.py           haversine, bearing, angular_diff, cardinal direction
    sources.py       known facility locations
```

---

## Phases

### Phase 1 — API Orientation via curl
Learn the HTTP request/response cycle by querying the API directly.
No code, no browser. Just curl → read the raw JSON → understand the data shape.

The API runs on Ruby on Rails 4.2.10. As a consumer this only means REST
conventions apply: URLs are resources, GET fetches, responses are JSON.
The server version is irrelevant to how you read the data.

#### curl exercises

**0. Anatomy of a curl command**
```
curl [flags] "URL"
  -s          silent — suppress progress meter
  -i          include response headers in output (status code, content-type, etc.)
  | python3 -m json.tool    pretty-print JSON
```

---

**1. What regions exist? (simplest possible request)**
```bash
curl -s "https://smellpittsburgh.org/api/v2/regions" | python3 -m json.tool
```
Look for: the `id` of the Pittsburgh region. You'll use it in every subsequent query.

---

**2. Read the response headers**
```bash
curl -si "https://smellpittsburgh.org/api/v2/regions"
```
Look for: `HTTP/2 200` (status line), `content-type: application/json`, any CORS headers (`access-control-allow-origin`). CORS headers tell you whether a browser can call this API directly.

---

**3. Fetch smell reports — no filter**
```bash
curl -s "https://smellpittsburgh.org/api/v2/smell_reports?region_ids=1" | python3 -m json.tool | head -80
```
Look for: the field names. `observed_at` is a Unix timestamp. `smell_value` is 1–5. Note which text fields are present (`smell_description`, `feelings_symptoms`, `additional_comments`) and which are null.

---

**4. Filter by time window**

Unix timestamps: `date -j -f "%Y-%m-%d" "2026-02-01" "+%s"` (macOS) gives you a timestamp for Feb 1.
```bash
curl -s "https://smellpittsburgh.org/api/v2/smell_reports?region_ids=1&start_time=1738368000&end_time=1740441600" \
  | python3 -m json.tool | head -120
```
Look for: how many reports come back. Try widening or narrowing the window. What's the shape of a report with no text vs. one with a full `additional_comments`?

---

**5. Get only strong smells**
```bash
curl -s "https://smellpittsburgh.org/api/v2/smell_reports?region_ids=1&smell_value=4" \
  | python3 -m json.tool
```
Look for: does `smell_value=4` mean "exactly 4" or "4 and above"? Check by scanning the returned values.

---

**6. AQI — simplest response**
```bash
curl -s "https://smellpittsburgh.org/api/v2/get_aqi?city=Pittsburgh"
```
Look for: this returns a bare number, not JSON. What does `curl -si` show for content-type?

---

**7. Download as CSV instead of JSON**
```bash
curl -s "https://smellpittsburgh.org/api/v2/smell_reports?region_ids=1&format=csv" | head -5
```
Look for: column headers in the first row. Same data, different shape.

---

**8. Wind data — Open-Meteo**
```bash
curl -s "https://archive-api.open-meteo.com/v1/archive?latitude=40.4406&longitude=-79.9959&start_date=2026-02-01&end_date=2026-02-07&hourly=wind_speed_10m,wind_direction_10m&timezone=America%2FNew_York&wind_speed_unit=mph" \
  | python3 -m json.tool | head -60
```
Look for: `hourly.time` is an array of ISO timestamps. `hourly.wind_direction_10m` is the parallel array of degrees. `0° = from north, 90° = from east, 157° = from SSE (Clairton direction)`.

---

**9. Geocode a cross-street intersection**
```bash
curl -s "https://nominatim.openstreetmap.org/search?q=Penn+Ave+%26+Negley+Ave,+Pittsburgh,+PA&format=json&limit=1" \
  -H "User-Agent: smell-investigation/1.0" \
  | python3 -m json.tool
```
Look for: `lat` and `lon` in the response. The `%26` is URL-encoded `&`. The `User-Agent` header is required by Nominatim's usage policy.

---

**10. Check the Plume PGH video index**
```bash
curl -si "https://aircocalc-www.createlab.org/pardumps/plumeviz/video/20260217.mp4" | head -20
```
Look for: HTTP status (`200` = exists, `404` = not yet available). `content-length` tells you file size. You're not downloading the video — just checking the headers with `-I` (HEAD request) or `-si` and stopping early.

### Phase 2 — Sentiment Display (HTML)
Static `index.html`. Vanilla JS `fetch()` to Smell PGH API.
Score reports by sentiment keywords + text depth. Render ranked list.
No video, no wind data yet. Goal: get comfortable with fetch/JSON in the browser.

### Phase 3 — Investigation Platform
- Plume PGH video (`yyyymmdd.mp4`) embedded and seekable by report timestamp
- Open-Meteo wind data fetched at each report's hour
- ASCII wind rose in a `<pre>` block
- Source-facility upwind alignment
- Full interface as designed above

---

## Prior Art / Reference

- [CMU CREATE Lab BreatheCam](https://breatheproject.org/breathe-cam/) — camera network monitoring Mon Valley stacks 24/7
- [Plume Pittsburgh](https://www.publicsource.org/plume-pittsburgh-cmu-climate-trace-al-gore/) — emissions + NOAA wind → dispersion maps
- [GASP (Group Against Smog and Pollution)](https://www.gasp-pgh.org) — local advocacy; publishes ACHD monitoring reports
- [Queering the Map](https://www.queeringthemap.com) — reference for community annotation pattern
