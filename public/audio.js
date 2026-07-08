/* Vimana — ambient audio.
   Two layers, both behind the HUD "sound" toggle (browsers refuse to
   autoplay audio until the user interacts with the page, so the toggle
   click doubles as the unlock gesture; a kiosk Chromium can bypass
   this with --autoplay-policy=no-user-gesture-required):

   1. Music: assets/Skybound.mp3 on a gentle loop.
   2. Sporadic "ATC radio": short AI-generated voice clips pushed
      through a Web Audio radio chain (bandpass + soft clipping +
      noise bed + squelch clicks), fired at random 25-75s intervals.
      If the clips are missing, it falls back to static-only bursts. */

const MUSIC_URL = "assets/Skybound.mp3";
const MUSIC_VOLUME = 0.3;
const ATC_CLIPS = ["assets/atc/atc-1.mp3", "assets/atc/atc-2.mp3", "assets/atc/atc-3.mp3"];
const ATC_VOLUME = 0.5;
const ATC_MIN_GAP_MS = 25 * 1000;
const ATC_MAX_GAP_MS = 75 * 1000;

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

function setSound(on) {
  if (on) {
    initAudioOnce();
    audioCtx.resume();
    music.play().catch(() => {
      // Autoplay blocked (no user gesture yet -- happens when the
      // ?sound=1 kiosk URL is opened in a normal browser without
      // Chromium's --autoplay-policy flag). Retry on first interaction.
      window.addEventListener(
        "pointerdown",
        () => {
          if (document.getElementById("sound-input").checked) setSound(true);
        },
        { once: true }
      );
    });
    playTransmission(); // one immediately, so the toggle feels alive
    scheduleNextTransmission();
  } else {
    if (music) music.pause();
    if (atcTimer) clearTimeout(atcTimer);
    if (audioCtx) audioCtx.suspend();
  }
}

document.getElementById("sound-input").addEventListener("change", (e) => setSound(e.target.checked));
