/* Vimana — abstract polar radar (no map tiles).
   Aircraft positions: adsb.lol free API, proxied through /api/aircraft.
   Routes (origin/destination): adsbdb.com, proxied through /api/route.
   Both proxied so the browser only ever talks to our own origin. */

let HOME_LAT, HOME_LON, HOME_LABEL, RADIUS_NM, POLL_MS;
let POIS = [];

/* URL query parameters override default_settings.cfg on a per-load
   basis -- e.g. the settings panel's generated projector URL, for a
   second display that wants different values than the defaults. */
const URL_PARAMS = new URLSearchParams(location.search);
let radarRadiusPx = 0;
let centerX = 0, centerY = 0;
let lastList = [];

const markers = new Map(); // hex -> { el, direction, data }
const routeCache = new Map(); // callsign -> route object | null

const MI_PER_NM = 1.15078;
const EARTH_RADIUS_MI = 3958.8;
const EARTH_RADIUS_NM = 3440.1;

function computeGeometry() {
  centerX = window.innerWidth / 2;
  centerY = window.innerHeight / 2;
  radarRadiusPx = Math.min(window.innerWidth, window.innerHeight) * 0.44;
}

/*
 * A wider radius packs more aircraft into the same screen space (and
 * the same nm gap between them shrinks to fewer pixels), so labels
 * need to shrink too or dense areas turn into unreadable overlap.
 * 45nm is the "1:1" reference point matching the default config.
 */
function updateLabelScale() {
  const scale = Math.max(0.45, Math.min(1, 45 / RADIUS_NM));
  document.documentElement.style.setProperty("--label-scale", scale);
}

