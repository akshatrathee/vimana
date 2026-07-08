#!/usr/bin/env python3
"""
Vimana local server.

Serves the static visualizer from ./public and proxies aircraft
lookups to free community ADS-B APIs (adsb.lol, adsb.fi,
airplanes.live, merged by ICAO hex). Proxying (rather than calling
them directly from the browser) exists for two reasons:
  1. The APIs don't send Access-Control-Allow-Origin, so a direct
     browser fetch() from a page served on its own origin gets
     blocked by CORS.
  2. A same-origin proxy lets us cache the upstream response for a
     few seconds, so opening the page in several tabs/browsers (or
     a flaky Pi Wi-Fi reconnecting) doesn't hammer the free API.

Zero third-party dependencies -- only the Python 3 standard library,
so this runs unmodified on a stock Raspberry Pi OS install.
"""

import json
import math
import os
import socket
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).parent
PUBLIC_DIR = ROOT / "public"
CONFIG_PATH = ROOT / "config.json"
CONFIG_DEFAULTS = {
    "home_lat": None,
    "home_lon": None,
    "home_label": "",
    "poll_interval_seconds": 8,
    "poi": [],
}

# Kept deliberately separate from config.json: config.json is personal
# (your home coordinates) and gitignored, while this is just display
# preferences -- safe to read/hand-edit, and plain key=value rather
# than JSON so it's approachable without knowing any syntax rules.
DEFAULT_SETTINGS_PATH = ROOT / "default_settings.cfg"
DEFAULT_SETTINGS_DEFAULTS = {
    "radius_nm": 40.0,
    "sound": False,
    "constellations": False,
    "hud": True,
    "fullscreen": False,
}
_BOOL_TRUE = {"1", "true", "yes", "on"}

SERVER_PORT = None  # set in main() once the port is known


def get_lan_ip():
    # UDP "connect" sends no packets; it just makes the OS pick the
    # interface it would route through, which is the address a kiosk
    # device elsewhere on the LAN needs (localhost would only work on
    # this machine).
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def load_config():
    # config.json is gitignored (it holds the owner's home coordinates);
    # a fresh clone has no config, and the web UI walks the user through
    # first-run setup instead.
    # encoding="utf-8" is not optional on Windows: read_text() defaults
    # to the legacy cp1252 codepage, which silently mangles non-ASCII
    # characters (e.g. the "·" in a POI label).
    cfg = dict(CONFIG_DEFAULTS)
    if CONFIG_PATH.exists():
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    return cfg


def is_configured(cfg):
    return cfg.get("home_lat") is not None and cfg.get("home_lon") is not None


def load_default_settings():
    settings = dict(DEFAULT_SETTINGS_DEFAULTS)
    if not DEFAULT_SETTINGS_PATH.exists():
        return settings
    for line in DEFAULT_SETTINGS_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if key == "radius_nm":
            try:
                settings["radius_nm"] = max(5.0, min(250.0, float(value)))
            except ValueError:
                pass
        elif key in ("sound", "constellations", "hud", "fullscreen"):
            settings[key] = value.lower() in _BOOL_TRUE
    return settings


def save_default_settings(settings):
    lines = [
        "# Vimana default display settings.",
        "# Applied whenever the page loads without URL query overrides",
        "# (e.g. ?radius=60 always wins over the radius_nm line below).",
        "# Edit by hand and refresh the page, or use the gear icon in the app.",
        "",
        f"radius_nm={settings['radius_nm']}",
        f"sound={1 if settings['sound'] else 0}",
        f"constellations={1 if settings['constellations'] else 0}",
        f"hud={1 if settings['hud'] else 0}",
        f"fullscreen={1 if settings['fullscreen'] else 0}",
        "",
    ]
    DEFAULT_SETTINGS_PATH.write_text("\n".join(lines), encoding="utf-8")


CONFIG = load_config()
DEFAULT_SETTINGS = load_default_settings()

# Community ADS-B networks have very uneven receiver coverage per
# region (over Delhi, adsb.lol often sees a fraction of what adsb.fi
# does at the same moment). Querying all three and merging by ICAO hex
# roughly triples effective coverage for free.
AIRCRAFT_SOURCES = [
    ("adsb.lol", "https://api.adsb.lol/v2/point/{lat}/{lon}/{r}"),
    ("adsb.fi", "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{r}"),
    ("airplanes.live", "https://api.airplanes.live/v2/point/{lat}/{lon}/{r}"),
]
ADSBDB_ROUTE_URL = "https://api.adsbdb.com/v0/callsign/{callsign}"
USER_AGENT = "vimana/1.0 (personal, non-commercial)"

_cache = {"radius": None, "body": None, "fetched_at": 0.0}
CACHE_TTL_SECONDS = max(3, CONFIG["poll_interval_seconds"] - 2)

# Routes (callsign -> origin/destination airport) don't change for the
# life of a flight, so they're cached far longer than aircraft positions.
_route_cache = {}  # callsign -> (payload_dict, fetched_at)
ROUTE_CACHE_TTL_SECONDS = 30 * 60


