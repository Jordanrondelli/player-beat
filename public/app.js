// ===== FLAME GENERATION =====
function createFlames(container, count, hMin, hMax, wMin, wMax) {
  const palettes = [
    // core orange-red
    { inner: 'rgba(255,220,80,.7)', mid: 'rgba(255,120,20,.5)', outer: 'rgba(255,40,0,.15)' },
    // hot white-yellow
    { inner: 'rgba(255,250,200,.6)', mid: 'rgba(255,180,50,.45)', outer: 'rgba(255,80,0,.1)' },
    // deep red
    { inner: 'rgba(255,80,20,.65)', mid: 'rgba(200,30,0,.4)', outer: 'rgba(150,10,0,.1)' },
    // bright orange
    { inner: 'rgba(255,160,40,.6)', mid: 'rgba(255,100,0,.45)', outer: 'rgba(255,50,0,.12)' },
  ];
  for (let i = 0; i < count; i++) {
    const flame = document.createElement('div');
    flame.className = 'flame';
    const p = palettes[Math.floor(Math.random() * palettes.length)];
    flame.style.cssText = `
      width:${wMin + Math.random() * (wMax - wMin)}px;
      height:${hMin + Math.random() * (hMax - hMin)}px;
      left:${Math.random() * 100}%;
      background:radial-gradient(ellipse at 50% 85%,${p.inner},${p.mid} 40%,${p.outer} 70%,transparent 90%);
      --dur:${.3 + Math.random() * .5}s;
      --op:${.45 + Math.random() * .35};
      animation-delay:${Math.random() * -.8}s;
    `;
    container.appendChild(flame);
  }
}

// ===== SETTINGS =====
let playerSettings = {};
async function loadPlayerSettings() {
  try {
    const res = await fetch('/api/settings');
    if (res.ok) playerSettings = await res.json();
  } catch (e) { /* use defaults */ }
  applyPlayerSettings();
}
function isPowerEnabled() {
  if (ytIsCurrentSource) {
    return playerSettings.power_youtube !== 'false'; // default true
  }
  return playerSettings.power_uploads !== 'false'; // default true
}
function applyPlayerSettings() {
  // Power block visibility (depends on current source)
  const powerOn = isPowerEnabled();
  const hammerEl = document.getElementById('hammerMeter');
  if (hammerEl) hammerEl.style.display = powerOn ? '' : 'none';
  // If power just got disabled, clean up all lingering effects
  if (!powerOn) {
    cleanupPowerEffects();
  }
  // Fire button visibility
  const fireEnabled = playerSettings.fire_button_enabled !== 'false';
  const fireWrap = document.querySelector('.fire-wrap');
  if (fireWrap) fireWrap.style.display = fireEnabled ? '' : 'none';
}
function cleanupPowerEffects() {
  // Remove all overload/shake classes from all elements
  const wp = document.querySelector('.waveform-panel');
  const cc = document.querySelector('.chat-card');
  const uc = document.querySelector('.user-card');
  const wrapper = document.getElementById('wrapper');
  if (wp) wp.classList.remove('overload-shake', 'overload-border');
  if (cc) cc.classList.remove('overload-shake');
  if (uc) uc.classList.remove('overload-shake');
  if (wrapper) wrapper.classList.remove('shaking');
  document.querySelectorAll('.overload-chroma').forEach(el => el.remove());
  // Reset hammer state
  hammerCharge = 0;
  displayedHammerPct = 0;
  currentHammerStage = 'cool';
  const hammerCard = document.getElementById('hammerMeter');
  if (hammerCard) hammerCard.setAttribute('data-stage', 'cold');
  const hammerStageEl = document.getElementById('hammerStage');
  if (hammerStageEl) hammerStageEl.textContent = '';
}
loadPlayerSettings();
// Reload settings periodically (admin can change them live)
setInterval(loadPlayerSettings, 10000);

// ===== AUDIO CONTEXT =====
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const gainNode = audioCtx.createGain();
let audioBuffer = null;
let sourceNode = null;
let isPlaying = false;
let startTime = 0;
let pauseOffset = 0;
let playlist = []; // array of { name, arrayBuffer } or { name, youtubeId, queueItem }
let currentTrackIndex = -1;
let waveformData = [];
let waveformSigned = []; // signed samples for neon line display

// ===== YOUTUBE IFRAME PLAYER =====
let ytPlayer = null;
let ytReady = false;
let ytIsCurrentSource = false; // true when current track is YouTube
let ytDuration = 0;

function onYouTubeIframeAPIReady() {
  ytPlayer = new YT.Player('ytPlayer', {
    width: 320, height: 180,
    playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, modestbranding: 1, rel: 0 },
    events: {
      onReady: () => { ytReady = true; console.log('YouTube IFrame Player ready'); },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED && ytIsCurrentSource) {
          stopAudio();
          // Auto-advance
          if (playlist.length > 1) {
            const next = currentTrackIndex + 1;
            if (next < playlist.length) loadTrack(next);
            else fetchAndLoadQueue(currentSource);
          }
        }
      },
    },
  });
}
// Make it global for YouTube API callback
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

// Analyser for spectrum
const analyser = audioCtx.createAnalyser();
analyser.fftSize = 512;
analyser.smoothingTimeConstant = 0.4;
const frequencyData = new Uint8Array(analyser.frequencyBinCount);

// Bandpass filter to isolate kick thump (60-100Hz body)
const kickFilter = audioCtx.createBiquadFilter();
kickFilter.type = 'bandpass';
kickFilter.frequency.value = 80;  // center of 60-100Hz
kickFilter.Q.value = 1.8;         // Q ~1.8 → bandwidth ~44Hz (≈60-104Hz)

const kickAnalyser = audioCtx.createAnalyser();
kickAnalyser.fftSize = 256;
kickAnalyser.smoothingTimeConstant = 0.08; // faster response for transient detection
const kickTimeData = new Uint8Array(kickAnalyser.fftSize);

kickFilter.connect(kickAnalyser);
gainNode.connect(analyser);
analyser.connect(audioCtx.destination);

// ===== DOM REFERENCES =====
const waveformCanvas = document.getElementById('waveformCanvas');
const waveformCtx = waveformCanvas.getContext('2d');
const miniCanvas = document.getElementById('miniCanvas');
const miniCtx = miniCanvas.getContext('2d');
const scene = document.getElementById('scene');
const bgEl = document.querySelector('.bg');
const bgDimEl = document.querySelector('.bg-dim');
const playBtn = document.getElementById('playBtn');
const playImg = document.getElementById('playImg');
const pauseImg = document.getElementById('pauseImg');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl = document.getElementById('totalTime');
const miniProgress = document.getElementById('miniProgress');
const loadingOverlay = document.getElementById('loadingOverlay');
const volumeSlider = document.getElementById('volumeSlider');
const volumeIcon = document.getElementById('volumeIcon');
const glow1El = document.querySelector('.waveform-glow');
const glow2El = document.querySelector('.waveform-glow2');

// ===== VOLUME CONTROL =====
let lastVolume = 1;
volumeSlider.addEventListener('input', () => {
  const vol = parseFloat(volumeSlider.value);
  gainNode.gain.value = vol;
  updateVolumeIcon(vol);
});

volumeIcon.addEventListener('click', () => {
  if (gainNode.gain.value > 0) {
    lastVolume = gainNode.gain.value;
    gainNode.gain.value = 0;
    volumeSlider.value = 0;
    updateVolumeIcon(0);
  } else {
    gainNode.gain.value = lastVolume;
    volumeSlider.value = lastVolume;
    updateVolumeIcon(lastVolume);
  }
});

function updateVolumeIcon(vol) {
  if (vol === 0) volumeIcon.setAttribute('aria-label', 'Son coupe');
  else volumeIcon.setAttribute('aria-label', 'Volume');
}

// ===== CANVAS RESIZE =====
function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;

  const wfRect = waveformCanvas.parentElement.getBoundingClientRect();
  waveformCanvas.width = wfRect.width * dpr;
  waveformCanvas.height = wfRect.height * dpr;
  waveformCtx.scale(dpr, dpr);
  waveformCanvas.style.width = wfRect.width + 'px';
  waveformCanvas.style.height = wfRect.height + 'px';

  const miniRect = miniCanvas.parentElement.getBoundingClientRect();
  miniCanvas.width = miniRect.width * dpr;
  miniCanvas.height = miniRect.height * dpr;
  miniCtx.scale(dpr, dpr);
  miniCanvas.style.width = miniRect.width + 'px';
  miniCanvas.style.height = miniRect.height + 'px';

  if (waveformData.length) drawMiniWaveform();
}
window.addEventListener('resize', resizeCanvases);

// ===== SMOOTH WAVEFORM DATA =====
function smoothWaveformData(data, radius) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    let sum = 0, count = 0;
    for (let j = -radius; j <= radius; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < data.length) {
        const weight = 1 - Math.abs(j) / (radius + 1);
        sum += data[idx] * weight;
        count += weight;
      }
    }
    out[i] = sum / count;
  }
  return Array.from(out);
}

// ===== WAVEFORM DATA =====
function generateDemoData() {
  const n = 10000;
  waveformData = [];
  waveformSigned = [];
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    a += .15 + Math.random() * .05;
    b += .08 + Math.random() * .03;
    c += .3 + Math.random() * .1;
    let v = Math.sin(a) * .35 + Math.sin(b) * .25 + Math.sin(c) * .15 + (Math.random() - .5) * .25;
    v *= Math.max(.08, Math.pow(Math.sin(t * Math.PI), .5) * (.5 + .5 * Math.sin(t * 8 + Math.sin(t * 3) * 2)));
    waveformSigned.push(v); // keep sign
    waveformData.push(Math.abs(v));
  }
  const max = Math.max(...waveformData);
  waveformData = waveformData.map(v => v / max);
  waveformSigned = waveformSigned.map(v => v / max);
}

function extractWaveformData(buffer) {
  const raw = buffer.getChannelData(0);
  const n = 20000;
  const blockLen = Math.floor(raw.length / n);
  waveformData = [];
  waveformSigned = []; // now stores absolute peak envelope (always positive)
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let maxAbs = 0;
    for (let j = 0; j < blockLen; j++) {
      const s = raw[i * blockLen + j] || 0;
      sum += s * s;
      const a = Math.abs(s);
      if (a > maxAbs) maxAbs = a;
    }
    waveformData.push(Math.sqrt(sum / blockLen));
    waveformSigned.push(maxAbs); // absolute peak envelope — no sign oscillation
  }
  const maxRms = Math.max(...waveformData);
  if (maxRms > 0) waveformData = waveformData.map(v => v / maxRms);
  const maxPeak = Math.max(...waveformSigned);
  if (maxPeak > 0) waveformSigned = waveformSigned.map(v => v / maxPeak);
}

// ===== MINI WAVEFORM (drawn once) =====
function drawMiniWaveform() {
  const dpr = window.devicePixelRatio || 1;
  const w = miniCanvas.width / dpr;
  const h = miniCanvas.height / dpr;
  miniCtx.clearRect(0, 0, w, h);
  const centerY = h / 2;
  const barW = 1.2, gap = 0.5, step = barW + gap;
  const numBars = Math.floor(w / step);
  for (let i = 0; i < numBars; i++) {
    const idx = Math.floor((i / numBars) * waveformData.length);
    const val = waveformData[Math.min(idx, waveformData.length - 1)] || 0;
    const barH = Math.max(.5, val * (h * .42));
    miniCtx.fillStyle = 'rgba(255,255,255,.2)';
    miniCtx.fillRect(i * step, centerY - barH, barW, barH * 2);
  }
}