function polarToPixels(distNm, bearingDeg) {
  const r = (distNm / RADIUS_NM) * radarRadiusPx;
  const rad = (bearingDeg * Math.PI) / 180;
  return {
    x: centerX + r * Math.sin(rad),
    y: centerY - r * Math.cos(rad),
  };
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_MI * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceNm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const phi1 = toRad(lat1), phi2 = toRad(lat2), dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angularDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/*
 * Real constellation shapes (Big Dipper, Cassiopeia, Orion's belt+
 * shoulders), drawn as unlabeled dot patterns per the "no star names"
 * design decision. Coordinates are unit offsets, scaled to viewport %.
 */
const CONSTELLATIONS = [
  [[0, 0], [5, 1.5], [9, 3.5], [12.5, 6.5], [18, 5.5], [19, 10.5], [13.5, 11]],
  [[0, 3.5], [3.5, 0], [7, 3], [10.5, 0.5], [14, 4]],
  [[0, 0], [7.5, 1], [2.5, 9], [4, 10], [5.5, 11], [1, 19], [8.5, 18]],
];

let SHOW_CONSTELLATIONS = false;

function generateStarfield() {
  const field = document.getElementById("starfield");
  let html = "";
  for (let i = 0; i < 160; i++) {
    const x = Math.random() * 100;
    const y = Math.random() * 100;
    const size = Math.random() < 0.15 ? 2 : 1;
    const opacity = 0.2 + Math.random() * 0.6;
    // Randomized duration + a *negative* delay so each star starts
    // mid-cycle immediately (no synchronized flash-on at page load)
    // and drifts out of phase with every other star from then on.
    const duration = (3 + Math.random() * 4).toFixed(1);
    const delay = (-Math.random() * 6).toFixed(1);
    html += `<div class="star" style="left:${x}%;top:${y}%;width:${size}px;height:${size}px;--base-op:${opacity};animation-duration:${duration}s;animation-delay:${delay}s"></div>`;
  }
  // Constellations (dots + whisper-faint connecting lines) are off by
  // default and live behind the HUD toggle.
  let lines = "";
  if (SHOW_CONSTELLATIONS) {
    CONSTELLATIONS.forEach((pattern) => {
      const ox = Math.random() * 70 + 8;
      const oy = Math.random() * 70 + 8;
      const scale = 0.75;
      const pts = pattern.map(([px, py]) => [ox + px * scale, oy + py * scale]);
      pts.forEach(([x, y]) => {
        // Fixed (not twinkling) so the constellation shape stays
        // readable at a glance rather than flickering apart.
        html += `<div class="star" style="left:${x}%;top:${y}%;width:2px;height:2px;opacity:0.45;animation:none"></div>`;
      });
      for (let i = 1; i < pts.length; i++) {
        lines += `<line x1="${pts[i - 1][0]}%" y1="${pts[i - 1][1]}%" x2="${pts[i][0]}%" y2="${pts[i][1]}%"
          stroke="rgba(200,210,230,0.09)" stroke-width="1"/>`;
      }
    });
  }
  field.innerHTML = `<svg style="position:absolute;inset:0;width:100%;height:100%">${lines}</svg>` + html;
}

function drawRings(radiusNm) {
  const ringsEl = document.getElementById("rings");
  const compassEl = document.getElementById("compass");

  // Eight fine rings like the reference; nm labels only on the
  // quarter rings so the grid reads as texture, not chart clutter.
  let html = "";
  for (let i = 1; i <= 8; i++) {
    const f = i / 8;
    const px = f * radarRadiusPx * 2;
    html += `<div class="ring" style="left:${centerX}px;top:${centerY}px;width:${px}px;height:${px}px;"></div>`;
    if (i % 2 === 0) {
      const nm = Math.round(f * radiusNm);
      html += `<div class="ring-label" style="left:${centerX}px;top:${centerY - f * radarRadiusPx}px;">${nm}nm</div>`;
    }
  }
  ringsEl.innerHTML = html;

  const dirs = [
    { label: "N", deg: 0 },
    { label: "E", deg: 90 },
    { label: "S", deg: 180 },
    { label: "W", deg: 270 },
  ];
  compassEl.innerHTML = dirs
    .map((d) => {
      const p = polarToPixels(radiusNm, d.deg);
      return `<span style="left:${p.x}px;top:${p.y}px;">${d.label}</span>`;
    })
    .join("");

  renderPois();
}

/*
 * Fallback only: heading -> two-digit designator pair, e.g. 87deg ->
 * "09/27" (number = heading/10 rounded, 0 becomes 36). This is *not*
 * used when a runway carries its own real-world label, because
 * parallel runways (e.g. Delhi's 11R/29L and 11L/29R) can't be
 * derived from a heading at all -- the L/R suffix flips between a
 * strip's two ends depending on which direction you're approaching
 * from, which is a real geographic fact about that specific airport,
 * not something computable from a bearing number. Bare headings with
 * no label (e.g. a quickly-entered airport with no parallel runways)
 * still get a sensible auto-derived designator here.
 */
function runwayDesignator(headingDeg) {
  const n1 = Math.round(headingDeg / 10) % 36 || 36;
  const n2 = Math.round(((headingDeg + 180) % 360) / 10) % 36 || 36;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(n1)}/${pad(n2)}`;
}

/* Runway text field format: comma-separated tokens, each either a
   bare heading ("87") or "LABEL@heading" ("11R/29L@111") when the
   real designator needs to be given explicitly (see runwayDesignator
   above for why that's unavoidable for parallel runways). */
function parseRunwaySpec(str) {
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      if (token.includes("@")) {
        const [label, headingStr] = token.split("@");
        const heading = parseFloat(headingStr);
        return isFinite(heading) ? { heading, label: label.trim() } : null;
      }
      const heading = parseFloat(token);
      return isFinite(heading) ? { heading, label: null } : null;
    })
    .filter(Boolean);
}

function formatRunwaySpec(runways) {
  return (runways || []).map((r) => (r.label ? `${r.label}@${r.heading}` : `${r.heading}`)).join(", ");
}

/* Airport POIs draw their actual runways, oriented at their real
   compass headings relative to the POI point -- not to true relative
   scale (a real runway is ~1-2nm long, which would be sub-pixel at
   most radar zoom levels), but correctly oriented, so the layout
   reads as "this specific airport" rather than a generic pin. */
function poiIconSvg(poi) {
  const color = { airport: "#4fa8ff", personal: "#c9a8ff", landmark: "#a8cfe8" }[poi.type] || "#a8cfe8";

  if (poi.type === "airport") {
    const runways = poi.runways && poi.runways.length ? poi.runways : [{ heading: 90, label: null }];
    const halfLen = 9;

    // Parallel runways (same heading, e.g. Delhi's 11R/29L + 11L/29R)
    // share a heading group and get offset sideways so they render as
    // two distinct strips, matching the real layout, instead of one
    // line drawn twice on top of itself.
    const groups = new Map();
    runways.forEach((rw) => {
      const key = Math.round(rw.heading);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rw);
    });

    let lines = "";
    groups.forEach((group) => {
      const rad = (group[0].heading * Math.PI) / 180;
      const dx = Math.sin(rad), dy = -Math.cos(rad);
      const perpDx = Math.cos(rad), perpDy = Math.sin(rad);
      const spacing = 2.4;
      group.forEach((rw, i) => {
        const offset = (i - (group.length - 1) / 2) * spacing;
        const cx = 12 + perpDx * offset, cy = 12 + perpDy * offset;
        const x1 = (cx - dx * halfLen).toFixed(1), y1 = (cy - dy * halfLen).toFixed(1);
        const x2 = (cx + dx * halfLen).toFixed(1), y2 = (cy + dy * halfLen).toFixed(1);
        lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>`;
        lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0a0a0a" stroke-width="0.5" stroke-dasharray="1.2,1.2" opacity="0.8"/>`;
      });
    });
    return `<svg class="poi-icon" viewBox="0 0 24 24" style="color:${color}">${lines}<circle cx="12" cy="12" r="1.3" fill="${color}"/></svg>`;
  }

  if (poi.type === "personal") {
    // Small house silhouette -- visually distinct from the pin used
    // for generic landmarks, and from home's own green dot marker.
    return `<svg class="poi-icon" viewBox="0 0 24 24" style="color:${color}">
      <polygon points="12,3 20.5,10.5 3.5,10.5" fill="${color}"/>
      <rect x="6" y="10.5" width="12" height="9.5" fill="${color}"/>
      <rect x="10.3" y="14" width="3.4" height="6" fill="#0a0a0a"/>
    </svg>`;
  }

  // landmark: classic map-pin teardrop
  return `<svg class="poi-icon" viewBox="0 0 24 24" style="color:${color}">
    <path d="M12 2 C7.5 2 4 5.5 4 10 C4 16 12 22 12 22 C12 22 20 16 20 10 C20 5.5 16.5 2 12 2 Z" fill="${color}"/>
    <circle cx="12" cy="10" r="3" fill="#0a0a0a"/>
  </svg>`;
}