def _bearing_and_distance_nm(lat1, lon1, lat2, lon2):
    rad = math.radians
    dlat = rad(lat2 - lat1)
    dlon = rad(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rad(lat1)) * math.cos(rad(lat2)) * math.sin(dlon / 2) ** 2
    dist_nm = 3440.1 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    y = math.sin(dlon) * math.cos(rad(lat2))
    x = math.cos(rad(lat1)) * math.sin(rad(lat2)) - math.sin(rad(lat1)) * math.cos(rad(lat2)) * math.cos(dlon)
    bearing = (math.degrees(math.atan2(y, x)) + 360) % 360
    return bearing, dist_nm


def _fetch_source(name, url_tpl, radius_nm):
    url = url_tpl.format(lat=CONFIG["home_lat"], lon=CONFIG["home_lon"], r=radius_nm)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read())
        return name, data.get("ac") or data.get("aircraft") or []
    except Exception as exc:
        print(f"source {name} failed: {exc}")
        return name, None


def fetch_aircraft(radius_nm):
    now = time.monotonic()
    if (
        _cache["body"] is not None
        and _cache["radius"] == radius_nm
        and (now - _cache["fetched_at"]) < CACHE_TTL_SECONDS
    ):
        return _cache["body"], True

    with ThreadPoolExecutor(max_workers=len(AIRCRAFT_SOURCES)) as pool:
        results = list(pool.map(lambda s: _fetch_source(s[0], s[1], radius_nm), AIRCRAFT_SOURCES))

    if all(ac_list is None for _, ac_list in results):
        raise urllib.error.URLError("all aircraft sources unreachable")

    # Merge by ICAO hex, keeping the freshest report (lowest 'seen').
    merged = {}
    source_counts = {}
    for name, ac_list in results:
        source_counts[name] = len(ac_list) if ac_list is not None else "error"
        for ac in ac_list or []:
            hexid = ac.get("hex")
            if not hexid or ac.get("lat") is None or ac.get("lon") is None:
                continue
            prev = merged.get(hexid)
            if prev is None or (ac.get("seen") or 999) < (prev.get("seen") or 999):
                merged[hexid] = ac

    # Normalize dst/dir from home for every aircraft: adsb.fi's endpoint
    # doesn't include them, and mixing upstream-computed values with
    # ours would subtly disagree anyway.
    for ac in merged.values():
        bearing, dist = _bearing_and_distance_nm(
            CONFIG["home_lat"], CONFIG["home_lon"], ac["lat"], ac["lon"]
        )
        ac["dir"] = round(bearing, 1)
        ac["dst"] = round(dist, 3)

    ac_list = sorted(merged.values(), key=lambda a: a["dst"])
    body = json.dumps({"ac": ac_list, "total": len(ac_list), "sources": source_counts}).encode("utf-8")

    _cache["radius"] = radius_nm
    _cache["body"] = body
    _cache["fetched_at"] = now
    return body, False