// ===== LOUDNESS ANALYSER =====
const loudnessAnalyser = audioCtx.createAnalyser();
loudnessAnalyser.fftSize = 1024;           // 1024 → ~23ms latency (was 2048 → ~46ms)
loudnessAnalyser.smoothingTimeConstant = 0.05; // near-zero WebAudio smoothing for instant response
const loudnessTimeData = new Uint8Array(loudnessAnalyser.fftSize);
gainNode.connect(loudnessAnalyser);

// ===== KICK DETECTION STATE =====
let prevKickLevel = 0;
let kickDecay = 0;
let kickActivity = 0; // smoothed kick presence: stays high while kicks keep hitting
let density = 0;
let densitySmooth = 0;
let lastKickTime = 0;
let hammerSmooth = 0;
let loudnessSmooth = 0;
let hammerHitTimeout = null;
let nextBeatTime = 0;       // audioCtx time of next beat
let beatSchedulerId = null;  // rAF id for beat scheduler
const hammerIconEl = document.getElementById('hammerIcon');
const hammerCard = document.getElementById('hammerMeter');
const gaugeFill = document.getElementById('gaugeFill');
const gaugeGlow = document.getElementById('gaugeGlow');
const hammerSparks = document.getElementById('hammerSparks');
const hammerShockwave = document.getElementById('hammerShockwave');
const hammerStageEl = document.getElementById('hammerStage');
let currentHammerStage = 'cool';
let hammerCharge = 0;
let displayedHammerPct = 0;
let hammerPeakStage = 'cool';
let hammerCooldownStart = 0; // timestamp when we dropped below 75%
// Multi-criteria power scoring state
const loudnessFreqData = new Uint8Array(loudnessAnalyser.frequencyBinCount);
let hammerKickSmooth = 0;     // smoothed kick impact for scoring
let criteriaMax = { sub: 0.001, bass: 0.001, kick: 0.001, fullness: 0.001, loudness: 0.001, lowHighRatio: 0.001 };
let criteriaSmooth = { sub: 0, bass: 0, kick: 0, fullness: 0, loudness: 0, lowHighRatio: 0 };
let prescanDone = false; // true once offline pre-scan has set criteriaMax

// A-weighting: attempt IEC 61672 standard curve
// Models human ear sensitivity — boosts 2-5kHz, attenuates sub-bass
function aWeight(f) {
  if (f < 10) return 0;
  const f2 = f * f;
  const ra = (148693636 * f2 * f2) /
    ((f2 + 424.36) * (f2 + 148693636) * Math.sqrt((f2 + 11599.29) * (f2 + 544496.41)));
  return ra / 0.7943; // normalize: 1kHz = 1.0
}
// Pre-compute A-weight table (avoid recalc every frame)
const aWeightTable = new Float32Array(loudnessAnalyser.frequencyBinCount);
{
  const binHz = audioCtx.sampleRate / loudnessAnalyser.fftSize;
  for (let i = 0; i < aWeightTable.length; i++) aWeightTable[i] = aWeight(i * binHz);
}
// ===== MINI RADIX-2 FFT =====
function fftReal(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = -2 * Math.PI / len;
    const wR = Math.cos(ang), wI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1, curI = 0;
      for (let j = 0; j < half; j++) {
        const uR = re[i + j], uI = im[i + j];
        const vR = re[i + j + half] * curR - im[i + j + half] * curI;
        const vI = re[i + j + half] * curI + im[i + j + half] * curR;
        re[i + j] = uR + vR; im[i + j] = uI + vI;
        re[i + j + half] = uR - vR; im[i + j + half] = uI - vI;
        const tmpR = curR * wR - curI * wI;
        curI = curR * wI + curI * wR;
        curR = tmpR;
      }
    }
  }
}

// ===== OFFLINE PRE-SCAN =====
// Analyzes the full track buffer to compute criteriaMax BEFORE playback.
// This prevents score saturation when seeking or during early frames.
function prescanTrackCriteria(buffer) {
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const fftSize = 2048;
  const binHz = sr / fftSize;
  const hopSize = Math.floor(sr * 0.2); // analyze every 200ms (fast enough)
  const numFrames = Math.floor((data.length - fftSize) / hopSize);
  if (numFrames < 1) return;

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  // Only low-mid bands for fullness — matches real-time (80-3200Hz)
  const bandEdges = [80, 200, 400, 800, 1600, 3200];
  const awTable = new Float32Array(fftSize / 2);
  for (let i = 0; i < awTable.length; i++) awTable[i] = aWeight(i * binHz);

  let maxSub = 0, maxBass = 0, maxPunch = 0, maxFull = 0, maxLoud = 0, maxLowHigh = 0;
  const subS = Math.max(1, Math.round(20 / binHz)), subE = Math.round(80 / binHz);
  const bassS = subE, bassE = Math.round(300 / binHz);
  const highS = Math.round(2000 / binHz), highE = Math.min(Math.round(16000 / binHz), fftSize / 2);
  const loudEnd = Math.min(750, fftSize / 2);
  const maxBin = Math.min(Math.round(16000 / binHz) + 1, fftSize / 2);

  for (let f = 0; f < numFrames; f++) {
    const offset = f * hopSize;
    // Hann window + FFT
    for (let i = 0; i < fftSize; i++) {
      re[i] = (data[offset + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1)));
      im[i] = 0;
    }
    fftReal(re, im);

    // Magnitude (normalized to 0-1 range like getByteFrequencyData/255)
    const mag = new Float32Array(fftSize / 2);
    for (let i = 0; i < fftSize / 2; i++) {
      mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / fftSize;
    }

    // Sub (20-80Hz)
    let subSum = 0;
    for (let i = subS; i < subE; i++) subSum += mag[i];
    const subRaw = subSum / (subE - subS);

    // Bass (80-300Hz)
    let bassSum = 0;
    for (let i = bassS; i < bassE; i++) bassSum += mag[i];
    const bassRaw = bassSum / (bassE - bassS);

    // Punch
    const punchRaw = Math.max(subRaw * 0.8, bassRaw * 0.6);

    // Fullness
    let activeBands = 0;
    for (let b = 0; b < bandEdges.length - 1; b++) {
      const bS = Math.round(bandEdges[b] / binHz);
      const bE = Math.min(Math.round(bandEdges[b + 1] / binHz), maxBin);
      let bSum = 0;
      for (let i = bS; i < bE; i++) bSum += mag[i];
      if (bSum / (bE - bS) > 0.002) activeBands++;
    }
    const fullRaw = activeBands / (bandEdges.length - 1);

    // A-weighted loudness
    let wSum = 0, wTotal = 0;
    for (let i = 1; i < loudEnd; i++) {
      wSum += mag[i] * awTable[i];
      wTotal += awTable[i];
    }
    const aLoudRaw = wTotal > 0 ? wSum / wTotal : 0;

    // Low/high ratio
    let highSum = 0;
    for (let i = highS; i < highE; i++) highSum += mag[i];
    const highRaw = highSum / (highE - highS);
    const lowRaw = (subRaw + bassRaw) / 2;
    const lowHighRaw = highRaw > 0.0001 ? Math.min(1, lowRaw / (highRaw + 0.001)) : lowRaw > 0.0001 ? 1 : 0;

    if (subRaw > maxSub) maxSub = subRaw;
    if (bassRaw > maxBass) maxBass = bassRaw;
    if (punchRaw > maxPunch) maxPunch = punchRaw;
    if (fullRaw > maxFull) maxFull = fullRaw;
    if (aLoudRaw > maxLoud) maxLoud = aLoudRaw;
    if (lowHighRaw > maxLowHigh) maxLowHigh = lowHighRaw;
  }

  criteriaMax.sub = Math.max(0.001, maxSub);
  criteriaMax.bass = Math.max(0.001, maxBass);
  criteriaMax.kick = Math.max(0.001, maxPunch);
  criteriaMax.fullness = Math.max(0.001, maxFull);
  criteriaMax.loudness = Math.max(0.001, maxLoud);
  criteriaMax.lowHighRatio = Math.max(0.001, maxLowHigh);
  prescanDone = true;
}

let detectedBPM = 0;
let beatIntervalId = null;
const GAUGE_CIRCUMFERENCE = 326.73; // 2π × 52