/* Fixed points of interest (from config.json). POI 1 is always an
   airport; POI 2 can be an airport, a landmark, or a personal point. */
function renderPois() {
  const el = document.getElementById("pois");
  el.innerHTML = POIS.map((p) => {
    const dst = distanceNm(HOME_LAT, HOME_LON, p.lat, p.lon);
    if (dst > RADIUS_NM) return "";
    const brg = bearingDeg(HOME_LAT, HOME_LON, p.lat, p.lon);
    const pos = polarToPixels(dst, brg);
    const sublabel =
      p.type === "airport" && p.runways && p.runways.length
        ? `<div class="poi-sublabel">${p.runways.map((r) => r.label || runwayDesignator(r.heading)).join(" · ")}</div>`
        : "";
    return `<div class="poi" style="left:${pos.x}px;top:${pos.y}px">
      ${poiIconSvg(p)}
      <div class="poi-label">${p.label}</div>
      ${sublabel}
    </div>`;
  }).join("");
}

/*
 * This is the "does the reciprocal of the bearing-to-the-plane roughly
 * match its track" check from the earlier TODO -- it's what tells
 * inbound (heading toward home) from outbound (heading away) traffic.
 * ac.dir is the bearing FROM home TO the aircraft; a plane flying
 * straight at home has a track close to (ac.dir + 180), i.e. it's
 * pointed back down the same line it's sitting on.
 */
function classifyDirection(ac) {
  if (ac.dir == null || ac.track == null) return "transit";
  const towardHome = (ac.dir + 180) % 360;
  const THRESHOLD_DEG = 55;
  if (angularDiff(ac.track, towardHome) < THRESHOLD_DEG) return "inbound";
  if (angularDiff(ac.track, ac.dir) < THRESHOLD_DEG) return "outbound";
  return "transit";
}

const DIRECTION_HUE = { inbound: 140, outbound: 350, transit: 48 };

/*
 * "Would I actually see this plane from the roof?" tiers. This close
 * to IGI (~13nm), the interesting traffic is approach/departure below
 * ~12,000 ft -- those get full cards. Cruise traffic overhead is a
 * contrail speck at best, so it renders as a dim silhouette with no
 * text. Taxiing aircraft at the airport get callsign-only cards so a
 * dozen planes at the gates don't stack full cards on one spot.
 * Tune these two constants to taste.
 */
const VIS_FULL_BELOW_FT = 12000;
const VIS_SILHOUETTE_ABOVE_FT = 20000;

/* Taxiing/parked aircraft (and anything under 500 ft, i.e. moments
   from touchdown or liftoff) are dropped entirely -- a dozen planes
   crawling around the IGI aprons just crowds the display. */
const MIN_ALT_FT = 500;

function isTrackable(ac) {
  if (ac.alt_baro === "ground") return false;
  if (ac.alt_baro != null && ac.alt_baro < MIN_ALT_FT) return false;
  return true;
}

function classifyVisibility(ac) {
  if (ac.alt_baro === "ground") return "minimal";
  const alt = ac.alt_baro ?? 99999;
  if (alt < VIS_FULL_BELOW_FT) return "full";
  if (alt < VIS_SILHOUETTE_ABOVE_FT) return "minimal";
  return "silhouette";
}

function directionColor(direction, alt_baro) {
  const hue = DIRECTION_HUE[direction] ?? DIRECTION_HUE.transit;
  let lightness = 55;
  if (alt_baro === "ground" || alt_baro == null) lightness = 45;
  else if (alt_baro < 10000) lightness = 65;
  else if (alt_baro < 25000) lightness = 55;
  else lightness = 45;
  return `hsl(${hue}, 100%, ${lightness}%)`;
}

