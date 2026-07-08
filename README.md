# Vimana

Vimana ("flying palace" in the Sanskrit epics) is a self-hosted web page that shows live air traffic around your house as a night-sky radar: glowing per-type aircraft silhouettes with route and ETA cards, a sweep and ping animation, ambient music, and sporadic garbled ATC radio chatter. It is designed to be projected onto a ceiling or shown on a spare screen, and runs comfortably on a Raspberry Pi.

It needs no receiver hardware and no API keys: aircraft positions come from three free community ADS-B networks (adsb.lol, adsb.fi, airplanes.live) merged together, and flight routes come from adsbdb.com. Inspired by the [Skylight](https://skylightceiling.com/) ceiling projector project; the code here is an independent implementation.

Music is generated using higgsfield and suno (Chatter is 13 simulated chatters overlayed over the instrumental music -- controller voices carry a neutral, subtly North Indian accent for Delhi airspace, while pilot voices carry their airline's home-country accent: Thai, Japanese, German, Finnish, and Indian for the India-based carrier. The music is oechestrated to the style of interstellar. The Crust game's OST was the vibe i was looking for.

## How to install

Prerequisites: Python 3.8 or newer. There are no packages to install — the server uses only the Python standard library.

```
git clone https://github.com/akshatrathee/vimana.git
cd vimana
python server.py
```

Verify: the terminal prints `Vimana listening on port 8642`. Open http://localhost:8642 in a browser.

Developers run from source the same way — there is no build step. Static frontend files live in `public/`; the server is `server.py`.

## How to use

1. Run `python server.py` and open http://localhost:8642.
2. On first launch a setup screen asks for your home coordinates (right-click your house in Google Maps to copy them), an optional label, and up to two points of interest. Point of interest 1 is always an airport — give it a name, coordinates, and (optionally) its runways: a bare heading in degrees ("87") auto-labels itself ("09/27"), or give the real designator explicitly as `LABEL@heading` ("11R/29L@111") when the airport has parallel runways sharing a heading — the L/R suffix on those flips per approach direction and can't be derived from the heading alone. Look these up on SkyVector or Wikipedia. Drawn as actual runway lines at their real orientation relative to your house, not a generic pin — including a sideways offset for parallel strips so they render as distinct lines. Point of interest 2 can be an airport (same runway field), a landmark, or a personal point — each gets a distinct icon. Saving starts the radar.
3. The page itself has no visible controls by default except the info panel (clock/status/aircraft count) — that's intentional, so it's projector/kiosk-ready out of the box, while still showing at a glance that it's alive. Click the **⚙ gear icon** (bottom left, always present) to open settings: location, points of interest, and display defaults (radius, music/ATC audio, constellations, whether the info panel shows). Saving reloads the page with the new defaults applied. The page always attempts fullscreen on its own on load (most browsers require one click first — the fullscreen button is the reliable fallback).
4. The settings screen also has a generated **Projector URL** with a QR code next to it — scan it with a phone to open that exact URL, or put it on a kiosk device. Use this when a *different* display should use different values than your saved defaults (e.g. a second screen at a different radius); the plain URL already carries your saved defaults, so most setups never need this.
5. To run it on a Raspberry Pi ceiling projector, see [deploy/README.md](deploy/README.md) for the kiosk files and step-by-step setup.

Planes are colored by direction: green is heading toward you, red away, amber crossing. Low traffic (below 12,000 ft) gets full detail cards, mid-altitude gets callsign only, and cruise traffic renders as a dim silhouette — matching what you can actually see from the ground. Aircraft on the ground or below 500 ft are hidden.

## How to configure / update

Settings are split across two files in the project root, both created by the in-app setup screen and both gitignored (they hold your personal location — never commit them):

- `config.json` — your location: home coordinates, label, points of interest, poll interval. `config.example.json` is committed with the project author's own real, working config (a generic residential Delhi NCR location with Indira Gandhi Intl as a point of interest) — just `cp config.example.json config.json` to start from it as-is, no setup screen needed, or run the in-app setup for your own location instead.
- `default_settings.cfg` — display preferences applied whenever the page loads without a URL override: `radius_nm`, `sound`, `constellations`, `hud` (info panel visibility), `fullscreen`. Not sensitive, but still per-deployment. Unlike `config.json`, this one is plain `key=value` text specifically so you can hand-edit it directly — helpful on a headless kiosk device where clicking through the gear icon isn't convenient. Changes to this file take effect on the next page load; changes made via the gear icon reload automatically.

Tunable constants sit at the top of `public/app.js` (altitude visibility thresholds, trail length) and `public/audio.js` (volumes, ATC chatter frequency).

To update, `git pull` and restart `python server.py`. Your `config.json` is untouched by updates.

## How to backup

The only state is `config.json`. Copy it somewhere safe:

```
cp config.json ~/vimana-config-backup.json
```

## How to restore

Copy the backup into the project root and restart the server:

```
cp ~/vimana-config-backup.json config.json
python server.py
```

Verify: the page skips the setup screen and centers the radar on your home. (Without a backup, restoring is just re-entering coordinates in the setup screen.)

## How to uninstall

Stop the server (Ctrl+C) and delete the project folder. Nothing is installed elsewhere — no packages, services, or registry entries. If you added a systemd unit or kiosk autostart entry on a Raspberry Pi yourself, remove those too.

## Hardware upgrade: add your own ADS-B receiver

Everything above runs on free data from other people's receivers, with zero
hardware. This section is entirely optional: it covers plugging in your own
RTL-SDR dongle so Vimana shows aircraft *you* received directly — lower
latency, no dependency on community coverage in your area, and it keeps
working if your internet drops (aircraft positions only; route/ETA lookups
still need internet).

**Does the receiver connect to the Pi or the server?** The server — whichever
machine runs `server.py` (see [deploy/README.md](deploy/README.md) for the
server vs. display/kiosk distinction). They can be the same device if it's
well placed, but what actually decides this is antenna placement, not which
Pi is "the Vimana one": put the receiver on whatever machine can route a
coax cable to a window, attic, or roof with a clear view of the sky.

### Hardware you need

- An RTL-SDR USB dongle tuned for 1090MHz (e.g. RTL-SDR Blog V3, ~$30)
- A 1090MHz ADS-B antenna (a basic 1/4-wave or a colinear for more range)
- SMA coax cable and, if the dongle is far from the antenna, a USB extension
  cable (RTL-SDR dongles are sensitive to USB3 interference — a 2.0 extension
  moving it away from the Pi itself often helps)
- Optional: an inline LNA (amplifier) or SAW filter if you're in a
  high-interference area (near cell towers, airports with radar, etc.)

### Software setup: the decoder

Install `readsb` on the receiver/server machine — it's the program that
owns the USB dongle, decodes raw ADS-B signals, and publishes them as JSON.

```
sudo bash -c "$(wget -qO - https://github.com/wiedehopf/adsb-scripts/raw/master/readsb-install.sh)"
```

This installs and starts `readsb` as a service, and serves a local map and
JSON feed at `http://<receiver-ip>:8080`. Verify it's working: open that URL
in a browser — you should see a map with any aircraft currently overhead.

### Wiring it into Vimana

`readsb`'s JSON output uses the same `"aircraft"` key that Vimana's merge
logic already falls back to, and its URL needs no placeholders — so adding
it as a fourth source is one line. Open `server.py` and extend
`AIRCRAFT_SOURCES`:

```python
AIRCRAFT_SOURCES = [
    ("adsb.lol", "https://api.adsb.lol/v2/point/{lat}/{lon}/{r}"),
    ("adsb.fi", "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{r}"),
    ("airplanes.live", "https://api.airplanes.live/v2/point/{lat}/{lon}/{r}"),
    ("local-receiver", "http://localhost:8080/data/aircraft.json"),
]
```

(Use the receiver machine's LAN IP instead of `localhost` if it's a
different device from the one running `server.py`.) Restart `python
server.py` to pick up the change.

**Known caveat:** unlike the three community APIs, `readsb`'s feed isn't
filtered by distance — it reports everything the antenna hears, which can
be well past your configured radius on a good antenna. If you want it
cropped to match, filter on `ac["dst"]` against `radius_nm` in
`fetch_aircraft()`'s merge step in `server.py`.

### Contributing to FlightRadar24 (get a free Business plan)

Feeding your receiver's data to FlightRadar24 is separate from the step
above — Vimana reads from your *local* decoder either way, so this part
only affects your FR24 account, not what shows on your radar.

1. Create an account at [flightradar24.com](https://www.flightradar24.com/)
   and go to **Add your receiver** under Account → Share your data.
2. Register your location to get a sharing key.
3. Install `fr24feed` on the same machine running `readsb`:
   ```
   sudo bash -c "$(wget -qO - https://repo-feed.flightradar24.com/install_fr24_rpi.sh)"
   ```
4. When prompted, point it at your existing decoder instead of letting it
   drive the SDR itself — `readsb` already owns the dongle, and also
   publishes a Beast-format stream on port 30005 that feeder clients like
   `fr24feed` are designed to read from, so one dongle can feed multiple
   aggregators (FR24, FlightAware, ADS-B Exchange, etc.) simultaneously
   without contention. Give the FR24 setup script `localhost:30005` as the
   Beast input when it asks.
5. Check **Account → Statistics** on the FR24 website after your feeder
   shows as connected. FR24 grants active feeders free access to a
   Business-tier subscription as a thank-you; the exact name and perks are
   set by FR24 and may change, so treat this as "check your account page,"
   not a fixed guarantee.

## Credits

- Visual concept inspired by [Skylight](https://skylightceiling.com/) by cpaczek — this is an independent, from-scratch implementation.
- The music's style was prompted toward the vibe of [The Crust](https://store.steampowered.com/app/1465470/The_Crust/)'s OST (Veom Studios) as a thematic reference only — no audio from that soundtrack was used, sampled, or is otherwise part of this project. `Skybound.mp3` is fully AI-generated, see below.
- Aircraft data: [adsb.lol](https://adsb.lol), [adsb.fi](https://adsb.fi), [airplanes.live](https://airplanes.live). Route data: [adsbdb.com](https://adsbdb.com). All free community services — consider feeding them if you get a receiver.
- Background image, music track (`Skybound.mp3`), and ATC voice clips are AI-generated for this project. Music and voice clips are generated using higgsfield (Chatter is 13 simulated transmissions overlayed over the instrumental music, one picked at random every 15-45s). The music is oechestrated to the style of interstellar
- QR code generation (`public/vendor/qrcode.js`) vendors Kazuhiko Arase's public-domain [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), MIT licensed — the reference implementation several other JS QR libraries wrap.

Licensed under the Apache License 2.0 — see [LICENSE](LICENSE).