// ===== MAIN WAVEFORM DRAW =====
function drawWaveform(currentTime) {
  if (!waveformData.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = waveformCanvas.width / dpr;
  const h = waveformCanvas.height / dpr;
  const duration = ytIsCurrentSource ? (ytDuration || 180) : (audioBuffer ? audioBuffer.duration : 30);
  waveformCtx.clearRect(0, 0, w, h);

  // Density: average amplitude over ~2 seconds around playhead
  const pIdx = Math.floor(((currentTime % duration) / duration) * waveformData.length);
  let dSum = 0, dCount = 0;
  const dRange = Math.floor(waveformData.length * (2 / duration));
  for (let j = Math.max(0, pIdx - dRange); j < Math.min(waveformData.length, pIdx + dRange); j++) {
    dSum += waveformData[j];
    dCount++;
  }
  density = dCount > 0 ? dSum / dCount : 0;
  densitySmooth += (density - densitySmooth) * .05;

  // Kick detection from audio analyser (or synthetic for YouTube)
  let kickLevel = 0;
  if (isPlaying && audioBuffer && !ytIsCurrentSource) {
    analyser.getByteFrequencyData(frequencyData);
    kickAnalyser.getByteTimeDomainData(kickTimeData);
    let sum = 0;
    for (let i = 0; i < kickTimeData.length; i++) {
      const v = (kickTimeData[i] - 128) / 128;
      sum += v * v;
    }
    kickLevel = Math.sqrt(sum / kickTimeData.length);
  } else if (isPlaying && ytIsCurrentSource) {
    // Enhanced kick simulation from synthetic waveform
    const wfVal = waveformData[Math.min(pIdx, waveformData.length - 1)] || 0;
    const prevVal = waveformData[Math.max(0, pIdx - 2)] || 0;
    const prevVal2 = waveformData[Math.max(0, pIdx - 4)] || 0;
    // Base energy proportional to waveform level
    kickLevel = wfVal * 0.35;
    // Detect rises (simulated transients) — sharper rises = stronger kick
    const rise1 = Math.max(0, wfVal - prevVal);
    const rise2 = Math.max(0, wfVal - prevVal2);
    if (rise1 > 0.02) kickLevel += rise1 * 3;
    if (rise2 > 0.04) kickLevel += rise2 * 1.5;
    // High-energy sections get stronger baseline kick presence
    if (wfVal > 0.65) kickLevel += (wfVal - 0.65) * 0.8;
  } else {
    kickLevel = (waveformData[Math.min(pIdx, waveformData.length - 1)] || 0) * 0.3;
  }

  const rise = kickLevel - prevKickLevel;
  const now = performance.now();
  // Tighter thresholds — bandpass 60-100Hz gives cleaner signal, less false positives
  const isKick = rise > .025 && kickLevel > .10 && (now - lastKickTime) > 100;
  prevKickLevel += (kickLevel - prevKickLevel) * .5; // faster tracking

  // Kick impact
  if (isKick) {
    lastKickTime = now;
    const intensity = Math.min(1, rise * 8 * Math.max(densitySmooth, .3));
    kickDecay = Math.max(kickDecay, intensity);
  }
  kickDecay *= .82; // faster decay for snappy kick response

  // Smoothed kick activity: rises fast on kicks, decays slowly (~3s to fade)
  // This keeps score stable between individual kick hits during a drop
  if (kickDecay > 0.15) {
    kickActivity += (1 - kickActivity) * 0.3; // fast rise
  } else {
    kickActivity *= 0.98; // faster decay (~0.6s half-life) so couplets drop properly
  }

  const windowSec = 8;
  const playheadX = w * 0.35;
  const scrollBack = 0.35 * windowSec;
  const timeStart = currentTime - scrollBack;
  const centerY = h * 0.5;

  // === KICK SHAKE — fast, punchy canvas tremble ===
  if (kickDecay > .03) {
    const shakeAmt = kickDecay * 4;
    const sx = (Math.random() - 0.5) * shakeAmt;
    const sy = (Math.random() - 0.5) * shakeAmt * 0.6;
    waveformCtx.save();
    waveformCtx.translate(sx, sy);
  }

  // Bass bloom pass — extra wide aura on kicks (screen blend)
  if (kickDecay > .02) {
    waveformCtx.save();
    waveformCtx.filter = `blur(${18 + kickDecay * 25}px)`;
    waveformCtx.globalAlpha = kickDecay * .45;
    waveformCtx.globalCompositeOperation = 'screen';
    drawWaveformBars(waveformCtx, w, h, timeStart, windowSec, playheadX, centerY, duration, kickDecay, true);
    waveformCtx.restore();
  }

  // Main neon waveform
  waveformCtx.globalAlpha = 1;
  waveformCtx.filter = 'none';
  drawWaveformBars(waveformCtx, w, h, timeStart, windowSec, playheadX, centerY, duration, kickDecay, false);

  // End kick shake
  if (kickDecay > .03) {
    waveformCtx.restore();
  }

  // Playhead glow
  const phGlow = waveformCtx.createLinearGradient(playheadX - 30, 0, playheadX + 30, 0);
  phGlow.addColorStop(0, 'transparent');
  phGlow.addColorStop(.35, `rgba(200,25,15,${.06 + kickDecay * .12})`);
  phGlow.addColorStop(.5, `rgba(220,30,20,${.12 + kickDecay * .2})`);
  phGlow.addColorStop(.65, `rgba(200,25,15,${.06 + kickDecay * .12})`);
  phGlow.addColorStop(1, 'transparent');
  waveformCtx.fillStyle = phGlow;
  waveformCtx.fillRect(playheadX - 30, 0, 60, h);

  // Playhead line
  const phAlpha = .6 + kickDecay * .3;
  waveformCtx.fillStyle = `rgba(255,255,255,${phAlpha})`;
  waveformCtx.fillRect(playheadX - .75, 0, 1.5, h);

  // Playhead dot
  const dotR = 4 + kickDecay * 2;
  waveformCtx.beginPath();
  waveformCtx.arc(playheadX, centerY, dotR, 0, Math.PI * 2);
  waveformCtx.fillStyle = `rgba(255,255,255,${.8 + kickDecay * .2})`;
  waveformCtx.fill();
  waveformCtx.beginPath();
  waveformCtx.arc(playheadX, centerY, dotR + 3, 0, Math.PI * 2);
  waveformCtx.strokeStyle = `rgba(255,200,180,${.2 + kickDecay * .3})`;
  waveformCtx.lineWidth = 1;
  waveformCtx.stroke();

  // Glow elements — intensify blur + opacity on kicks, clip to played side only
  const glowClip = `inset(0 ${100 - (playheadX / w) * 100}% 0 0)`;
  if (glow1El) { glow1El.style.opacity = .3 + kickDecay * 1.4; glow1El.style.filter = `blur(${35 + kickDecay * 25}px)`; glow1El.style.clipPath = glowClip; }
  if (glow2El) { glow2El.style.opacity = .15 + kickDecay * 1.1; glow2El.style.filter = `blur(${20 + kickDecay * 15}px)`; glow2El.style.clipPath = glowClip; }

  // Background — no kick reaction, just CSS animation

  // Loudness measurement (RMS of full signal)
  let loudnessRaw = 0;
  if (isPlaying && audioBuffer) {
    loudnessAnalyser.getByteTimeDomainData(loudnessTimeData);
    let rmsSum = 0;
    for (let i = 0; i < loudnessTimeData.length; i++) {
      const s = (loudnessTimeData[i] - 128) / 128;
      rmsSum += s * s;
    }
    loudnessRaw = Math.sqrt(rmsSum / loudnessTimeData.length);
  }
  loudnessSmooth += (loudnessRaw - loudnessSmooth) * 0.12;

  // ===== HAMMER: WAVEFORM-DRIVEN POWER SCORING =====
  // Uses the pre-computed waveform envelope (same data that drives the visual bars)
  // as the primary power source. What you SEE is what you GET.
  // Bass presence from FFT adds a bonus to reward actual low-end content.
  if (!isPowerEnabled()) {
    // Power disabled for this source — skip all hammer computation
  } else if (isPlaying && ytIsCurrentSource) {
    // YouTube mode: power from synthetic waveform (beat-aligned, section-aware)
    const wfIdx = Math.floor((currentTime / duration) * waveformData.length);
    // Wider window for smoother section-level energy
    const wfWindow = 8;
    let wfSum = 0, wfCount = 0;
    for (let i = wfIdx - wfWindow; i <= wfIdx + wfWindow; i++) {
      const ci = Math.max(0, Math.min(waveformData.length - 1, i));
      wfSum += waveformData[ci];
      wfCount++;
    }
    const wfLevel = wfSum / wfCount;

    // Simulate bass presence — scales with section energy
    const bassBonus = Math.min(1, wfLevel * wfLevel * 1.2);
    // Detect transients from the beat-aligned pulses in the synthetic waveform
    const curVal = waveformData[Math.min(wfIdx, waveformData.length - 1)] || 0;
    const prev3 = waveformData[Math.max(0, wfIdx - 3)] || 0;
    const prev6 = waveformData[Math.max(0, wfIdx - 6)] || 0;
    const riseShort = Math.max(0, curVal - prev3);
    const riseLong = Math.max(0, curVal - prev6);
    // Kick simulation — responds to beat pulses baked into the waveform
    if (riseShort > 0.03) {
      const intensity = Math.min(1, riseShort * 5 * Math.max(wfLevel, 0.3));
      kickDecay = Math.max(kickDecay, intensity);
      kickActivity += (1 - kickActivity) * 0.30;
    } else if (riseLong > 0.05) {
      kickDecay = Math.max(kickDecay, riseLong * 3);
      kickActivity += (1 - kickActivity) * 0.15;
    }
    // High-energy sections sustain kick activity
    if (wfLevel > 0.6) {
      kickActivity = Math.max(kickActivity, (wfLevel - 0.6) * 1.5);
    } else {
      kickActivity *= 0.97;
    }
    kickDecay *= 0.82;
    const kickImpact = Math.min(1, kickActivity);

    hammerSmooth += (wfLevel - hammerSmooth) * 0.12;

    const baseScore = wfLevel;
    const bassAdd = bassBonus * 0.25;
    const kickAdd = kickImpact * 0.25;
    const rawScore = Math.min(1, baseScore + bassAdd + kickAdd);
    const shaped = rawScore * rawScore * (3 - 2 * rawScore) * 100;

    const diff = shaped - hammerCharge;
    if (diff > 0) hammerCharge += diff * 0.35;
    else hammerCharge += diff * 0.008;
    hammerCharge = Math.max(0, Math.min(100, hammerCharge));
  } else if (isPlaying && audioBuffer) {
    // --- PRIMARY: Waveform envelope (RMS) at current playback position ---
    // waveformData is already normalized 0-1 relative to track peak.
    // Intro = small bars = low value. Drop = big bars = high value.
    const wfIdx = Math.floor((currentTime / duration) * waveformData.length);
    // Average a small window around current position for stability
    const wfWindow = 5;
    let wfSum = 0, wfCount = 0;
    for (let i = wfIdx - wfWindow; i <= wfIdx + wfWindow; i++) {
      const ci = Math.max(0, Math.min(waveformData.length - 1, i));
      wfSum += waveformData[ci];
      wfCount++;
    }
    const wfLevel = wfSum / wfCount; // 0-1, directly from waveform visual

    // --- SECONDARY: Bass presence bonus from FFT (rewards drops with actual bass) ---
    loudnessAnalyser.getByteFrequencyData(loudnessFreqData);
    const hrBins = loudnessAnalyser.frequencyBinCount;
    const binHz = audioCtx.sampleRate / loudnessAnalyser.fftSize;

    // Sub (20-80Hz) + Bass (80-300Hz)
    const subS = Math.max(1, Math.round(20 / binHz)), subE = Math.round(80 / binHz);
    let subSum = 0;
    for (let i = subS; i < subE; i++) subSum += loudnessFreqData[i];
    const subRaw = subSum / ((subE - subS) * 255);

    const bassS = subE, bassE = Math.round(300 / binHz);
    let bassSum = 0;
    for (let i = bassS; i < bassE; i++) bassSum += loudnessFreqData[i];
    const bassRaw = bassSum / ((bassE - bassS) * 255);

    // Bass bonus: 0-1, rewards sections with actual heavy low-end
    // *1.2 instead of *3 so voice/melody doesn't saturate it
    const bassBonus = Math.min(1, (subRaw * 0.6 + bassRaw * 0.4) * 1.2);

    // Kick activity: smoothed envelope that stays high while kicks keep hitting
    const kickImpact = Math.min(1, kickActivity);

    // Feed hammerSmooth for other uses
    hammerSmooth += (wfLevel - hammerSmooth) * 0.12;

    // --- FINAL SCORE: ADDITIVE (stable, no geometric mean crash) ---
    // wfLevel is the backbone (0-1, pre-computed, stable).
    // Bass and kick are BONUSES that push the score higher.
    // This way, between kicks the score doesn't tank — it just loses a small bonus.
    const baseScore = wfLevel;                          // 0-1, stable
    const bassAdd = bassBonus * 0.20;                   // up to +0.20
    const kickAdd = kickImpact * 0.20;                  // up to +0.20
    const rawScore = Math.min(1, baseScore + bassAdd + kickAdd);

    // Gentle S-curve: push mids up, keep extremes intact
    const shaped = rawScore * rawScore * (3 - 2 * rawScore) * 100; // smoothstep 0-100

    // Debug: aggregate stats over ~2s then log summary
    if (typeof window._hDbg === 'undefined') {
      window._hDbg = { n: 0, sum: 0, min: 999, max: 0, wfSum: 0, bassSum: 0, kickSum: 0 };
    }
    const _d = window._hDbg;
    _d.n++; _d.sum += shaped; _d.wfSum += wfLevel; _d.bassSum += bassBonus; _d.kickSum += kickImpact;
    _d.min = Math.min(_d.min, shaped); _d.max = Math.max(_d.max, shaped);
    if (_d.n >= 120) { // ~2s at 60fps
      console.log(`[SCORE 2s] avg=${(_d.sum/_d.n).toFixed(1)}% min=${_d.min.toFixed(1)}% max=${_d.max.toFixed(1)}% | wf=${(_d.wfSum/_d.n).toFixed(2)} bass=${(_d.bassSum/_d.n).toFixed(2)} kick=${(_d.kickSum/_d.n).toFixed(2)}`);
      window._hDbg = { n: 0, sum: 0, min: 999, max: 0, wfSum: 0, bassSum: 0, kickSum: 0 };
    }

    // Charge dynamics: fast but filtered rise, very slow release
    const diff = shaped - hammerCharge;
    if (diff > 0) {
      // Fast rise (0.35) — responds quickly to sustained energy
      // but filters out single-frame spikes that would push to 100%
      hammerCharge += diff * 0.35;
    } else {
      // Slow decay: score holds near its peak for several seconds
      hammerCharge += diff * 0.006;
    }
    hammerCharge = Math.max(0, Math.min(100, hammerCharge));
  }

  // Smooth displayed percentage — fast rise, very slow fall
  const targetPct = hammerCharge;
  const pctDiff = targetPct - displayedHammerPct;
  if (pctDiff > 0) {
    // Fast rise — big jumps are near-instant, small ones smooth
    displayedHammerPct += pctDiff * (pctDiff > 15 ? 0.6 : 0.3);
  } else {
    // Very slow descent
    displayedHammerPct += pctDiff * 0.015;
  }
  const hammerPct = Math.round(displayedHammerPct);
  updateHammerVisuals(hammerPct, kickDecay);



  // Mini waveform progress
  miniProgress.style.width = ((currentTime / duration) * 100) + '%';
}

// Interpolate waveform value at fractional index for smoothness
function sampleWaveform(fIdx) {
  const i0 = Math.floor(fIdx);
  const i1 = Math.min(i0 + 1, waveformData.length - 1);
  const t = fIdx - i0;
  return (waveformData[i0] || 0) * (1 - t) + (waveformData[i1] || 0) * t;
}

function sampleSigned(fIdx) {
  const i0 = Math.floor(fIdx);
  const i1 = Math.min(i0 + 1, waveformSigned.length - 1);
  const t = fIdx - i0;
  return (waveformSigned[i0] || 0) * (1 - t) + (waveformSigned[i1] || 0) * t;
}

function drawWaveformBars(ctx, w, h, timeStart, windowSec, playheadX, centerY, duration, kick, glowOnly) {
  // === NEON ENVELOPE WAVEFORM — stable mirrored amplitude silhouette ===
  const step = 2;
  const numPts = Math.ceil(w / step) + 1;
  const maxAmp = h * 0.44;
  const minH = 1.5;

  // Build amplitude envelope — peak envelope (always positive, no oscillation)
  const raw = [];
  for (let i = 0; i < numPts; i++) {
    const x = i * step;
    const tSec = timeStart + (x / w) * windowSec;
    const pNorm = tSec / duration;
    let val = 0;
    if (pNorm >= 0 && pNorm <= 1) {
      const fIdx = pNorm * (waveformData.length - 1);
      // Blend peak envelope (sharp transients) with RMS (body)
      const peak = sampleSigned(fIdx); // already absolute envelope
      const rms = sampleWaveform(fIdx);
      val = peak * 0.65 + rms * 0.35;
    }
    raw.push({ x, val: Math.max(minH, val * maxAmp) });
  }

  // Light smooth — 3-wide kernel, preserves kick spikes
  const pts = [];
  for (let i = 0; i < raw.length; i++) {
    const prev = raw[Math.max(0, i - 1)].val;
    const next = raw[Math.min(raw.length - 1, i + 1)].val;
    pts.push({ x: raw[i].x, val: prev * 0.2 + raw[i].val * 0.6 + next * 0.2 });
  }

  // Find playhead split index
  let splitIdx = 0;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].x >= playheadX) { splitIdx = i; break; }
    if (i === pts.length - 1) splitIdx = pts.length - 1;
  }

  // Build mirrored envelope path (top forward, bottom reverse)
  function buildEnvelope(start, end) {
    if (end <= start) return;
    ctx.beginPath();
    // Top edge (forward)
    ctx.moveTo(pts[start].x, centerY - pts[start].val);
    for (let i = start; i < end; i++) {
      const p0 = pts[i], p1 = pts[Math.min(i + 1, end)];
      const cpx = (p0.x + p1.x) / 2;
      ctx.quadraticCurveTo(p0.x, centerY - p0.val, cpx, centerY - (p0.val + p1.val) / 2);
    }
    ctx.lineTo(pts[end].x, centerY - pts[end].val);
    // Bottom edge (reverse)
    ctx.lineTo(pts[end].x, centerY + pts[end].val);
    for (let i = end; i > start; i--) {
      const p0 = pts[i], p1 = pts[Math.max(i - 1, start)];
      const cpx = (p0.x + p1.x) / 2;
      ctx.quadraticCurveTo(p0.x, centerY + p0.val, cpx, centerY + (p0.val + p1.val) / 2);
    }
    ctx.closePath();
  }

  // Draw a neon-glowing envelope section
  function drawNeonEnvelope(start, end, colors, kickScale) {
    const k = kickScale ? kick : 0;

    // Layer 1: wide blurred outer glow (stroke the outline)
    ctx.save();
    ctx.filter = `blur(${10 + k * 12}px)`;
    ctx.globalAlpha = 0.4 + k * 0.35;
    buildEnvelope(start, end);
    ctx.strokeStyle = colors.outer;
    ctx.lineWidth = 6 + k * 5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();

    // Layer 2: mid glow
    ctx.save();
    ctx.filter = `blur(${4 + k * 5}px)`;
    ctx.globalAlpha = 0.5 + k * 0.25;
    buildEnvelope(start, end);
    ctx.strokeStyle = colors.mid;
    ctx.lineWidth = 4 + k * 3;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();

    // Layer 3: filled interior (semi-transparent)
    buildEnvelope(start, end);
    ctx.fillStyle = colors.fill;
    ctx.fill();

    // Layer 4: sharp bright outline
    buildEnvelope(start, end);
    ctx.strokeStyle = colors.core;
    ctx.lineWidth = 2 + k * 0.8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Layer 5: hot white edge highlight (top edge only)
    ctx.save();
    ctx.globalAlpha = 0.5 + k * 0.2;
    ctx.beginPath();
    ctx.moveTo(pts[start].x, centerY - pts[start].val);
    for (let i = start; i < end; i++) {
      const p0 = pts[i], p1 = pts[Math.min(i + 1, end)];
      const cpx = (p0.x + p1.x) / 2;
      ctx.quadraticCurveTo(p0.x, centerY - p0.val, cpx, centerY - (p0.val + p1.val) / 2);
    }
    ctx.lineTo(pts[end].x, centerY - pts[end].val);
    ctx.strokeStyle = colors.hot;
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  const redColors = {
    outer: 'rgba(255,40,10,0.9)',
    mid:   'rgba(255,70,30,0.9)',
    fill:  'rgba(220,30,10,0.25)',
    core:  'rgba(255,140,100,1)',
    hot:   'rgba(255,220,200,0.8)'
  };
  const blueColors = {
    outer: 'rgba(30,140,255,0.7)',
    mid:   'rgba(60,170,255,0.8)',
    fill:  'rgba(40,120,220,0.12)',
    core:  'rgba(130,210,255,0.9)',
    hot:   'rgba(210,240,255,0.6)'
  };

  // Glow-only pass (bass bloom)
  if (glowOnly) {
    if (splitIdx > 0) {
      buildEnvelope(0, splitIdx);
      ctx.fillStyle = 'rgba(255,50,20,1)';
      ctx.fill();
    }
    return;
  }

  // Played side — red neon
  if (splitIdx > 0) drawNeonEnvelope(0, splitIdx, redColors, true);

  // Unplayed side — blue neon
  if (splitIdx < pts.length - 1) drawNeonEnvelope(splitIdx, pts.length - 1, blueColors, false);
}