/*
 * ICAO type code -> human-readable name, mirroring the reference UI
 * ("Boeing 777-222ER", not "B77W"). Covers the types that actually
 * fly over NCR airspace; anything unknown falls back to the raw code.
 */
const TYPE_NAMES = {
  A319: "Airbus A319", A320: "Airbus A320", A321: "Airbus A321",
  A20N: "Airbus A320neo", A21N: "Airbus A321neo",
  A332: "Airbus A330-200", A333: "Airbus A330-300", A339: "Airbus A330-900",
  A359: "Airbus A350-900", A35K: "Airbus A350-1000", A388: "Airbus A380-800",
  B737: "Boeing 737-700", B738: "Boeing 737-800", B739: "Boeing 737-900",
  B38M: "Boeing 737 MAX 8", B39M: "Boeing 737 MAX 9",
  B744: "Boeing 747-400", B748: "Boeing 747-8",
  B752: "Boeing 757-200", B763: "Boeing 767-300",
  B772: "Boeing 777-200", B77L: "Boeing 777-200LR", B77W: "Boeing 777-300ER",
  B788: "Boeing 787-8", B789: "Boeing 787-9", B78X: "Boeing 787-10",
  E175: "Embraer 175", E190: "Embraer 190", E195: "Embraer 195",
  AT75: "ATR 72-500", AT76: "ATR 72-600", DH8D: "Dash 8 Q400",
  C172: "Cessna 172", C182: "Cessna 182", P28A: "Piper PA-28",
  BE20: "King Air 200", C68A: "Citation Latitude",
  EC35: "Eurocopter EC135", B06: "Bell 206", R44: "Robinson R44",
};

function typeName(ac) {
  return TYPE_NAMES[ac.t] || ac.t || "";
}

/* Four-engine types get their own silhouette; widebody twins get the
   bigger frame. Everything else falls back to the ADS-B category
   (A1/A2 = light GA, A7 = rotorcraft). */
const FOUR_ENGINE = new Set(["A388", "B744", "B748", "A343", "A345", "A346", "IL96", "C17"]);
const WIDEBODY = /^(A33|A35|B76|B77|B78|IL9|MD1)/;

function planeKind(ac) {
  const cat = ac.category;
  if (cat === "A7") return "heli";
  if (cat === "A1" || cat === "A2") return "ga";
  if (ac.t && FOUR_ENGINE.has(ac.t)) return "jumbo";
  if (ac.t && WIDEBODY.test(ac.t)) return "heavy";
  if (cat === "A5" || cat === "A6") return "heavy";
  return "jet";
}

/* Top-view silhouettes, nose pointing up. All fills use the passed
   color; the glow comes from a CSS drop-shadow on .glyph. */
function planeSvg(color, ac) {
  const kind = planeKind(ac);

  if (kind === "heli") {
    return `<svg class="glyph" viewBox="0 0 24 24" style="color:${color}">
      <g fill="${color}">
        <ellipse cx="12" cy="11" rx="2.1" ry="4.6"/>
        <rect x="11.5" y="14.5" width="1" height="6" rx="0.5"/>
        <rect x="9.2" y="20" width="5.6" height="1.1" rx="0.55"/>
        <g opacity="0.75">
          <rect x="11.6" y="3" width="0.8" height="16" rx="0.4" transform="rotate(45 12 11)"/>
          <rect x="11.6" y="3" width="0.8" height="16" rx="0.4" transform="rotate(-45 12 11)"/>
        </g>
        <circle cx="12" cy="11" r="1"/>
      </g>
    </svg>`;
  }

  if (kind === "ga") {
    return `<svg class="glyph" viewBox="0 0 24 24" style="color:${color}">
      <g fill="${color}">
        <rect x="9.6" y="2.6" width="4.8" height="0.9" rx="0.45"/>
        <path d="M12 3 C12.9 3 13.2 4.6 13.2 6.5 L13.2 16 C13.2 18 12.7 19.6 12 19.6 C11.3 19.6 10.8 18 10.8 16 L10.8 6.5 C10.8 4.6 11.1 3 12 3 Z"/>
        <rect x="2.4" y="7.4" width="19.2" height="2.3" rx="1.15"/>
        <rect x="8" y="17.8" width="8" height="1.7" rx="0.85"/>
      </g>
    </svg>`;
  }

  const jumbo = kind === "jumbo";
  const heavy = kind === "heavy" || jumbo;
  const wingTipL = heavy ? 0.8 : 1.8;
  const wingTipR = 24 - wingTipL;
  const engines = jumbo
    ? `<rect x="4.6" y="12.6" width="1.6" height="3.4" rx="0.8"/>
       <rect x="7.9" y="11.2" width="1.6" height="3.6" rx="0.8"/>
       <rect x="14.5" y="11.2" width="1.6" height="3.6" rx="0.8"/>
       <rect x="17.8" y="12.6" width="1.6" height="3.4" rx="0.8"/>`
    : heavy
    ? `<rect x="6.1" y="11.4" width="2" height="4.2" rx="1"/>
       <rect x="15.9" y="11.4" width="2" height="4.2" rx="1"/>`
    : `<rect x="6.7" y="11.6" width="1.7" height="3.6" rx="0.85"/>
       <rect x="15.6" y="11.6" width="1.7" height="3.6" rx="0.85"/>`;
  const fusW = jumbo ? 1.7 : heavy ? 1.5 : 1.2;

  return `<svg class="glyph" viewBox="0 0 24 24" style="color:${color}">
    <g fill="${color}">
      <path d="M12 1.6 C${12 + fusW} 1.6 ${12 + fusW} 3.8 ${12 + fusW} 6 L${12 + fusW} 17.6 C${12 + fusW} 19.2 ${12 + fusW * 0.6} 20.6 12 20.6 C${12 - fusW * 0.6} 20.6 ${12 - fusW} 19.2 ${12 - fusW} 17.6 L${12 - fusW} 6 C${12 - fusW} 3.8 ${12 - fusW} 1.6 12 1.6 Z"/>
      <polygon points="${12 - fusW},9.2 ${wingTipL},15.4 ${wingTipL},16.7 ${12 - fusW},13.2 ${12 + fusW},13.2 ${wingTipR},16.7 ${wingTipR},15.4 ${12 + fusW},9.2"/>
      ${engines}
      <polygon points="12,17 8.4,19.8 8.4,20.9 12,19.2 15.6,20.9 15.6,19.8"/>
    </g>
  </svg>`;
}

