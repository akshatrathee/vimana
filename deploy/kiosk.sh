#!/usr/bin/env bash
# Vimana kiosk launcher: opens the projector URL fullscreen in Chromium.
# Reads VIMANA_URL from /etc/vimana-kiosk.conf (or a conf next to this
# script as a fallback). Install at /usr/local/bin/vimana-kiosk.sh.

set -u

if [ -f /etc/vimana-kiosk.conf ]; then
  . /etc/vimana-kiosk.conf
elif [ -f "$(dirname "$0")/vimana-kiosk.conf" ]; then
  . "$(dirname "$0")/vimana-kiosk.conf"
fi

if [ -z "${VIMANA_URL:-}" ]; then
  echo "VIMANA_URL is not set -- edit /etc/vimana-kiosk.conf" >&2
  exit 1
fi

# Bookworm ships the browser as "chromium", older Pi OS as
# "chromium-browser"; accept either.
BROWSER="$(command -v chromium-browser || command -v chromium)"
if [ -z "$BROWSER" ]; then
  echo "Chromium is not installed (sudo apt install chromium-browser)" >&2
  exit 1
fi

# The Pi often finishes booting before Wi-Fi and before the Vimana
# server is reachable; a kiosk that starts too early shows an error
# page forever. Poll the server's config endpoint until it answers.
BASE_URL="${VIMANA_URL%%\?*}"
until curl -sf --max-time 3 "${BASE_URL}api/config" >/dev/null 2>&1; do
  sleep 2
done

# --autoplay-policy lets the music/ATC audio start without a click.
# --check-for-update-interval effectively disables update nagging.
exec "$BROWSER" \
  --kiosk "$VIMANA_URL" \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  --hide-scrollbars \
  --disable-pinch \
  --overscroll-history-navigation=0
