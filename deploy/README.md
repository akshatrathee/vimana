# Deploying Vimana on a Raspberry Pi

This folder turns a Raspberry Pi into a dedicated Vimana display: it boots
straight into Chromium, fullscreen, showing the radar — no desktop, no
mouse, no toggles. Works on a Pi 4, Pi 5, Pi 3, or Pi Zero 2 W.

## The two roles

- **Server** — runs `python server.py` (the whole repo). Can be any always-on
  machine on your network: a PC, a NAS, or the display Pi itself. A Pi 4/5
  handles both roles comfortably; for a Pi Zero 2 W, prefer hosting the
  server on another machine and using the Zero as display only.
- **Display (kiosk)** — any Pi with HDMI out. It only needs Chromium and the
  projector URL; it does not need this repository.

## Step 0 — Get your projector URL

On any computer, open the Vimana page, click the ⚙ button, set your
preferred radius / sound / constellations under **Display defaults**, click
**Start tracking** to save, then copy the **Projector URL**. It looks like:

```
http://192.168.1.50:8642/?display=1&radius=40&sound=1&constellations=0
```

The URL already uses the server's LAN IP. Tip: give the server machine a
static IP (or DHCP reservation) in your router so this URL never goes stale.
Optional extra: add `&hud=0` to also hide the clock/status panel for a
completely clean ceiling projection.

## Step 1 — Flash the Pi

1. Use Raspberry Pi Imager with **Raspberry Pi OS with desktop** (64-bit;
   use 32-bit for a Zero 2 W if you prefer, both work).
2. In the imager's settings (gear icon): set hostname, enable SSH, enter
   your Wi-Fi credentials, and set the username to `pi`.
3. Boot the Pi, then from your computer: `ssh pi@<pi-hostname>.local`

## Step 2 — Enable auto-login to desktop

```
sudo raspi-config
```

System Options → Boot / Auto Login → **Desktop Autologin**.
While you're in raspi-config: Display Options → Screen Blanking → **No**.

## Step 3 — Install the kiosk files

On the Pi:

```
sudo apt update
sudo apt install -y chromium-browser curl
```

(If `chromium-browser` isn't found on newer OS releases, it's `chromium`.)

Copy the two files from this folder onto the Pi (via `scp` or a USB stick):

```
sudo cp kiosk.sh /usr/local/bin/vimana-kiosk.sh
sudo chmod +x /usr/local/bin/vimana-kiosk.sh
sudo cp vimana-kiosk.conf /etc/vimana-kiosk.conf
sudo nano /etc/vimana-kiosk.conf     # paste YOUR projector URL here
```

## Step 4 — Start the kiosk at boot

Which file to edit depends on the OS release (check with
`cat /etc/os-release`):

**Bookworm (2023+, default Wayland/labwc):**

```
mkdir -p ~/.config/labwc
nano ~/.config/labwc/autostart
```

Add this line:

```
/usr/local/bin/vimana-kiosk.sh &
```

**Bullseye or older (X11/LXDE):**

```
nano ~/.config/lxsession/LXDE-pi/autostart
```

(Create the folder if needed; start from
`/etc/xdg/lxsession/LXDE-pi/autostart` as a template.) Add:

```
@/usr/local/bin/vimana-kiosk.sh
@xset s off
@xset -dpms
@xset s noblank
```

Reboot (`sudo reboot`). The Pi should come up, wait for the server to be
reachable, and open the radar fullscreen. Audio (if enabled in the URL)
starts automatically — the launch script passes Chromium the
`--autoplay-policy=no-user-gesture-required` flag.

## Optional — Host the server on the same Pi

```
cd ~ && git clone https://github.com/akshatrathee/vimana.git
sudo cp ~/vimana/deploy/vimana-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vimana-server
```

Then set the URL in `/etc/vimana-kiosk.conf` to
`http://localhost:8642/?display=1&...`. Do the one-time location setup by
browsing to `http://<pi-hostname>.local:8642` from your computer.

## Optional — Rotate the image (ceiling projectors)

If the projected image is upside down or sideways: on Bookworm, use the
desktop's Screen Configuration tool once via VNC, or add a
`wlr-randr --output HDMI-A-1 --transform 180` line to the labwc autostart
before the kiosk line. On X11, add `display_hdmi_rotate=2` to
`/boot/config.txt`.

## Pi Zero 2 W notes

It works, with caveats: give it a lite-ish life — display role only, one
browser tab, nothing else running. First page load takes noticeably longer.
If Chromium gets killed by the 512 MB memory limit, enable zram
(`sudo apt install zram-tools`) and reboot; if problems persist, add
`--enable-low-end-device-mode` to the Chromium flags in
`/usr/local/bin/vimana-kiosk.sh`.

## Troubleshooting

- **Black screen after boot**: the kiosk script waits for the server; check
  the server machine is on and `curl http://<server-ip>:8642/api/config`
  answers from the Pi.
- **"site can't be reached"**: the projector URL's IP changed — set a DHCP
  reservation for the server and update `/etc/vimana-kiosk.conf`.
- **No audio**: confirm the URL contains `sound=1`; check HDMI audio is the
  output (`sudo raspi-config` → System Options → Audio).
- **Cursor visible**: on Bookworm/labwc the cursor auto-hides when idle. On
  X11 install `unclutter` and add `@unclutter -idle 1` to the autostart.