/*
 * TODO(you): this is the one genuinely interesting design decision in
 * the whole app, and it's yours to make -- tune it to taste.
 *
 * Right now this only looks at straight-line distance, so a plane
 * cruising past 3nm away at 35,000ft gets flagged the same as one
 * actually descending toward your house. Fields available per
 * aircraft (from the adsb.lol API):
 *
 *   ac.dst      - distance from home, nautical miles
 *   ac.dir      - bearing FROM home TO the aircraft, degrees (0=N,90=E)
 *   ac.track    - the aircraft's own ground track, degrees
 *   ac.alt_baro - barometric altitude in feet (or the string "ground")
 *   ac.gs       - ground speed, knots
 *   ac.baro_rate- climb/descend rate, ft/min (negative = descending)
 *
 * Ideas worth trying: check whether ac.track points back roughly
 * along the reciprocal of ac.dir (i.e. actually heading at you, not
 * just nearby); weight low + descending aircraft as more "imminent"
 * than high + level ones; use closing speed instead of raw distance
 * to rank sidebar order.
 *
 * Return one of: 'overhead' | 'approaching' | 'distant'
 */
function classifyProximity(ac) {
  if (ac.dst == null) return "distant";
  if (ac.dst < 3) return "overhead";
  if (ac.dst < 12) return "approaching";
  return "distant";
}

async function getRoute(callsign) {
  if (routeCache.has(callsign)) return routeCache.get(callsign);
  try {
    const res = await fetch(`/api/route?callsign=${encodeURIComponent(callsign)}`);
    const data = await res.json();
    const route = data.route && data.route.response ? data.route.response.flightroute : null;
    routeCache.set(callsign, route);
    return route;
  } catch (err) {
    routeCache.set(callsign, null);
    return null;
  }
}

function buildCardHtml(ac, route, visibility) {
  const label = (ac.flight || ac.r || ac.hex).trim();
  const altText = ac.alt_baro === "ground" ? "on ground" : `${(ac.alt_baro ?? 0).toLocaleString()} ft`;
  const gsText = ac.gs != null ? `${Math.round(ac.gs)} kt` : "";

  if (visibility === "silhouette") return "";
  if (visibility === "minimal") {
    return `<div class="callsign">${label}</div>
            <div class="meta">${altText}</div>`;
  }

  let routeHtml = "";
  if (route && route.origin && route.destination) {
    const miToGo = Math.round(
      haversineMiles(ac.lat, ac.lon, route.destination.latitude, route.destination.longitude)
    );
    // ETA in the viewer's local time (destination timezone would need a
    // tz database; "local" here means local to this display).
    let etaHtml = `${miToGo.toLocaleString()} mi to go`;
    if (ac.gs > 50) {
      const hours = miToGo / (ac.gs * MI_PER_NM);
      const eta = new Date(Date.now() + hours * 3600 * 1000);
      const hh = eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      etaHtml = `${hh} local&ensp;&middot;&ensp;${etaHtml}`;
    }
    routeHtml = `<div class="route-line">${route.origin.iata_code} &rarr; ${route.destination.iata_code}&ensp;${route.destination.municipality}</div>
                 <div class="eta">${etaHtml}</div>`;
  }

  return `<div class="callsign">${label}</div>
          <div class="meta">${typeName(ac)}&ensp;${altText}&ensp;${gsText}</div>
          ${routeHtml}`;
}

