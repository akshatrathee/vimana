/* Vimana — ambient audio.
   Two layers, both driven by app.js's setSound() -- called on load per
   default_settings.cfg / URL param, or toggled from the gear icon's
   settings panel. Browsers refuse to autoplay audio without a user
   gesture; if sound is enabled without one (e.g. on page load), it
   silently retries on first click/tap. A kiosk Chromium can bypass
   this entirely with --autoplay-policy=no-user-gesture-required:

   1. Music: assets/Skybound.mp3, engineered to loop with no audible
      seam (the source file had a baked-in fade in/out; we trimmed to
      its stable middle section and crossfaded tail into head so
      native <audio> looping plays it as one continuous, perpetual
      track rather than dipping to silence and restarting).
   2. Sporadic "ATC radio": 13 short AI-generated voice clips, one
      picked at random each time, pushed through a Web Audio radio
      chain (bandpass + soft clipping + noise bed + squelch clicks),
      fired at random 15-45s intervals. If the clips are missing, it
      falls back to static-only bursts.

   Controller-voiced clips (ground/tower/approach) share one accent
   direction -- neutral, with a very subtle North Indian inflection,
   since this is Delhi airspace -- while pilot-voiced clips carry
   their airline's home-country accent (Thai, Japanese, German,
   Finnish, Indian for the India-based carrier). */

const MUSIC_URL = "assets/Skybound.mp3";
const MUSIC_VOLUME = 0.3;
const ATC_CLIPS = [
  "assets/atc/atc-1.mp3",
  "assets/atc/atc-2.mp3",
  "assets/atc/atc-4.mp3",
  "assets/atc/atc-5.mp3",
  "assets/atc/atc-6.mp3",
  "assets/atc/atc-8.mp3",
  "assets/atc/atc-9.mp3",
  "assets/atc/atc-10.mp3",
  "assets/atc/atc-thai.mp3",
  "assets/atc/atc-japan.mp3",
  "assets/atc/atc-lufthansa-pilot.mp3",
  "assets/atc/atc-finnair.mp3",
  "assets/atc/atc-akasa.mp3",
];
const ATC_VOLUME = 0.5;
const ATC_MIN_GAP_MS = 15 * 1000;
const ATC_MAX_GAP_MS = 45 * 1000;

let audioCtx = null;
let music = null;
let atcTimer = null;
let atcBuffers = []; // decoded AudioBuffers (may be empty on fetch failure)

function initAudioOnce() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  music = new Audio(MUSIC_URL);
  music.loop = true;
  music.volume = MUSIC_VOLUME;

  // Decode ATC clips up front; failures leave the static-only fallback.
  ATC_CLIPS.forEach(async (url) => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      const buf = await audioCtx.decodeAudioData(await resp.arrayBuffer());
      atcBuffers.push(buf);
    } catch (err) {
      /* clip unavailable -- fallback handles it */
    }
  });
}

function makeNoiseBuffer(seconds) {
  const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * seconds, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/* Soft-clip curve: pushes voice into cheap-transmitter distortion. */
function makeClipCurve(amount) {
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 128) - 1;
    curve[i] = Math.tanh(amount * x);
  }
  return curve;
}

function playSquelch(atTime, gainValue) {
  const src = audioCtx.createBufferSource();
  src.buffer = makeNoiseBuffer(0.06);
  const hp = audioCtx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1500;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(gainValue, atTime);
  g.gain.exponentialRampToValueAtTime(0.001, atTime + 0.06);
  src.connect(hp).connect(g).connect(audioCtx.destination);
  src.start(atTime);
}

function playStaticBurst(seconds) {
  const now = audioCtx.currentTime;
  const src = audioCtx.createBufferSource();
  src.buffer = makeNoiseBuffer(seconds);
  const bp = audioCtx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1400;
  bp.Q.value = 0.6;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(ATC_VOLUME * 0.12, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + seconds);
  src.connect(bp).connect(g).connect(audioCtx.destination);
  src.start(now);
  playSquelch(now, ATC_VOLUME * 0.3);
  playSquelch(now + seconds - 0.05, ATC_VOLUME * 0.25);
}

function playTransmission() {
  if (!atcBuffers.length) {
    playStaticBurst(0.8 + Math.random() * 1.2);
    return;
  }
  const buffer = atcBuffers[Math.floor(Math.random() * atcBuffers.length)];
  const now = audioCtx.currentTime;

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  // Slight speed jitter: no two transmissions sound identical.
  src.playbackRate.value = 0.96 + Math.random() * 0.08;

  const bp = audioCtx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1200;
  bp.Q.value = 0.7;

  const clip = audioCtx.createWaveShaper();
  clip.curve = makeClipCurve(2.5);

  const g = audioCtx.createGain();
  g.gain.value = ATC_VOLUME;

  src.connect(bp).connect(clip).connect(g).connect(audioCtx.destination);

  // Noise bed under the voice, so it reads as "radio", not "podcast".
  const bed = audioCtx.createBufferSource();
  bed.buffer = makeNoiseBuffer(buffer.duration + 0.2);
  const bedGain = audioCtx.createGain();
  bedGain.gain.value = ATC_VOLUME * 0.05;
  bed.connect(bedGain).connect(audioCtx.destination);

  playSquelch(now, ATC_VOLUME * 0.35);
  src.start(now + 0.08);
  bed.start(now);
  playSquelch(now + 0.08 + buffer.duration, ATC_VOLUME * 0.3);
}

function scheduleNextTransmission() {
  const delay = ATC_MIN_GAP_MS + Math.random() * (ATC_MAX_GAP_MS - ATC_MIN_GAP_MS);
  atcTimer = setTimeout(() => {
    playTransmission();
    scheduleNextTransmission();
  }, delay);
}

let soundWanted = false; // tracks the last setSound() call, for the retry below

function setSound(on) {
  soundWanted = on;
  if (on) {
    initAudioOnce();
    audioCtx.resume();
    music.play().catch(() => {
      // Autoplay blocked (no user gesture yet -- happens when sound is
      // enabled by default_settings.cfg/URL param rather than a click,
      // in a browser without an autoplay-policy override). Retry on
      // first interaction, unless sound got turned off again meanwhile.
      window.addEventListener(
        "pointerdown",
        () => {
          if (soundWanted) setSound(true);
        },
        { once: true }
      );
    });
    playTransmission(); // one immediately, so enabling sound feels alive
    scheduleNextTransmission();
  } else {
    if (music) music.pause();
    if (atcTimer) clearTimeout(atcTimer);
    if (audioCtx) audioCtx.suspend();
  }
}