// ===== ANIMATION LOOP =====
function animationLoop() {
  let currentTime = 0;
  let duration = 30;

  if (ytIsCurrentSource && ytPlayer && ytReady) {
    duration = ytDuration || 180;
    if (isPlaying) {
      currentTime = ytPlayer.getCurrentTime() || 0;
    } else {
      currentTime = (ytPlayer.getCurrentTime && ytPlayer.getCurrentTime()) || 0;
    }
  } else if (isPlaying && audioBuffer) {
    currentTime = audioCtx.currentTime - startTime + pauseOffset;
    duration = audioBuffer.duration;
    if (currentTime >= duration) {
      stopAudio();
      currentTime = 0;
      pauseOffset = 0;
      // Auto-advance to next track
      if (playlist.length > 1) {
        const next = currentTrackIndex + 1;
        if (next < playlist.length) {
          loadTrack(next);
        } else {
          // Queue finished — reload fresh queue
          fetchAndLoadQueue(currentSource);
        }
      }
    }
  } else if (audioBuffer) {
    currentTime = pauseOffset;
    duration = audioBuffer.duration;
  } else {
    currentTime = (Date.now() / 1000) % 30;
  }

  drawWaveform(currentTime);

  currentTimeEl.textContent = formatTime(currentTime);
  totalTimeEl.textContent = formatTime(duration);
  requestAnimationFrame(animationLoop);
}

function formatTime(seconds) {
  return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
}

// ===== BPM DETECTION =====
function detectBPM(buffer) {
  const offCtx = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
  const src = offCtx.createBufferSource();
  src.buffer = buffer;
  const lp = offCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 150;
  src.connect(lp);
  lp.connect(offCtx.destination);
  src.start(0);
  return offCtx.startRendering().then(rendered => {
    const data = rendered.getChannelData(0);
    const sr = rendered.sampleRate;
    const winSize = Math.floor(sr * 0.05);
    const numWins = Math.floor(data.length / winSize);
    const energy = new Float32Array(numWins);
    for (let i = 0; i < numWins; i++) {
      let sum = 0;
      const off = i * winSize;
      for (let j = 0; j < winSize; j++) sum += data[off + j] * data[off + j];
      energy[i] = sum / winSize;
    }
    const peaks = [];
    const threshold = 1.4;
    for (let i = 1; i < energy.length - 1; i++) {
      const avg = (energy[i - 1] + energy[i] + energy[i + 1]) / 3;
      if (energy[i] > avg * threshold && energy[i] > energy[i - 1] && energy[i] > energy[i + 1]) {
        peaks.push(i * winSize / sr);
      }
    }
    if (peaks.length < 2) return 120;
    const intervals = [];
    for (let i = 1; i < peaks.length; i++) {
      const diff = peaks[i] - peaks[i - 1];
      if (diff > 0.25 && diff < 2.0) intervals.push(diff);
    }
    if (!intervals.length) return 120;
    const bpmCounts = {};
    for (const iv of intervals) {
      const bpm = Math.round(60 / iv);
      const rounded = Math.round(bpm / 2) * 2;
      bpmCounts[rounded] = (bpmCounts[rounded] || 0) + 1;
    }
    let bestBPM = 120, bestCount = 0;
    for (const [bpm, count] of Object.entries(bpmCounts)) {
      if (count > bestCount) { bestCount = count; bestBPM = +bpm; }
    }
    if (bestBPM > 180) bestBPM /= 2;
    if (bestBPM < 70) bestBPM *= 2;
    return Math.round(bestBPM);
  });
}

// ===== HAMMER VISUALS =====
function updateHammerVisuals(pct, kick) {
  // Skip all hammer visuals if power is disabled for current source
  if (!isPowerEnabled()) return;
  const hPctEl = document.getElementById('hammerPct');
  if (!hPctEl) return;

  hPctEl.textContent = pct + '%';

  // Update circular gauge
  const offset = GAUGE_CIRCUMFERENCE * (1 - pct / 100);
  if (gaugeFill) gaugeFill.style.strokeDashoffset = offset;
  if (gaugeGlow) gaugeGlow.style.strokeDashoffset = offset;

  // Scale hammer wrapper with percentage
  const hammerIconWrap = document.getElementById('hammerIconWrap');
  const pwr = pct / 100;
  if (hammerIconWrap) {
    const baseSize = 42;
    const maxExtra = 14;
    const size = baseSize + pwr * maxExtra;
    hammerIconWrap.style.width = size + 'px';
    hammerIconWrap.style.height = size + 'px';
  }

  // Hammer animation is handled by startBeatSync — nothing to do here for the icon itself

  // Determine stage — follows current percentage dynamically
  const stageOrder = ['chill', 'cool', 'chaud', 'enfeu', 'lourd', 'overload'];
  let newStage = 'chill';
  if (pct >= 100) { newStage = 'overload'; }
  else if (pct >= 80) { newStage = 'lourd'; }
  else if (pct >= 60) { newStage = 'enfeu'; }
  else if (pct >= 40) { newStage = 'chaud'; }
  else if (pct >= 15) { newStage = 'cool'; }

  // Cooldown: if below 75% for 5 continuous seconds, reset peak so animations can retrigger
  const now = performance.now();
  if (pct < 75) {
    if (hammerCooldownStart === 0) hammerCooldownStart = now;
    else if (now - hammerCooldownStart >= 5000) {
      // Reset peak to current stage — allows re-entering higher stages to retrigger
      hammerPeakStage = newStage;
      hammerCooldownStart = 0;
    }
  } else {
    hammerCooldownStart = 0; // above 75%, cancel cooldown timer
  }

  // Track peak for triggering one-shot activation effects (shockwave, etc.)
  const peakIdx = stageOrder.indexOf(hammerPeakStage);
  const newIdx = stageOrder.indexOf(newStage);
  if (newIdx > peakIdx) {
    hammerPeakStage = newStage;
    triggerHammerActivation(newStage);
  }

  // Visual stage follows current percentage (not locked)
  if (newStage !== currentHammerStage) {
    const wasOverload = currentHammerStage === 'overload';
    currentHammerStage = newStage;
    if (hammerCard) hammerCard.setAttribute('data-stage', newStage);
    const labels = { chill: 'CHILL', cool: 'COOL', chaud: 'CHAUD', enfeu: 'EN FEU', lourd: 'TRÈS LOURD', overload: 'OVERLOAD' };
    if (hammerStageEl) hammerStageEl.textContent = labels[newStage];

    // Add/remove overload shake on panels
    const wp = document.querySelector('.waveform-panel');
    const cc = document.querySelector('.chat-card');
    const uc = document.querySelector('.user-card');
    if (newStage === 'overload') {
      if (wp) wp.classList.add('overload-shake');
      if (cc) cc.classList.add('overload-shake');
      if (uc) uc.classList.add('overload-shake');
    } else if (wasOverload) {
      if (wp) { wp.classList.remove('overload-shake'); wp.classList.remove('overload-border'); }
      if (cc) cc.classList.remove('overload-shake');
      if (uc) uc.classList.remove('overload-shake');
    }
  }
}