function renderPlane(ac, proximity, direction, visibility, route) {
  const color = directionColor(direction, ac.alt_baro);
  const track = ac.track ?? ac.true_heading ?? 0;
  const pos = polarToPixels(ac.dst, ac.dir);

  let entry = markers.get(ac.hex);
  if (!entry) {
    const el = document.createElement("div");
    el.className = "plane";
    document.getElementById("planes").appendChild(el);
    entry = { el };
    markers.set(ac.hex, entry);
  }
  entry.direction = direction;
  entry.data = ac;

  // Text legibility tracks urgency: a plane near the epicenter gets a
  // fully opaque card, one out at the rim fades to a whisper (but never
  // below 0.3, so nothing on screen is unreadable).
  const cardOpacity = Math.max(0.3, 1 - 0.75 * (ac.dst / RADIUS_NM));
  // Cruise-level traffic is a ghost: dimmer glyph, no text at all.
  const glyphOpacity = visibility === "silhouette" ? 0.35 : 1;

  entry.el.className = `plane ${proximity} ${visibility}`;
  entry.el.style.left = `${pos.x}px`;
  entry.el.style.top = `${pos.y}px`;
  entry.el.innerHTML = `
    <div class="glyph-wrap" style="transform:rotate(${track}deg);color:${color};opacity:${glyphOpacity}">${planeSvg(color, ac)}</div>
    <div class="card" style="opacity:${cardOpacity}">${buildCardHtml(ac, route, visibility)}</div>
  `;
}

/*
 * Trails used to be drawn by connecting each aircraft's last few
 * reported lat/lon fixes across polls. That broke in a specific way:
 * we merge three independent community ADS-B feeds by picking
 * whichever has the freshest report each poll, but "freshest this
 * poll" isn't guaranteed monotonic against "freshest last poll" --
 * different receivers lag independently. The two positions chained
 * together could occasionally be effectively out of chronological
 * order, which pointed a trail segment in the exact reverse of the
 * aircraft's real heading (confirmed empirically: two aircraft out of
 * 61 had a trail bearing ~180 degrees off their reported track).
 *
 * Fixing that class of bug outright, rather than just reducing its
 * odds: don't derive direction from a chain of cross-poll position
 * deltas at all. Draw a short fading tail anchored at the plane's own
 * current pixel position, pointed along the reciprocal of its own
 * broadcast track -- a value the aircraft reports about itself each
 * poll, immune to our merge-timing entirely. This can't point the
 * wrong way, and can't visually separate from the plane, because it's
 * drawn from the exact same anchor point as the glyph itself.
 */
function renderTrails() {
  const el = document.getElementById("trails");
  let segments = "";
  for (const [hex, entry] of markers) {
    const ac = entry.data;
    const track = ac?.track ?? ac?.true_heading;
    if (!ac || track == null || ac.dst == null || ac.dir == null) continue;

    const hue = DIRECTION_HUE[entry.direction] ?? DIRECTION_HUE.transit;
    const pos = polarToPixels(ac.dst, ac.dir); // same anchor as the plane glyph
    const rad = ((track + 180) * Math.PI) / 180; // reciprocal of heading = behind
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    // Faster aircraft get a slightly longer tail -- more "motion", not
    // a literal distance-per-second scale.
    const gs = ac.gs ?? 150;
    const stepLen = Math.max(3, Math.min(8, gs / 40));

    let x = pos.x, y = pos.y;
    for (let step = 0; step < 5; step++) {
      // dx/dy is already the screen-space vector for bearing (track+180)
      // -- i.e. "behind" -- so each step must ADD it to keep walking
      // further behind; subtracting would walk back toward "ahead".
      const nx = x + dx * stepLen;
      const ny = y + dy * stepLen;
      const opacity = Math.max(0.03, 0.28 - step * 0.05);
      segments += `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}"
        x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"
        stroke="hsl(${hue},90%,62%)" stroke-opacity="${opacity.toFixed(2)}"
        stroke-width="1.4" stroke-linecap="round"/>`;
      x = nx;
      y = ny;
    }
  }
  el.innerHTML = `<svg style="position:absolute;inset:0;width:100%;height:100%;overflow:visible">${segments}</svg>`;
}

function updateAircraft(list) {
  const seen = new Set();

  list.forEach((ac) => {
    if (ac.lat == null || ac.lon == null || ac.dst == null || ac.dir == null) return;
    seen.add(ac.hex);
    const proximity = classifyProximity(ac);
    const direction = classifyDirection(ac);
    const visibility = classifyVisibility(ac);
    const callsign = (ac.flight || "").trim();
    const route = callsign ? routeCache.get(callsign) : null;
    renderPlane(ac, proximity, direction, visibility, route);
  });

  for (const [hex, entry] of markers) {
    if (!seen.has(hex)) {
      entry.el.remove();
      markers.delete(hex);
    }
  }

  renderTrails();
  document.getElementById("ac-count").textContent = seen.size;
}

