# Vimana

Vimana ("flying palace" in the Sanskrit epics) is a self-hosted web page that shows live air traffic around your house as a night-sky radar: glowing per-type aircraft silhouettes with route and ETA cards, a sweep and ping animation, ambient music, and sporadic garbled ATC radio chatter. It is designed to be projected onto a ceiling or shown on a spare screen, and runs comfortably on a Raspberry Pi.

It needs no receiver hardware and no API keys: aircraft positions come from three free community ADS-B networks (adsb.lol, adsb.fi, airplanes.live) merged together, and flight routes come from adsbdb.com. Inspired by the [Skylight](https://skylightceiling.com/) ceiling projector project; the code here is an independent implementation.

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
2. On first launch a setup screen asks for your home coordinates (right-click your house in Google Maps to copy them), an optional label, and up to two points of interest such as your nearest airport. Saving starts the radar.
3. The HUD (top left) controls the radar radius in nautical miles, a constellations toggle, and a sound toggle (music + ATC chatter — browsers require this one click before audio can play).
4. The ⚙ button reopens location settings; the fullscreen button is for projector/second-screen use.

Planes are colored by direction: green is heading toward you, red away, amber crossing. Low traffic (below 12,000 ft) gets full detail cards, mid-altitude gets callsign only, and cruise traffic renders as a dim silhouette — matching what you can actually see from the ground. Aircraft on the ground or below 500 ft are hidden.

## How to configure / update

All settings live in `config.json` in the project root, created by the in-app setup screen — you normally never edit it by hand. `config.example.json` documents the format (radius, poll interval, points of interest). `config.json` is gitignored because it contains your home coordinates; keep it out of public repos.

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

## Credits

- Visual concept inspired by [Skylight](https://skylightceiling.com/) by cpaczek — this is an independent, from-scratch implementation.
- Aircraft data: [adsb.lol](https://adsb.lol), [adsb.fi](https://adsb.fi), [airplanes.live](https://airplanes.live). Route data: [adsbdb.com](https://adsbdb.com). All free community services — consider feeding them if you get a receiver.
- Background video, music track (`Skybound.mp3`), and ATC voice clips are AI-generated for this project.

Licensed under the Apache License 2.0 — see [LICENSE](LICENSE).