function triggerHammerActivation(stage) {
  // Shockwave — primary ring
  if (hammerShockwave) {
    hammerShockwave.classList.remove('active');
    void hammerShockwave.offsetWidth;
    hammerShockwave.classList.add('active');
    setTimeout(() => hammerShockwave.classList.remove('active'), 700);

    // Secondary ripple (delayed)
    const parent = hammerShockwave.parentElement;
    if (parent) {
      const ring2 = document.createElement('div');
      ring2.className = 'hammer-shockwave-2';
      parent.appendChild(ring2);
      setTimeout(() => {
        ring2.classList.add('active');
        setTimeout(() => ring2.remove(), 850);
      }, 80);
    }
  }

  // Hammer slam
  if (hammerIconEl) {
    hammerIconEl.classList.remove('slam');
    void hammerIconEl.offsetWidth;
    hammerIconEl.classList.add('slam');
    setTimeout(() => hammerIconEl.classList.remove('slam'), 200);
  }

  // Screen shake on enfeu/lourd/overload
  if (stage === 'enfeu' || stage === 'lourd' || stage === 'overload') {
    const wrapper = document.getElementById('wrapper');
    if (wrapper) {
      wrapper.classList.add('shaking');
      setTimeout(() => wrapper.classList.remove('shaking'), stage === 'overload' ? 800 : 400);
    }
  }

  // Flash on lourd
  if (stage === 'lourd') {
    const flash = document.createElement('div');
    flash.className = 'fire-flash';
    const inner = document.createElement('div');
    inner.className = 'fire-flash-inner';
    inner.style.background = 'radial-gradient(ellipse at center, rgba(255, 200, 50, .4) 0%, rgba(255, 100, 0, .2) 40%, transparent 70%)';
    flash.appendChild(inner);
    document.body.appendChild(flash);
    inner.addEventListener('animationend', () => flash.remove());
  }

  // OVERLOAD — massive visual explosion
  if (stage === 'overload') {
    // 1. Chromatic aberration flash
    const chromaFlash = document.createElement('div');
    chromaFlash.className = 'overload-chroma';
    document.body.appendChild(chromaFlash);
    setTimeout(() => chromaFlash.remove(), 1200);

    // 2. White-hot flash
    const flash = document.createElement('div');
    flash.className = 'fire-flash overload-flash';
    document.body.appendChild(flash);
    flash.addEventListener('animationend', () => flash.remove());

    // 3. Waveform panel border glow
    const wp = document.querySelector('.waveform-panel');
    if (wp) {
      wp.classList.add('overload-border');
    }

    // 4. Double shockwave
    if (hammerShockwave) {
      setTimeout(() => {
        hammerShockwave.classList.remove('active');
        void hammerShockwave.offsetWidth;
        hammerShockwave.classList.add('active');
      }, 200);
    }
  }
}

function startBeatSync() {
  stopBeatSync();
  if (!isPowerEnabled()) return; // Power disabled — no beat animations
  if (!detectedBPM || !hammerIconEl) return;
  const beatSec = 60 / detectedBPM;

  // Align first beat to audio clock
  nextBeatTime = audioCtx.currentTime;

  function beatLoop() {
    if (!isPlaying) return;
    beatSchedulerId = requestAnimationFrame(beatLoop);

    const pwr = hammerCharge / 100;
    const now = performance.now();

    // === ZONE 1: TREMBLE (40-70%) — subtle nervous vibration ===
    if (pwr >= 0.40 && pwr < 0.70) {
      // Small random tremor, no BPM sync needed
      const trembleAmt = (pwr - 0.40) / 0.30; // 0→1 within zone
      const angle = (Math.random() - 0.5) * trembleAmt * 6; // ±3° max
      const scl = 1 + (Math.random() - 0.5) * trembleAmt * 0.04; // ±2%
      hammerIconEl.style.transition = 'transform 80ms ease-out';
      hammerIconEl.style.transform = `rotate(${angle}deg) scale(${scl})`;
      return;
    }

    // === ZONE 2: SWING (70-85%) — pendulum-like on BPM, moderate amplitude ===
    if (pwr >= 0.70 && pwr < 0.85) {
      const audioNow = audioCtx.currentTime;
      if (audioNow < nextBeatTime) return;
      while (nextBeatTime <= audioNow) nextBeatTime += beatSec;

      const swingAmt = (pwr - 0.70) / 0.15; // 0→1 within zone
      const angle = -8 - swingAmt * 20; // -8° to -28°
      const scl = 1 + swingAmt * 0.1;   // subtle scale
      hammerIconEl.style.transition = 'none';
      hammerIconEl.style.transform = `rotate(${angle}deg) scale(${scl})`;

      if (hammerHitTimeout) clearTimeout(hammerHitTimeout);
      hammerHitTimeout = setTimeout(() => {
        const returnMs = 200 + (1 - swingAmt) * 200; // 200-400ms gentle return
        hammerIconEl.style.transition = `transform ${returnMs}ms cubic-bezier(.25,.8,.5,1)`;
        hammerIconEl.style.transform = 'rotate(0deg) scale(1)';
      }, 30);
      return;
    }

    // === ZONE 3: FULL SLAM (85%+) — heavy, powerful BPM-synced hits ===
    if (pwr >= 0.85) {
      const audioNow = audioCtx.currentTime;
      if (audioNow < nextBeatTime) return;
      while (nextBeatTime <= audioNow) nextBeatTime += beatSec;

      const slamAmt = Math.min(1, (pwr - 0.85) / 0.15); // 0→1 within zone
      const angle = -25 - slamAmt * 45;  // -25° to -70° — massive arc
      const scl = 1 + slamAmt * 0.35;    // 1x to 1.35x
      hammerIconEl.style.transition = 'none';
      hammerIconEl.style.transform = `rotate(${angle}deg) scale(${scl})`;

      if (hammerHitTimeout) clearTimeout(hammerHitTimeout);
      hammerHitTimeout = setTimeout(() => {
        // Heavy return — slower, weighty feel with overshoot
        const returnMs = 120 + (1 - slamAmt) * 100; // 120-220ms
        hammerIconEl.style.transition = `transform ${returnMs}ms cubic-bezier(.15,1.6,.4,1)`;
        hammerIconEl.style.transform = 'rotate(2deg) scale(1)'; // slight overshoot past center
        // Settle to rest
        setTimeout(() => {
          hammerIconEl.style.transition = 'transform 150ms ease-out';
          hammerIconEl.style.transform = 'rotate(0deg) scale(1)';
        }, returnMs);
      }, 25); // slightly longer hold at impact for "weight"
      return;
    }

    // Below 40%: idle — no animation
    if (pwr < 0.40 && hammerIconEl) {
      hammerIconEl.style.transition = 'transform .3s ease-out';
      hammerIconEl.style.transform = 'rotate(0deg) scale(1)';
    }
  }

  beatLoop();
}

function stopBeatSync() {
  if (beatSchedulerId) { cancelAnimationFrame(beatSchedulerId); beatSchedulerId = null; }
  if (beatIntervalId) { clearInterval(beatIntervalId); beatIntervalId = null; }
  nextBeatTime = 0;
  if (hammerIconEl) {
    hammerIconEl.style.transition = 'transform .15s ease-out';
    hammerIconEl.style.transform = 'rotate(0deg) scale(1)';
  }
  // Reset hammer charge and stage (but NOT criteriaMax if prescan ran — keeps seek stable)
  hammerCharge = 0;
  displayedHammerPct = 0;
  hammerPeakStage = 'cool';
  currentHammerStage = 'cool';
  hammerCooldownStart = 0;
  hammerKickSmooth = 0;
  if (!prescanDone) {
    criteriaMax = { sub: 0.001, bass: 0.001, kick: 0.001, fullness: 0.001, loudness: 0.001, lowHighRatio: 0.001 };
  }
  criteriaSmooth = { sub: 0, bass: 0, kick: 0, fullness: 0, loudness: 0, lowHighRatio: 0 };
  if (hammerCard) hammerCard.setAttribute('data-stage', 'cold');
  if (hammerStageEl) hammerStageEl.textContent = '';
  if (gaugeFill) gaugeFill.style.strokeDashoffset = GAUGE_CIRCUMFERENCE;
  if (gaugeGlow) gaugeGlow.style.strokeDashoffset = GAUGE_CIRCUMFERENCE;
  const hammerIconWrap = document.getElementById('hammerIconWrap');
  if (hammerIconWrap) { hammerIconWrap.style.width = '42px'; hammerIconWrap.style.height = '42px'; }

  // Clean up overload visual effects
  const wp = document.querySelector('.waveform-panel');
  const cc = document.querySelector('.chat-card');
  const uc = document.querySelector('.user-card');
  if (wp) { wp.classList.remove('overload-shake', 'overload-border'); }
  if (cc) cc.classList.remove('overload-shake');
  if (uc) uc.classList.remove('overload-shake');
  document.querySelectorAll('.overload-chroma').forEach(el => el.remove());
}

// ===== PLAYBACK CONTROLS =====
function playAudio() {
  if (ytIsCurrentSource) {
    if (ytPlayer && ytReady) {
      ytPlayer.playVideo();
      isPlaying = true;
      playImg.style.display = 'none'; pauseImg.style.display = 'block';
      startBeatSync();
    }
    return;
  }
  if (!audioBuffer) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(gainNode);
  sourceNode.connect(kickFilter);
  sourceNode.start(0, pauseOffset);
  startTime = audioCtx.currentTime;
  isPlaying = true;
  playImg.style.display = 'none'; pauseImg.style.display = 'block';
  startBeatSync();
}

function pauseAudio() {
  if (ytIsCurrentSource) {
    if (ytPlayer && ytReady) ytPlayer.pauseVideo();
    isPlaying = false;
    stopBeatSync();
    playImg.style.display = 'block'; pauseImg.style.display = 'none';
    return;
  }
  if (sourceNode) {
    sourceNode.stop();
    sourceNode.disconnect();
  }
  pauseOffset += audioCtx.currentTime - startTime;
  isPlaying = false;
  stopBeatSync();
  playImg.style.display = 'block'; pauseImg.style.display = 'none';
}