async function refreshAircraft() {
  try {
    const res = await fetch(`/api/aircraft?radius_nm=${RADIUS_NM}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Filter before the route prefetch so we don't burn adsbdb lookups
    // on taxiing aircraft we'll never draw.
    const list = (data.ac || []).filter(isTrackable);

    const callsigns = [...new Set(list.map((ac) => (ac.flight || "").trim()).filter(Boolean))];
    const missing = callsigns.filter((c) => !routeCache.has(c));
    await Promise.all(missing.map((c) => getRoute(c)));

    lastList = list;
    setStatus("live");
    updateAircraft(list);
    document.getElementById("last-update").textContent = new Date().toLocaleTimeString();
  } catch (err) {
    setStatus("down");
    console.error("aircraft refresh failed:", err);
  }
}

function setStatus(state) {
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  dot.className = "status-dot " + state;
  text.textContent = { live: "live", down: "unreachable" }[state] || state;
}

function updateClock() {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString();
}

function wireControls() {
  document.getElementById("fullscreen-btn").addEventListener("click", () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  });

  window.addEventListener("resize", () => {
    computeGeometry();
    drawRings(RADIUS_NM);
    updateAircraft(lastList);
  });
}

/* ---- first-run setup / location settings ---- */

function openSetup(cfg, firstRun) {
  const val = (id, v) => (document.getElementById(id).value = v ?? "");
  val("setup-home-label", cfg.home_label);
  val("setup-home-lat", cfg.home_lat);
  val("setup-home-lon", cfg.home_lon);
  (cfg.poi || []).slice(0, 2).forEach((p, i) => {
    const n = i + 1;
    val(`setup-poi${n}-label`, p.label);
    val(`setup-poi${n}-lat`, p.lat);
    val(`setup-poi${n}-lon`, p.lon);
    val(`setup-poi${n}-runways`, formatRunwaySpec(p.runways));
    if (n === 2) document.getElementById("setup-poi2-type").value = p.type || "landmark";
  });
  val("setup-radius", cfg.radius_nm ?? 40);
  document.getElementById("setup-sound").checked = !!cfg.sound_enabled;
  document.getElementById("setup-constellations").checked = !!cfg.show_constellations;
  document.getElementById("setup-hud").checked = cfg.hud_default !== false;
  document.getElementById("setup-fullscreen").checked = !!cfg.fullscreen_default;
  updateProjectorUrl();
  document.getElementById("setup-cancel").classList.toggle("hidden", firstRun);
  document.getElementById("setup-error").classList.add("hidden");
  document.getElementById("setup-overlay").classList.remove("hidden");
}

/* The kiosk device is another machine, so the URL must use this
   server's LAN address (reported by /api/config), never "localhost". */
function updateProjectorUrl() {
  const cfg = CONFIG_SNAPSHOT || {};
  const host = cfg.lan_ip && cfg.port ? `${cfg.lan_ip}:${cfg.port}` : location.host;
  const radius = document.getElementById("setup-radius").value || cfg.radius_nm || 40;
  const sound = document.getElementById("setup-sound").checked ? 1 : 0;
  const consts = document.getElementById("setup-constellations").checked ? 1 : 0;
  const hud = document.getElementById("setup-hud").checked ? 1 : 0;
  const fullscreen = document.getElementById("setup-fullscreen").checked ? 1 : 0;
  const url = `http://${host}/?radius=${radius}&sound=${sound}&constellations=${consts}&hud=${hud}&fullscreen=${fullscreen}`;
  document.getElementById("projector-url").value = url;
  renderProjectorQr(url);
}

/* qrcode() comes from vendor/qrcode.js (Kazuhiko Arase's public-domain
   QR encoder -- see README credits). Type 0 = auto-pick the smallest
   version that fits; error correction M is a reasonable middle ground
   for a URL this length. White background/black modules regardless of
   app theme, since a QR scanner needs the contrast, not the aesthetic. */
function renderProjectorQr(url) {
  const el = document.getElementById("projector-qr");
  try {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
  } catch (err) {
    el.innerHTML = "";
  }
}

function copyProjectorUrl() {
  const input = document.getElementById("projector-url");
  input.select();
  // navigator.clipboard needs a secure context, which plain-HTTP LAN
  // pages aren't; execCommand still works there.
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(input.value);
  } else {
    document.execCommand("copy");
  }
  const btn = document.getElementById("copy-url-btn");
  btn.textContent = "Copied";
  setTimeout(() => (btn.textContent = "Copy"), 1500);
}

async function saveSetup() {
  const get = (id) => document.getElementById(id).value.trim();
  const errEl = document.getElementById("setup-error");

  const lat = parseFloat(get("setup-home-lat"));
  const lon = parseFloat(get("setup-home-lon"));
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    errEl.textContent = "Home latitude/longitude look invalid — paste them from Google Maps.";
    errEl.classList.remove("hidden");
    return;
  }

  const poi = [];
  for (const n of [1, 2]) {
    const plat = parseFloat(get(`setup-poi${n}-lat`));
    const plon = parseFloat(get(`setup-poi${n}-lon`));
    if (!isFinite(plat) || !isFinite(plon)) continue;
    const type = n === 1 ? "airport" : document.getElementById("setup-poi2-type").value;
    const entry = { label: get(`setup-poi${n}-label`), lat: plat, lon: plon, type };
    if (type === "airport") entry.runways = parseRunwaySpec(get(`setup-poi${n}-runways`));
    poi.push(entry);
  }

  const res = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      home_lat: lat,
      home_lon: lon,
      home_label: get("setup-home-label"),
      poi,
      radius_nm: parseFloat(get("setup-radius")) || 40,
      sound_enabled: document.getElementById("setup-sound").checked,
      show_constellations: document.getElementById("setup-constellations").checked,
      hud_default: document.getElementById("setup-hud").checked,
      fullscreen_default: document.getElementById("setup-fullscreen").checked,
    }),
  });
  if (!res.ok) {
    errEl.textContent = "Saving failed — is the server still running?";
    errEl.classList.remove("hidden");
    return;
  }
  // Full reload is the cleanest way to restart polling/rings/labels
  // against the new location.
  location.reload();
}