def fetch_route(callsign):
    now = time.monotonic()
    cached = _route_cache.get(callsign)
    if cached is not None and (now - cached[1]) < ROUTE_CACHE_TTL_SECONDS:
        return cached[0]

    url = ADSBDB_ROUTE_URL.format(callsign=callsign)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            payload = None
        else:
            raise

    _route_cache[callsign] = (payload, now)
    return payload


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {fmt % args}")

    def end_headers(self):
        # SimpleHTTPRequestHandler sends no cache headers at all, which
        # lets browsers cache index.html/app.js indefinitely -- edits
        # then silently don't show up without a hard refresh. no-cache
        # still allows conditional revalidation, so unchanged files stay
        # fast while changed ones are always picked up.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/config":
            self._send_json(200, {
                "configured": is_configured(CONFIG),
                "home_lat": CONFIG["home_lat"],
                "home_lon": CONFIG["home_lon"],
                "home_label": CONFIG.get("home_label", ""),
                "poll_interval_seconds": CONFIG["poll_interval_seconds"],
                "poi": CONFIG.get("poi", []),
                "radius_nm": DEFAULT_SETTINGS["radius_nm"],
                "sound_enabled": DEFAULT_SETTINGS["sound"],
                "show_constellations": DEFAULT_SETTINGS["constellations"],
                "hud_default": DEFAULT_SETTINGS["hud"],
                "fullscreen_default": DEFAULT_SETTINGS["fullscreen"],
                "lan_ip": get_lan_ip(),
                "port": SERVER_PORT,
            })
            return

        if parsed.path == "/api/aircraft":
            if not is_configured(CONFIG):
                self._send_json(409, {"error": "not_configured"})
                return
            radius_nm = parse_qs(parsed.query).get("radius_nm", [DEFAULT_SETTINGS["radius_nm"]])[0]
            try:
                radius_nm = max(1, min(250, float(radius_nm)))
            except ValueError:
                radius_nm = DEFAULT_SETTINGS["radius_nm"]

            try:
                body, from_cache = fetch_aircraft(radius_nm)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("X-Cache", "HIT" if from_cache else "MISS")
                self.end_headers()
                self.wfile.write(body)
            except (urllib.error.URLError, TimeoutError) as exc:
                self._send_json(502, {"error": "upstream_unreachable", "detail": str(exc)})
            return

        if parsed.path == "/api/route":
            callsign = parse_qs(parsed.query).get("callsign", [""])[0].strip()
            if not callsign:
                self._send_json(400, {"error": "missing_callsign"})
                return
            try:
                payload = fetch_route(callsign)
                self._send_json(200, {"route": payload})
            except (urllib.error.URLError, TimeoutError) as exc:
                self._send_json(502, {"error": "upstream_unreachable", "detail": str(exc)})
            return

        super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path != "/api/config":
            self._send_json(404, {"error": "not_found"})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            incoming = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "invalid_json"})
            return

        try:
            lat = float(incoming["home_lat"])
            lon = float(incoming["home_lon"])
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError("out of range")
        except (KeyError, TypeError, ValueError):
            self._send_json(400, {"error": "invalid_coordinates"})
            return

        pois = []
        for i, poi in enumerate((incoming.get("poi") or [])[:2]):  # setup UI allows up to 2
            try:
                plat, plon = float(poi["lat"]), float(poi["lon"])
                if not (-90 <= plat <= 90 and -180 <= plon <= 180):
                    continue
            except (KeyError, TypeError, ValueError):
                continue

            # POI 1 is always an airport (the UI enforces this too, but
            # a hand-crafted request shouldn't be able to bypass it).
            poi_type = "airport" if i == 0 else str(poi.get("type", "landmark"))
            if poi_type not in ("airport", "landmark", "personal"):
                poi_type = "landmark"

            entry = {"label": str(poi.get("label", ""))[:60], "lat": plat, "lon": plon, "type": poi_type}
            if poi_type == "airport":
                # label is optional -- the client auto-derives a
                # designator from heading alone when it's absent, but
                # can't do that correctly for parallel runways (e.g.
                # Delhi's 11R/29L + 11L/29R), where the real-world
                # designator has to be given explicitly.
                runways = []
                for rw in (poi.get("runways") or [])[:6]:
                    try:
                        heading = round(float(rw["heading"]) % 360, 1)
                    except (KeyError, TypeError, ValueError):
                        continue
                    label = str(rw.get("label") or "")[:12].strip() or None
                    runways.append({"heading": heading, "label": label})
                entry["runways"] = runways
            pois.append(entry)

        new_config = dict(CONFIG_DEFAULTS)
        new_config.update({
            "home_lat": lat,
            "home_lon": lon,
            "home_label": str(incoming.get("home_label", ""))[:60],
            "poll_interval_seconds": CONFIG.get("poll_interval_seconds", 8),
            "poi": pois,
        })
        CONFIG_PATH.write_text(
            json.dumps(new_config, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        CONFIG.clear()
        CONFIG.update(new_config)
        # Home moved: cached aircraft data is for the old location.
        _cache.update({"radius": None, "body": None, "fetched_at": 0.0})

        try:
            radius_nm = max(5.0, min(250.0, float(incoming.get("radius_nm", DEFAULT_SETTINGS["radius_nm"]))))
        except (TypeError, ValueError):
            radius_nm = DEFAULT_SETTINGS["radius_nm"]

        new_settings = {
            "radius_nm": radius_nm,
            "sound": bool(incoming.get("sound_enabled", False)),
            "constellations": bool(incoming.get("show_constellations", False)),
            "hud": bool(incoming.get("hud_default", True)),
            "fullscreen": bool(incoming.get("fullscreen_default", False)),
        }
        save_default_settings(new_settings)
        DEFAULT_SETTINGS.clear()
        DEFAULT_SETTINGS.update(new_settings)

        self._send_json(200, {"ok": True})


def main():
    global SERVER_PORT
    # 8000 is a common default that collides with other local services
    # (notably Docker Desktop's own backend API on Windows, which -- due
    # to SO_REUSEADDR letting a second process bind the "same" port
    # without erroring -- can silently steal every request meant for
    # this server). 8642 is picked simply for being uncommon.
    port = int(os.environ.get("PORT", 8642))
    SERVER_PORT = port
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    # Binding to 0.0.0.0 makes the server reachable from any interface
    # (needed later so a phone/laptop on the same Wi-Fi can reach the
    # Pi), but 0.0.0.0 is not itself a valid address to *browse to*.
    print(f"Vimana listening on port {port}")
    print(f"Open this in your browser: http://localhost:{port}")
    if is_configured(CONFIG):
        print(f"Home location: {CONFIG['home_lat']}, {CONFIG['home_lon']}")
    else:
        print("Not configured yet -- the page will walk you through setup.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