function stopAudio() {
  if (ytIsCurrentSource) {
    if (ytPlayer && ytReady) { ytPlayer.stopVideo(); }
    ytIsCurrentSource = false;
    ytDuration = 0;
  }
  if (sourceNode) {
    try { sourceNode.stop(); } catch (e) { /* already stopped */ }
    sourceNode.disconnect();
    sourceNode = null;
  }
  isPlaying = false;
  stopBeatSync();
  pauseOffset = 0;
  playImg.style.display = 'block'; pauseImg.style.display = 'none';
}

// ===== EVENT LISTENERS =====
playBtn.addEventListener('click', () => {
  if (ytIsCurrentSource) {
    isPlaying ? pauseAudio() : playAudio();
    return;
  }
  isPlaying ? pauseAudio() : (audioBuffer && playAudio());
});

// Mini nav seek
document.getElementById('miniNav').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  if (ytIsCurrentSource && ytPlayer && ytReady) {
    ytPlayer.seekTo(pct * ytDuration, true);
    return;
  }
  if (!audioBuffer) return;
  const wasPlaying = isPlaying;
  if (isPlaying) {
    sourceNode.stop();
    sourceNode.disconnect();
  }
  pauseOffset = pct * audioBuffer.duration;
  if (wasPlaying) playAudio();
});

// Keyboard: space to play/pause
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    if (ytIsCurrentSource) {
      isPlaying ? pauseAudio() : playAudio();
    } else {
      isPlaying ? pauseAudio() : (audioBuffer && playAudio());
    }
  }
});

// ===== PLAYLIST / TRACK LOADING =====
function updateTransportButtons() {
  document.getElementById('prevBtn').disabled = playlist.length === 0;
  document.getElementById('nextBtn').disabled = playlist.length === 0;
}
updateTransportButtons();