let CONFIG_SNAPSHOT = null;

async function init() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  CONFIG_SNAPSHOT = cfg;

  generateStarfield();
  computeGeometry();
  updateClock();
  setInterval(updateClock, 1000);

  document.getElementById("setup-save").addEventListener("click", saveSetup);
  document.getElementById("setup-cancel").addEventListener("click", () => {
    document.getElementById("setup-overlay").classList.add("hidden");
  });
  document.getElementById("settings-btn").addEventListener("click", () => {
    openSetup(CONFIG_SNAPSHOT, false);
  });
  document.getElementById("copy-url-btn").addEventListener("click", copyProjectorUrl);
  ["setup-radius", "setup-sound", "setup-constellations", "setup-hud", "setup-fullscreen"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateProjectorUrl);
  });

  if (!cfg.configured) {
    openSetup(cfg, true);
    return;
  }

  HOME_LAT = cfg.home_lat;
  HOME_LON = cfg.home_lon;
  HOME_LABEL = cfg.home_label || "";
  POIS = cfg.poi || [];
  POLL_MS = cfg.poll_interval_seconds * 1000;

  // Every one of these follows the same precedence: an explicit URL
  // query parameter (e.g. a per-device projector link) wins; otherwise
  // fall back to default_settings.cfg's values (the plain page load,
  // with no query string at all, is what the gear icon configures).
  const urlRadius = parseFloat(URL_PARAMS.get("radius"));
  RADIUS_NM = isFinite(urlRadius) ? Math.max(5, Math.min(250, urlRadius)) : cfg.radius_nm;

  const constParam = URL_PARAMS.get("constellations");
  SHOW_CONSTELLATIONS = constParam != null ? constParam === "1" : !!cfg.show_constellations;
  if (SHOW_CONSTELLATIONS) generateStarfield();

  const hudParam = URL_PARAMS.get("hud");
  const hudVisible = hudParam != null ? hudParam === "1" : cfg.hud_default !== false;
  document.body.classList.toggle("no-hud", !hudVisible);

  document.getElementById("home-label").textContent = HOME_LABEL;

  drawRings(RADIUS_NM);
  updateLabelScale();
  wireControls();

  refreshAircraft();
  setInterval(refreshAircraft, POLL_MS);

  const soundParam = URL_PARAMS.get("sound");
  const soundOn = soundParam != null ? soundParam === "1" : !!cfg.sound_enabled;
  if (soundOn) setSound(true);

  // The plain home URL (no query string) always attempts fullscreen --
  // this is a kiosk display, not a page anyone browses normally. The
  // "Start fullscreen" setting still matters for the generated
  // Projector URL, so a *different* device can be given &fullscreen=0
  // explicitly if it shouldn't auto-fullscreen.
  const fsParam = URL_PARAMS.get("fullscreen");
  const wantsFullscreen = fsParam != null ? fsParam === "1" : true;
  if (wantsFullscreen) {
    // Browsers require a user gesture for the Fullscreen API in most
    // configurations, so this best-effort attempt commonly gets
    // silently rejected on a fresh page load -- the fullscreen button
    // is the reliable fallback, which is why it's never hidden.
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

init();