async function loadTrack(index, autoPlay) {
  if (index < 0 || index >= playlist.length) return;
  currentTrackIndex = index;
  loadingOverlay.classList.add('visible');
  prescanDone = false; // reset before loading new track
  stopAudio();

  // Mark track as playing + reset votes for Twitch re-voting
  votes = { fire: 0, up: 0, down: 0 };
  updateVoteDisplay();
  const qItem = playlist[index] && playlist[index].queueItem;
  if (qItem && qItem.id) {
    // Mark as playing (enables Twitch votes for this track)
    fetch(`/api/player/now-playing/${qItem.id}`, { method: 'POST' }).catch(() => {});
  }

  const track = playlist[index];

  // YouTube track: try to fetch real audio from Piped (client-side), fall back to IFrame
  if (track.youtubeId) {
    ytIsCurrentSource = false; // will be set true only if we need IFrame fallback
    audioBuffer = null;
    waveformData = [];
    waveformSigned = [];

    // Update track info immediately
    updateTrackInfo(track.queueItem);
    updateQueueCounter();

    // Fetch real audio via our server proxy (server fetches from Piped/Invidious, no CORS)
    let realAudioBuffer = null;
    try {
      console.log(`Fetching YouTube audio via server proxy for ${track.youtubeId}`);
      const audioRes = await fetch(`/api/yt-audio/${track.youtubeId}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (audioRes.ok) {
        const arrayBuffer = await audioRes.arrayBuffer();
        if (arrayBuffer.byteLength > 1000) {
          realAudioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
          console.log(`YouTube audio decoded: ${realAudioBuffer.duration.toFixed(1)}s`);
        }
      } else {
        console.warn(`Server proxy returned ${audioRes.status}`);
      }
    } catch (e) {
      console.warn('YouTube audio proxy error:', e.message);
    }

    if (realAudioBuffer) {
      // SUCCESS: Real audio — treat exactly like an upload
      audioBuffer = realAudioBuffer;
      extractWaveformData(audioBuffer);
      prescanTrackCriteria(audioBuffer);
      detectedBPM = await detectBPM(audioBuffer);
      console.log('YouTube real BPM:', detectedBPM);
      resizeCanvases();
      drawMiniWaveform();
      pauseOffset = 0;
      if (autoPlay) playAudio();
      loadingOverlay.classList.remove('visible');
      return;
    }

    // FALLBACK: Piped failed — use YouTube IFrame + synthetic waveform
    console.log('Piped unavailable, falling back to YouTube IFrame');
    ytIsCurrentSource = true;
    applyPlayerSettings(); // Refresh power block visibility for YouTube source
    if (ytPlayer && ytReady) {
      await new Promise((resolve) => {
        const onStateChange = (e) => {
          if (e.data === YT.PlayerState.CUED || e.data === YT.PlayerState.PLAYING) {
            ytPlayer.removeEventListener('onStateChange', onStateChange);
            resolve();
          }
        };
        ytPlayer.addEventListener('onStateChange', onStateChange);
        ytPlayer.cueVideoById(track.youtubeId);
        setTimeout(resolve, 3000);
      });

      ytDuration = ytPlayer.getDuration();
      if (ytDuration <= 0) ytDuration = 180;

      generateSyntheticWaveform(ytDuration, track.youtubeId);
      resizeCanvases();
      drawMiniWaveform();
      pauseOffset = 0;
      detectedBPM = 120;
      if (autoPlay) {
        ytPlayer.playVideo();
        isPlaying = true;
        playImg.style.display = 'none'; pauseImg.style.display = 'block';
        startBeatSync();
      }
    }
    loadingOverlay.classList.remove('visible');
    return;
  }

  // Regular audio track
  ytIsCurrentSource = false;
  applyPlayerSettings(); // Refresh power block visibility for upload source
  try {
    const bufferCopy = track.arrayBuffer.slice(0);
    audioBuffer = await audioCtx.decodeAudioData(bufferCopy);
    extractWaveformData(audioBuffer);
    prescanTrackCriteria(audioBuffer);
    detectedBPM = await detectBPM(audioBuffer);
    console.log('Detected BPM:', detectedBPM);
    resizeCanvases();
    drawMiniWaveform();
    pauseOffset = 0;
    if (autoPlay) playAudio();
  } catch (err) {
    console.error('Audio decode error:', err, 'Track:', track?.name);
    if (playlist.length > 1 && index + 1 < playlist.length) {
      loadingOverlay.classList.remove('visible');
      const next = index + 1;
      currentTrackIndex = next;
      const bufferCopy2 = playlist[next].arrayBuffer.slice(0);
      try {
        audioBuffer = await audioCtx.decodeAudioData(bufferCopy2);
        extractWaveformData(audioBuffer);
        prescanTrackCriteria(audioBuffer);
        detectedBPM = await detectBPM(audioBuffer);
        resizeCanvases();
        drawMiniWaveform();
        pauseOffset = 0;
        if (autoPlay) playAudio();
      } catch (e2) {
        console.error('Next track also failed:', e2);
      }
    }
  } finally {
    loadingOverlay.classList.remove('visible');
  }
}

// Generate synthetic waveform for YouTube tracks (no raw audio available)
function generateSyntheticWaveform(duration, videoId) {
  const sampleRate = 30;
  const totalSamples = Math.floor(duration * sampleRate);
  waveformData = [];
  waveformSigned = [];

  // Deterministic seed from videoId — same video always gets same waveform
  let seed = 12345;
  if (videoId) {
    for (let i = 0; i < videoId.length; i++) {
      seed = ((seed << 5) - seed + videoId.charCodeAt(i)) | 0;
    }
  }
  seed = Math.abs(seed) || 1;
  function rand() {
    seed = (seed * 16807 + 12345) % 2147483647;
    return (seed & 0x7fffffff) / 2147483647;
  }

  // Generate section structure from seed (each song has unique structure)
  const secLen = 12 + rand() * 20; // 12-32s per section
  const numSections = Math.max(3, Math.floor(duration / secLen));

  // Musical energy templates
  const templates = [
    [0.25, 0.45, 0.85, 0.35, 0.50, 0.90, 0.30, 0.85], // EDM: intro→build→drop→break→build→drop→outro→drop
    [0.30, 0.55, 0.70, 0.45, 0.75, 0.55, 0.80, 0.40], // Pop: verse→prechorus→chorus→verse→chorus→bridge→chorus→outro
    [0.35, 0.60, 0.80, 0.40, 0.65, 0.85, 0.35, 0.75], // Rock: intro→verse→chorus→break→verse→chorus→bridge→chorus
    [0.20, 0.40, 0.65, 0.30, 0.50, 0.70, 0.80, 0.25], // Hip-hop: intro→verse→hook→break→verse→hook→drop→outro
  ];
  const template = templates[Math.floor(rand() * templates.length)];

  const sectionEnergies = [];
  for (let s = 0; s < numSections; s++) {
    const tIdx = s % template.length;
    const base = template[tIdx];
    // Add seed-based variation per section
    sectionEnergies.push(Math.max(0.15, Math.min(0.95, base + (rand() - 0.5) * 0.15)));
  }

  // Derive BPM-like pulse from seed (100-160 BPM range)
  const fakeBPM = 100 + rand() * 60;
  const beatSamples = (60 / fakeBPM) * sampleRate; // samples per beat

  // Energy variation curve (low-frequency modulation unique to this track)
  const modFreq1 = 0.003 + rand() * 0.008;
  const modFreq2 = 0.01 + rand() * 0.02;
  const modPhase1 = rand() * Math.PI * 2;
  const modPhase2 = rand() * Math.PI * 2;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / totalSamples;

    // Section interpolation (smooth crossfade between sections)
    const rawIdx = t * numSections;
    const sIdx = Math.min(numSections - 1, Math.floor(rawIdx));
    const nIdx = Math.min(numSections - 1, sIdx + 1);
    const blend = rawIdx - sIdx;
    const smooth = blend * blend * (3 - 2 * blend); // smoothstep
    const sectionLevel = sectionEnergies[sIdx] * (1 - smooth) + sectionEnergies[nIdx] * smooth;

    // Beat-aligned energy pulses (simulates real kick/snare pattern)
    const beatPos = (i % beatSamples) / beatSamples;
    const kick = Math.exp(-beatPos * 8) * 0.20 * sectionLevel; // kick on downbeat
    const halfBeat = ((i + beatSamples / 2) % beatSamples) / beatSamples;
    const snare = Math.exp(-halfBeat * 6) * 0.10 * sectionLevel; // snare on upbeat

    // Musical texture noise (multiple seeded layers)
    const n1 = Math.sin(i * modFreq1 * 6.28 + modPhase1) * 0.08;
    const n2 = Math.sin(i * modFreq2 * 6.28 + modPhase2) * 0.05;
    const n3 = (rand() - 0.5) * 0.08 * sectionLevel; // micro-variation

    // Occasional accent hits (every 4-8 beats, randomized)
    const accentPeriod = beatSamples * (4 + Math.floor(rand() * 2) * 2);
    const accentPos = (i % accentPeriod) / accentPeriod;
    const accent = accentPos < 0.02 ? 0.15 * sectionLevel : 0;

    const val = Math.max(0.04, Math.min(1, sectionLevel + kick + snare + n1 + n2 + n3 + accent));
    waveformData.push(val);
    waveformSigned.push(val);
  }

  // Normalize to 0-1
  const maxVal = Math.max(...waveformData);
  if (maxVal > 0) {
    for (let i = 0; i < waveformData.length; i++) {
      waveformData[i] /= maxVal;
      waveformSigned[i] /= maxVal;
    }
  }
}

// File input with loading + error handling
document.getElementById('audioFileInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  for (const file of files) {
    const arrayBuffer = await file.arrayBuffer();
    playlist.push({ name: file.name, arrayBuffer });
  }

  updateTransportButtons();
  // Load the first of the newly added files
  await loadTrack(playlist.length - files.length);
});

document.getElementById('prevBtn').addEventListener('click', () => {
  if (playlist.length === 0) return;
  if (playlist.length === 1) { loadTrack(0); return; }
  const prev = (currentTrackIndex - 1 + playlist.length) % playlist.length;
  loadTrack(prev);
});

document.getElementById('nextBtn').addEventListener('click', () => {
  if (playlist.length === 0) return;
  if (playlist.length === 1) { loadTrack(0); return; }
  const next = (currentTrackIndex + 1) % playlist.length;
  loadTrack(next);
});

// ===== VOTES =====
let votes = { fire: 0, up: 0, down: 0 };

function updateVoteDisplay() {
  const total = votes.fire + votes.up + votes.down;
  const pctFire = total > 0 ? (votes.fire / total) * 100 : 0;
  const pctUp = total > 0 ? (votes.up / total) * 100 : 0;
  const pctDown = total > 0 ? (votes.down / total) * 100 : 0;

  document.getElementById('chatPct1').textContent = Math.round(pctFire) + '%';
  document.getElementById('chatPct2').textContent = Math.round(pctUp) + '%';
  document.getElementById('chatPct3').textContent = Math.round(pctDown) + '%';

  document.getElementById('chatBar1').style.width = pctFire + '%';
  document.getElementById('chatBar2').style.width = pctUp + '%';
  document.getElementById('chatBar3').style.width = pctDown + '%';

  document.getElementById('chatCount1').textContent = '(' + votes.fire + ')';
  document.getElementById('chatCount2').textContent = '(' + votes.up + ')';
  document.getElementById('chatCount3').textContent = '(' + votes.down + ')';
}

async function sendVote(type) {
  try {
    const queueId = (playlist[currentTrackIndex] && playlist[currentTrackIndex].queueItem)
      ? playlist[currentTrackIndex].queueItem.id : undefined;
    const res = await fetch('/api/votes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, queue_id: queueId })
    });
    if (res.ok) {
      votes = await res.json();
      updateVoteDisplay();
    }
  } catch (e) {
    // Fallback: update locally if server unreachable
    const amount = type === 'fire' ? 5 : 1;
    votes[type] += amount;
    updateVoteDisplay();
  }
}

// Load initial votes from server
function loadVotesForCurrentTrack() {
  const queueId = (playlist[currentTrackIndex] && playlist[currentTrackIndex].queueItem)
    ? playlist[currentTrackIndex].queueItem.id : undefined;
  const url = queueId ? `/api/votes?queue_id=${queueId}` : '/api/votes';
  fetch(url)
    .then(r => r.json())
    .then(data => { votes = { fire: data.fire || 0, up: data.up || 0, down: data.down || 0 }; updateVoteDisplay(); })
    .catch(() => updateVoteDisplay());
}
loadVotesForCurrentTrack();

// Poll Twitch/real votes every 3s
setInterval(() => {
  loadVotesForCurrentTrack();
}, 3000);

// ===== MUR DES LÉGENDES =====
let currentLegendUser = null;
async function loadLegend() {
  try {
    const res = await fetch('/api/legend');
    const data = await res.json();
    const userEl = document.getElementById('legendUser');
    const trackEl = document.getElementById('legendTrack');
    const fireEl = document.getElementById('legendFire');
    if (!userEl) return;
    if (data && data.fire > 0) {
      const newUser = data.submitted_by || 'Anonyme';
      userEl.textContent = newUser;
      trackEl.textContent = (data.title || 'Sans titre') + (data.artist ? ' \u2014 ' + data.artist : '');
      fireEl.textContent = '\uD83D\uDD25 ' + data.fire + ' FIRE';
      // Animate when legend changes
      if (currentLegendUser !== null && currentLegendUser !== newUser) {
        const card = document.getElementById('legendCard');
        card.classList.add('legend-new');
        setTimeout(() => card.classList.remove('legend-new'), 1500);
      }
      currentLegendUser = newUser;
    } else {
      userEl.textContent = 'En attente...';
      trackEl.textContent = 'Le track avec le plus de \uD83D\uDD25 appara\u00eetra ici';
      fireEl.textContent = '';
      currentLegendUser = null;
    }
  } catch (e) {
    // Silently fail
  }
}
loadLegend();
setInterval(loadLegend, 5000);

// ===== EMOJI SPLASH EFFECT =====
function showEmojiSplash(emoji, x, y) {
  const el = document.createElement('div');
  el.className = 'emoji-splash';
  el.textContent = emoji;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 700);
}

// Vote button listeners
function skipToNext() {
  if (playlist.length === 0) return;
  if (playlist.length === 1) {
    // Only one track — reload it (will re-trigger from start)
    loadTrack(0);
    return;
  }
  const next = (currentTrackIndex + 1) % playlist.length;
  loadTrack(next);
}

document.getElementById('btnDown').addEventListener('click', function () {
  // Don't send vote to server — only Twitch chat counts in "avis du chat"
  const r = this.getBoundingClientRect();
  showEmojiSplash('\uD83D\uDC4E', r.left + r.width / 2 - 30, r.top - 20);
  skipToNext();
});

document.getElementById('btnUp').addEventListener('click', function () {
  // Don't send vote to server — only Twitch chat counts in "avis du chat"
  const r = this.getBoundingClientRect();
  showEmojiSplash('\uD83D\uDC4D', r.left + r.width / 2 - 30, r.top - 20);
  skipToNext();
});

// ===== FIRE BUTTON (COMBO SYSTEM + PARTICLES + SOUND) =====
let fireTimeout = null;
let fireFadeTimeout = null;

// --- Combo state ---
let fireCombo = 0;
let fireComboTimer = null;
let fireComboDecayTimer = null;
const COMBO_WINDOW = 1200; // ms to keep combo alive
const fireComboEl = document.getElementById('fireCombo');
const fireComboNumEl = document.getElementById('fireComboNum');

// --- Canvas particle system ---
const fireParticleCanvas = document.getElementById('fireParticleCanvas');
const fpCtx = fireParticleCanvas.getContext('2d');
let fireParticles = [];
let fireParticleRAF = null;

function resizeFireCanvas() {
  fireParticleCanvas.width = window.innerWidth * devicePixelRatio;
  fireParticleCanvas.height = window.innerHeight * devicePixelRatio;
  fireParticleCanvas.style.width = window.innerWidth + 'px';
  fireParticleCanvas.style.height = window.innerHeight + 'px';
  fpCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
resizeFireCanvas();
window.addEventListener('resize', resizeFireCanvas);

function spawnFireParticles(cx, cy, count, intensity) {
  // Hard cap: 60 total particles alive (was 80)
  const maxAlive = 60;
  if (fireParticles.length >= maxAlive) return;
  count = Math.min(count, maxAlive - fireParticles.length);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (3 + Math.random() * 8) * intensity;
    const size = 2 + Math.random() * 4 * intensity;
    const life = 0.6 + Math.random() * 0.8;
    const hue = 15 + Math.random() * 30;
    const sat = 80 + Math.random() * 20;
    const lum = 50 + Math.random() * 30 + intensity * 15;
    const vx = Math.cos(angle) * speed + (Math.random() - .5) * 2;
    const vy = Math.sin(angle) * speed - Math.random() * 3;
    fireParticles.push({
      x: cx, y: cy,
      prevX: cx, prevY: cy,
      vx, vy,
      size, life, maxLife: life,
      hue, sat, lum,
      gravity: 0.15 + Math.random() * 0.1,
      friction: 0.97 + Math.random() * 0.02,
      type: Math.random() < 0.35 ? 'spark' : 'ember',
    });
  }
  if (!fireParticleRAF) tickFireParticles();
}


function tickFireParticles() {
  fpCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  for (let i = fireParticles.length - 1; i >= 0; i--) {
    const p = fireParticles[i];
    p.life -= 0.016;
    if (p.life <= 0) { fireParticles.splice(i, 1); continue; }

    p.prevX = p.x;
    p.prevY = p.y;
    p.vy += p.gravity;
    p.vx *= p.friction;
    p.vy *= p.friction;
    p.x += p.vx;
    p.y += p.vy;

    const alpha = Math.min(1, p.life / (p.maxLife * 0.3));
    const sizeNow = p.size * (0.3 + 0.7 * (p.life / p.maxLife));
    const color = `hsla(${p.hue}, ${p.sat}%, ${p.lum}%, ${alpha})`;

    if (p.type === 'spark') {
      // Spark: line trail (single stroke, no extra fill)
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const trailLen = Math.min(speed * 2.5, 16);
      const invSpeed = 1 / (speed || 1);
      fpCtx.beginPath();
      fpCtx.moveTo(p.x, p.y);
      fpCtx.lineTo(p.x - p.vx * invSpeed * trailLen, p.y - p.vy * invSpeed * trailLen);
      fpCtx.strokeStyle = color;
      fpCtx.lineWidth = sizeNow * 0.7;
      fpCtx.lineCap = 'round';
      fpCtx.stroke();
    } else {
      // Ember: single circle (no glow pass — saves 1 draw call per particle)
      fpCtx.beginPath();
      fpCtx.arc(p.x, p.y, sizeNow, 0, Math.PI * 2);
      fpCtx.fillStyle = color;
      fpCtx.fill();
    }
  }

  if (fireParticles.length > 0) {
    fireParticleRAF = requestAnimationFrame(tickFireParticles);
  } else {
    fireParticleRAF = null;
  }
}

// --- Procedural fire sound via Web Audio API ---
function playFireSound(combo) {
  const ctx = audioCtx;
  const now = ctx.currentTime;
  const intensity = Math.min(1, combo / 10);

  // Noise burst (whoosh)
  const bufSize = ctx.sampleRate * 0.15;
  const noiseBuf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const noise = noiseBuf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) {
    noise[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.3));
  }
  const noiseNode = ctx.createBufferSource();
  noiseNode.buffer = noiseBuf;

  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = 800 + intensity * 1200;
  noiseFilter.Q.value = 0.8;

  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.15 + intensity * 0.15, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

  noiseNode.connect(noiseFilter).connect(noiseGain).connect(ctx.destination);
  noiseNode.start(now);
  noiseNode.stop(now + 0.2);

  // Sub-bass thump
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(80 + intensity * 40, now);
  osc.frequency.exponentialRampToValueAtTime(30, now + 0.15);
  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.25 + intensity * 0.2, now);
  oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
  osc.connect(oscGain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.25);

  // High-combo: add rising tone
  if (combo >= 5) {
    const riseOsc = ctx.createOscillator();
    riseOsc.type = 'sawtooth';
    riseOsc.frequency.setValueAtTime(200, now);
    riseOsc.frequency.exponentialRampToValueAtTime(600 + combo * 50, now + 0.1);
    const riseGain = ctx.createGain();
    riseGain.gain.setValueAtTime(0.06, now);
    riseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    riseOsc.connect(riseGain).connect(ctx.destination);
    riseOsc.start(now);
    riseOsc.stop(now + 0.15);
  }
}

// --- Shockwave effect — reuse 2 pre-existing DOM elements ---
const fireShockwaveEl = document.getElementById('fireShockwave');
// Create one secondary ring and keep it in the DOM
const fireShockwaveRing = document.createElement('div');
fireShockwaveRing.className = 'fire-shockwave-ring';
fireShockwaveRing.style.display = 'none';
document.body.appendChild(fireShockwaveRing);

let swTimeout1 = 0, swTimeout2 = 0;

function triggerShockwave(cx, cy) {
  const x = (cx - 30) + 'px';
  const y = (cy - 30) + 'px';

  // Primary ring
  clearTimeout(swTimeout1);
  fireShockwaveEl.classList.remove('active');
  fireShockwaveEl.style.left = x;
  fireShockwaveEl.style.top = y;
  void fireShockwaveEl.offsetWidth;
  fireShockwaveEl.classList.add('active');
  swTimeout1 = setTimeout(() => fireShockwaveEl.classList.remove('active'), 600);

  // Secondary ring — reused, no DOM creation
  clearTimeout(swTimeout2);
  fireShockwaveRing.classList.remove('active');
  fireShockwaveRing.style.display = '';
  fireShockwaveRing.style.left = x;
  fireShockwaveRing.style.top = y;
  void fireShockwaveRing.offsetWidth;
  fireShockwaveRing.classList.add('active');
  swTimeout2 = setTimeout(() => {
    fireShockwaveRing.classList.remove('active');
    fireShockwaveRing.style.display = 'none';
  }, 750);
}

// --- Button squish animation ---
function squishButton(btn) {
  btn.classList.remove('fire-spring', 'fire-settle');
  btn.classList.add('fire-squish');
  setTimeout(() => {
    btn.classList.remove('fire-squish');
    btn.classList.add('fire-spring');
    setTimeout(() => {
      btn.classList.remove('fire-spring');
      btn.classList.add('fire-settle');
      setTimeout(() => btn.classList.remove('fire-settle'), 300);
    }, 150);
  }, 50);
}

// --- Combo display ---
function updateComboDisplay() {
  fireComboNumEl.textContent = fireCombo;

  // Tier classes
  fireComboEl.classList.remove('tier-2', 'tier-3');
  if (fireCombo >= 10) fireComboEl.classList.add('tier-3');
  else if (fireCombo >= 5) fireComboEl.classList.add('tier-2');

  // Show with pop (centered on screen via CSS)
  fireComboEl.classList.add('visible');
  fireComboEl.classList.add('fire-combo-pop');
  setTimeout(() => fireComboEl.classList.remove('fire-combo-pop'), 80);
}

function hideCombo() {
  fireComboEl.classList.remove('visible', 'tier-2', 'tier-3');
  fireCombo = 0;
}

// --- Screen flash (combo-aware) — reuse single DOM element ---
const flashEl = document.createElement('div');
flashEl.className = 'fire-flash';
flashEl.style.display = 'none';
const flashInner = document.createElement('div');
flashInner.className = 'fire-flash-inner';
flashEl.appendChild(flashInner);
document.body.appendChild(flashEl);
let flashTimeout = 0;

function triggerFlash(combo) {
  clearTimeout(flashTimeout);
  const intensity = Math.min(1, combo / 8);
  flashInner.style.background = `radial-gradient(ellipse at center,
    rgba(255, ${200 - intensity * 100 | 0}, ${150 - intensity * 100 | 0}, ${0.4 + intensity * 0.3}) 0%,
    rgba(255, 60, 0, ${0.2 + intensity * 0.2}) 40%,
    transparent 70%)`;
  flashEl.style.display = '';
  flashInner.style.animation = 'none';
  void flashInner.offsetWidth;
  flashInner.style.animation = '';
  flashTimeout = setTimeout(() => { flashEl.style.display = 'none'; }, 400);
}

// --- Fire overlay disabled (removed for performance) ---

// --- Main fire click handler ---
// Pre-cache all DOM references
const fireBtnEl = document.getElementById('btnFire');
const wrapperEl = document.getElementById('wrapper');
// Create halo once
const fireHaloEl = document.createElement('div');
fireHaloEl.className = 'fire-halo';
fireBtnEl.parentElement.appendChild(fireHaloEl);

let shakeTimeout = 0;
let chromaticTimeout = 0;

fireBtnEl.addEventListener('click', function () {
  // Combo tracking
  fireCombo++;
  clearTimeout(fireComboTimer);
  clearTimeout(fireComboDecayTimer);
  fireComboTimer = setTimeout(() => {
    fireComboDecayTimer = setTimeout(hideCombo, 400);
  }, COMBO_WINDOW);

  const r = this.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;

  // 1. Button squish
  squishButton(this);

  // 2. Procedural sound
  playFireSound(fireCombo);

  // 3. Shockwave (2 reused DOM elements)
  triggerShockwave(cx, cy);

  // 4. Flash (reused DOM element)
  triggerFlash(fireCombo);

  // 5. Particles (capped at 60 total, fewer per click)
  const particleCount = Math.min(25, 8 + fireCombo * 3);
  const intensity = Math.min(1.2, 0.7 + fireCombo * 0.05);
  spawnFireParticles(cx, cy, particleCount, intensity);

  // 6. Combo display
  if (fireCombo >= 2) {
    updateComboDisplay();
  }

  // 7. Screen shake — use classList (no reflow forcing)
  if (fireCombo >= 3) {
    clearTimeout(shakeTimeout);
    wrapperEl.classList.remove('shaking');
    void wrapperEl.offsetWidth;
    wrapperEl.classList.add('shaking');
    shakeTimeout = setTimeout(() => wrapperEl.classList.remove('shaking'), 600);
  }

  // 8. Fire halo — cached reference, no DOM query
  const haloScale = 1 + Math.min(fireCombo, 15) * 0.12;
  fireHaloEl.style.setProperty('--halo-scale', haloScale);
  fireHaloEl.classList.add('visible');

  // 9. Chromatic aberration on high combo
  if (fireCombo >= 7) {
    clearTimeout(chromaticTimeout);
    document.body.classList.add('chromatic-active');
    chromaticTimeout = setTimeout(() => document.body.classList.remove('chromatic-active'), 300);
  }
});

// Hide halo when combo ends
const _origHideCombo = hideCombo;
hideCombo = function() {
  _origHideCombo();
  fireHaloEl.classList.remove('visible');
};

// ===== COMMUNITY QUEUE =====
let currentSource = 'upload'; // 'upload' or 'youtube'
let serverQueue = []; // array of queue items from server
const queueCounterEl = document.getElementById('queueCounter');
const trackTitleEl = document.getElementById('trackTitle');
const trackArtistEl = document.getElementById('trackArtist');
const trackSubmitterEl = document.getElementById('trackSubmitter');

function updateQueueCounter() {
  if (serverQueue.length === 0) {
    queueCounterEl.textContent = '0/0';
  } else {
    queueCounterEl.textContent = `${currentTrackIndex + 1}/${serverQueue.length}`;
  }
}

function updateTrackInfo(item) {
  if (!item) {
    trackTitleEl.textContent = 'En attente...';
    trackArtistEl.textContent = '';
    trackSubmitterEl.textContent = '';
    return;
  }
  trackTitleEl.textContent = item.title || 'Sans titre';
  trackArtistEl.textContent = item.artist || '';
  trackSubmitterEl.textContent = item.submitted_by ? `Propos\u00e9 par ${item.submitted_by}` : '';
}

async function fetchAndLoadQueue(type) {
  currentSource = type;
  serverQueue = [];
  playlist = [];
  currentTrackIndex = -1;
  updateQueueCounter();
  updateTrackInfo(null);

  try {
    const res = await fetch(`/api/player/playlist?type=${type}`);
    if (!res.ok) throw new Error('Erreur serveur');
    serverQueue = await res.json();

    if (serverQueue.length === 0) {
      updateTrackInfo(null);
      trackTitleEl.textContent = type === 'upload' ? 'Aucun upload en attente' : 'Aucun lien YouTube en attente';
      updateTransportButtons();
      return;
    }

    // Preload all tracks in parallel for smooth transitions
    loadingOverlay.classList.add('visible');

    const fetchPromises = serverQueue.map(async (item) => {
      // YouTube tracks: extract video ID, no audio download needed
      if (item.type === 'youtube' && item.source_url) {
        const m = item.source_url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|music\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/);
        if (m) {
          return { name: item.title, youtubeId: m[1], queueItem: item };
        }
        return null;
      }

      // Regular upload tracks: fetch audio from server
      try {
        const response = await fetch(`/api/audio/${item.id}`);
        if (!response.ok) {
          console.error('HTTP error loading:', item.title, response.status);
          return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength < 1000) {
          console.error('File too small, skipping:', item.title, arrayBuffer.byteLength);
          return null;
        }
        return { name: item.title, arrayBuffer, queueItem: item };
      } catch (err) {
        console.error('Failed to load:', item.title, err);
        return null;
      }
    });

    const results = await Promise.all(fetchPromises);
    playlist = results.filter(r => r !== null);
    loadingOverlay.classList.remove('visible');

    if (playlist.length > 0) {
      updateTransportButtons();
      updateQueueCounter();
      await loadTrack(0);
    }
  } catch (err) {
    console.error('Queue fetch error:', err);
    trackTitleEl.textContent = 'Erreur de chargement';
  }
}

// Source toggle buttons
document.querySelectorAll('.source-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    stopAudio();
    fetchAndLoadQueue(btn.dataset.type);
  });
});

// Override loadTrack to update queue info
const _originalLoadTrack = loadTrack;
loadTrack = async function(index, autoPlay) {
  // Reset votes display immediately on track change
  votes = { fire: 0, up: 0, down: 0 };
  updateVoteDisplay();
  await _originalLoadTrack(index, autoPlay);
  if (serverQueue.length > 0 && playlist[index] && playlist[index].queueItem) {
    updateTrackInfo(playlist[index].queueItem);
  }
  updateQueueCounter();
  loadVotesForCurrentTrack();
};

// ===== WIPE ALL =====
document.getElementById('wipeBtn').addEventListener('click', async () => {
  const label = currentSource === 'youtube' ? 'liens YouTube' : 'uploads';
  if (!confirm(`Supprimer TOUS les ${label} ? Cette action est irréversible.`)) return;
  try {
    const res = await fetch(`/api/queue/wipe-all?type=${currentSource}`, { method: 'DELETE' });
    if (res.ok) {
      stopAudio();
      serverQueue = [];
      playlist = [];
      currentTrackIndex = -1;
      audioBuffer = null;
      waveformData = [];
      waveformSigned = [];
      updateQueueCounter();
      updateTrackInfo(null);
      trackTitleEl.textContent = 'Tous les sons ont été supprimés';
      updateTransportButtons();
      // Reset waveform to flat
      resizeCanvases();
      drawMiniWaveform();
    }
  } catch (e) {
    console.error('Wipe error:', e);
  }
});

// ===== ACTIVE SKIN =====
async function loadActiveSkin() {
  try {
    const res = await fetch('/api/active-skin');
    const skin = await res.json();
    if (!skin || !skin.id) return; // default skin
    const imgs = skin.images || {};

    // HTML images
    if (imgs.marteau) { const el = document.getElementById('hammerIcon'); if (el) el.src = imgs.marteau; }
    if (imgs.play) { const el = document.getElementById('playImg'); if (el) el.src = imgs.play; }
    if (imgs.pause) { const el = document.getElementById('pauseImg'); if (el) el.src = imgs.pause; }
    if (imgs.fire) { const el = document.querySelector('.fire-img'); if (el) el.src = imgs.fire; }
    if (imgs.pouce_rouge) { const el = document.querySelector('.vote-btn-red .vote-icon'); if (el) el.src = imgs.pouce_rouge; }
    if (imgs.pouce_vert) { const el = document.querySelector('.vote-btn-green .vote-icon'); if (el) el.src = imgs.pouce_vert; }

    // CSS background images
    const style = document.createElement('style');
    let css = '';
    if (imgs.bg) css += `.bg { background-image: url('${imgs.bg}') !important; }\n`;
    if (imgs.bloc_titre) css += `.user-card { background: url('${imgs.bloc_titre}') center / 100% 100% no-repeat !important; }\n`;
    if (imgs.bloc_chat) css += `.chat-card { background: url('${imgs.bloc_chat}') center / 100% 100% no-repeat !important; }\n`;
    if (imgs.murlegende) css += `.legend-card { background: url('${imgs.murlegende}') center / contain no-repeat !important; }\n`;
    if (css) {
      style.textContent = css;
      document.head.appendChild(style);
    }
  } catch (e) {
    // Silently use default skin
  }
}
loadActiveSkin();

// ===== INIT =====
resizeCanvases();
generateDemoData();
animationLoop();

// Auto-load community uploads on start
fetchAndLoadQueue('upload');
