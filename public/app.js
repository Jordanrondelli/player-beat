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

// ===== AUDIO CONTEXT =====
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const gainNode = audioCtx.createGain();
let audioBuffer = null;
let sourceNode = null;
let isPlaying = false;
let startTime = 0;
let pauseOffset = 0;
let playlist = []; // array of { name, arrayBuffer }
let currentTrackIndex = -1;
let waveformData = [];
let waveformSigned = []; // signed samples for neon line display

// Analyser for spectrum
const analyser = audioCtx.createAnalyser();
analyser.fftSize = 512;
analyser.smoothingTimeConstant = 0.4;
const frequencyData = new Uint8Array(analyser.frequencyBinCount);

// Low-pass filter to isolate kick drum (~20-150Hz)
const kickFilter = audioCtx.createBiquadFilter();
kickFilter.type = 'lowpass';
kickFilter.frequency.value = 150;
kickFilter.Q.value = 1;

const kickAnalyser = audioCtx.createAnalyser();
kickAnalyser.fftSize = 256;
kickAnalyser.smoothingTimeConstant = 0.2;
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
loudnessAnalyser.fftSize = 2048;
loudnessAnalyser.smoothingTimeConstant = 0.3;
const loudnessTimeData = new Uint8Array(loudnessAnalyser.fftSize);
gainNode.connect(loudnessAnalyser);

// ===== KICK DETECTION STATE =====
let prevKickLevel = 0;
let kickDecay = 0;
let density = 0;
let densitySmooth = 0;
let lastKickTime = 0;
let hammerSmooth = 0;
let loudnessSmooth = 0;
let hammerHitTimeout = null;
const hammerIconEl = document.getElementById('hammerIcon');
const hammerCard = document.getElementById('hammerMeter');
const gaugeFill = document.getElementById('gaugeFill');
const gaugeGlow = document.getElementById('gaugeGlow');
const hammerSparks = document.getElementById('hammerSparks');
const hammerShockwave = document.getElementById('hammerShockwave');
const hammerStageEl = document.getElementById('hammerStage');
let currentHammerStage = 'cold';
let hammerCharge = 0;
let hammerPeakStage = 'cold';
// Energy analysis buffers
let energyLongWindow = [];    // ~10s rolling window for baseline energy
let energyShortWindow = [];   // ~1s rolling window for current energy
let spectralRatioWindow = []; // bass-to-mid ratio history
let trackMaxEnergy = 0.01;    // max energy seen so far in this track
let trackMinEnergy = 1;       // min energy seen so far in this track
let chargeVelocity = 0;       // how fast charge is moving
let detectedBPM = 0;
let beatIntervalId = null;
const GAUGE_CIRCUMFERENCE = 326.73; // 2π × 52

// ===== MAIN WAVEFORM DRAW =====
function drawWaveform(currentTime) {
  if (!waveformData.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = waveformCanvas.width / dpr;
  const h = waveformCanvas.height / dpr;
  const duration = audioBuffer ? audioBuffer.duration : 30;
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

  // Kick detection from audio analyser
  let kickLevel = 0;
  if (isPlaying && audioBuffer) {
    analyser.getByteFrequencyData(frequencyData);
    kickAnalyser.getByteTimeDomainData(kickTimeData);
    let sum = 0;
    for (let i = 0; i < kickTimeData.length; i++) {
      const v = (kickTimeData[i] - 128) / 128;
      sum += v * v;
    }
    kickLevel = Math.sqrt(sum / kickTimeData.length);
  } else {
    kickLevel = (waveformData[Math.min(pIdx, waveformData.length - 1)] || 0) * 0.3;
  }

  const rise = kickLevel - prevKickLevel;
  const now = performance.now();
  const isKick = rise > .04 && kickLevel > .15 && (now - lastKickTime) > 120;
  prevKickLevel += (kickLevel - prevKickLevel) * .4;

  // Kick impact
  if (isKick) {
    lastKickTime = now;
    const intensity = Math.min(1, rise * 8 * Math.max(densitySmooth, .3));
    kickDecay = Math.max(kickDecay, intensity);
  }
  kickDecay *= .82; // faster decay for snappy kick response

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

  // ===== HAMMER: ENERGY CONTRAST SYSTEM =====
  // Compares current energy vs track baseline. Needs time to build up.
  // Intro = low. Build-up = medium. Drop/chorus = high.
  if (isPlaying && audioBuffer) {
    analyser.getByteFrequencyData(frequencyData);
    const binCount = analyser.frequencyBinCount; // 256

    // Bass energy (bins 0-3)
    let bassEnergy = 0;
    for (let i = 0; i < 4; i++) bassEnergy += frequencyData[i];
    bassEnergy /= 4 * 255;

    // Mid energy (bins 4-34)
    let midEnergy = 0;
    for (let i = 4; i < 35; i++) midEnergy += frequencyData[i];
    midEnergy /= 31 * 255;

    // High energy (bins 35-139)
    let highEnergy = 0;
    for (let i = 35; i < Math.min(140, binCount); i++) highEnergy += frequencyData[i];
    highEnergy /= Math.min(105, binCount - 35) * 255;

    // Combined energy
    const energy = bassEnergy * 0.5 + midEnergy * 0.3 + highEnergy * 0.2;

    // Feed hammerSmooth so beat sync still works
    hammerSmooth += (energy - hammerSmooth) * 0.08;

    // Track energy range
    trackMaxEnergy = Math.max(trackMaxEnergy, energy);
    trackMinEnergy = Math.min(trackMinEnergy, energy);

    // Build energy windows
    energyShortWindow.push(energy);
    if (energyShortWindow.length > 60) energyShortWindow.shift();   // ~1s
    energyLongWindow.push(energy);
    if (energyLongWindow.length > 600) energyLongWindow.shift();    // ~10s

    const shortAvg = energyShortWindow.reduce((a, b) => a + b, 0) / energyShortWindow.length;

    // CRITICAL: Don't compute contrast until we have enough baseline data (~4s)
    // During warmup, charge stays at 0
    if (energyLongWindow.length < 240) {
      // Warmup phase: just collecting data, charge stays low
      hammerCharge = Math.max(0, hammerCharge - 0.1);
    } else {
      // Baseline = average of the oldest half of the long window (the "past")
      const halfLen = Math.floor(energyLongWindow.length / 2);
      const baseline = energyLongWindow.slice(0, halfLen).reduce((a, b) => a + b, 0) / halfLen;

      // How much louder is NOW vs the past baseline
      const energyRange = Math.max(0.02, trackMaxEnergy - trackMinEnergy);
      const contrast = (shortAvg - baseline) / energyRange;
      // contrast: ~0 = same as baseline, ~0.5 = noticeably louder, ~1 = way louder

      // Intensity: purely contrast-driven, clamped 0-1
      // Needs significant contrast to score high — no freebies from volume alone
      const intensity = Math.max(0, Math.min(1, contrast * 1.2));

      // Move charge toward target slowly
      const target = intensity * 100;
      const diff = target - hammerCharge;

      if (diff > 0) {
        // Rising: slow ramp
        hammerCharge += diff * 0.008;
      } else {
        // Falling: very slow
        hammerCharge += diff * 0.002;
      }
      hammerCharge = Math.max(0, Math.min(100, hammerCharge));
    }
  }

  const hammerPct = Math.round(hammerCharge);
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
  if (isPlaying && audioBuffer) {
    currentTime = audioCtx.currentTime - startTime + pauseOffset;
    if (currentTime >= audioBuffer.duration) {
      stopAudio();
      currentTime = 0;
      pauseOffset = 0;
      // Auto-advance to next track
      if (playlist.length > 1) {
        const next = (currentTrackIndex + 1) % playlist.length;
        loadTrack(next);
      }
    }
  } else if (audioBuffer) {
    currentTime = pauseOffset;
  } else {
    currentTime = (Date.now() / 1000) % 30;
  }

  drawWaveform(currentTime);

  const duration = audioBuffer ? audioBuffer.duration : 30;
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
  const hPctEl = document.getElementById('hammerPct');
  if (!hPctEl) return;

  hPctEl.textContent = pct + '%';
  hPctEl.style.transform = kick > .3 ? `scale(${1 + kick * .2})` : '';

  // Update circular gauge
  const offset = GAUGE_CIRCUMFERENCE * (1 - pct / 100);
  if (gaugeFill) gaugeFill.style.strokeDashoffset = offset;
  if (gaugeGlow) gaugeGlow.style.strokeDashoffset = offset;

  // Scale hammer icon with percentage — bigger as power grows
  const hammerIconWrap = document.getElementById('hammerIconWrap');
  if (hammerIconWrap) {
    const baseSize = 54;
    const maxExtra = 36; // grows up to +36px at 100%
    const size = baseSize + (pct / 100) * maxExtra;
    hammerIconWrap.style.width = size + 'px';
    hammerIconWrap.style.height = size + 'px';
  }

  // Determine stage — LOCKED: once reached, never goes back down
  const stageOrder = ['cold', 'warm', 'hot', 'max'];
  let newStage = 'cold';
  let stageLabel = '';
  if (pct >= 90) { newStage = 'max'; stageLabel = 'MAXIMUM'; }
  else if (pct >= 66) { newStage = 'hot'; stageLabel = 'EN FEU'; }
  else if (pct >= 33) { newStage = 'warm'; stageLabel = 'CHAUD'; }

  // Lock: only go up, never down
  const peakIdx = stageOrder.indexOf(hammerPeakStage);
  const newIdx = stageOrder.indexOf(newStage);
  if (newIdx > peakIdx) {
    hammerPeakStage = newStage;
    triggerHammerActivation(newStage);
  }

  // Visual stage always follows peak (locked)
  if (hammerPeakStage !== currentHammerStage) {
    currentHammerStage = hammerPeakStage;
    if (hammerCard) hammerCard.setAttribute('data-stage', hammerPeakStage);
    const labels = { cold: '', warm: 'CHAUD', hot: 'EN FEU', max: 'MAXIMUM' };
    if (hammerStageEl) hammerStageEl.textContent = labels[hammerPeakStage];
  }
}

function triggerHammerActivation(stage) {
  // Shockwave
  if (hammerShockwave) {
    hammerShockwave.classList.remove('active');
    void hammerShockwave.offsetWidth;
    hammerShockwave.classList.add('active');
    setTimeout(() => hammerShockwave.classList.remove('active'), 700);
  }

  // Hammer slam
  if (hammerIconEl) {
    hammerIconEl.classList.remove('slam');
    void hammerIconEl.offsetWidth;
    hammerIconEl.classList.add('slam');
    setTimeout(() => hammerIconEl.classList.remove('slam'), 200);
  }

  // Screen shake on HOT/MAX
  if (stage === 'max' || stage === 'hot') {
    const wrapper = document.getElementById('wrapper');
    if (wrapper) {
      wrapper.classList.add('shaking');
      setTimeout(() => wrapper.classList.remove('shaking'), 400);
    }
  }

  // Flash on MAX
  if (stage === 'max') {
    const flash = document.createElement('div');
    flash.className = 'fire-flash';
    flash.style.background = 'radial-gradient(ellipse at center, rgba(255, 200, 50, .4) 0%, rgba(255, 100, 0, .2) 40%, transparent 70%)';
    document.body.appendChild(flash);
    flash.addEventListener('animationend', () => flash.remove());
  }
}

function startBeatSync() {
  stopBeatSync();
  if (!detectedBPM || !hammerIconEl) return;
  const ms = 60000 / detectedBPM;
  function hammerHit() {
    if (!isPlaying) return;
    const pwr = Math.pow(hammerSmooth, 2.5);
    if (pwr < 0.001) return;

    // Slam intensity scales with power AND stage
    const stageMultiplier = currentHammerStage === 'max' ? 1.3 : currentHammerStage === 'hot' ? 1.1 : currentHammerStage === 'warm' ? 0.9 : 0.6;
    const angle = (-8 - pwr * 52) * stageMultiplier;
    const scl = 1 + pwr * 0.4 * stageMultiplier;

    hammerIconEl.style.transform = `rotate(${angle}deg) scale(${scl})`;
    hammerIconEl.style.transition = 'transform .03s ease-out';

    if (hammerHitTimeout) clearTimeout(hammerHitTimeout);
    hammerHitTimeout = setTimeout(() => {
      hammerIconEl.style.transform = 'rotate(0deg) scale(1)';
      hammerIconEl.style.transition = 'transform .12s cubic-bezier(.1,.9,.3,1)';
    }, 60 + pwr * 80);
  }
  hammerHit();
  beatIntervalId = setInterval(hammerHit, ms);
}

function stopBeatSync() {
  if (beatIntervalId) { clearInterval(beatIntervalId); beatIntervalId = null; }
  if (hammerIconEl) {
    hammerIconEl.style.transform = 'rotate(0deg) scale(1)';
  }
  // Reset hammer charge and stage
  hammerCharge = 0;
  chargeVelocity = 0;
  hammerPeakStage = 'cold';
  currentHammerStage = 'cold';
  energyLongWindow = [];
  energyShortWindow = [];
  spectralRatioWindow = [];
  trackMaxEnergy = 0.01;
  trackMinEnergy = 1;
  if (hammerCard) hammerCard.setAttribute('data-stage', 'cold');
  if (hammerStageEl) hammerStageEl.textContent = '';
  if (gaugeFill) gaugeFill.style.strokeDashoffset = GAUGE_CIRCUMFERENCE;
  if (gaugeGlow) gaugeGlow.style.strokeDashoffset = GAUGE_CIRCUMFERENCE;
  const hammerIconWrap = document.getElementById('hammerIconWrap');
  if (hammerIconWrap) { hammerIconWrap.style.width = '54px'; hammerIconWrap.style.height = '54px'; }
}

// ===== PLAYBACK CONTROLS =====
function playAudio() {
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
  isPlaying ? pauseAudio() : (audioBuffer && playAudio());
});

// Mini nav seek
document.getElementById('miniNav').addEventListener('click', (e) => {
  if (!audioBuffer) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
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
    isPlaying ? pauseAudio() : (audioBuffer && playAudio());
  }
});

// ===== PLAYLIST / TRACK LOADING =====
function updateTransportButtons() {
  document.getElementById('prevBtn').disabled = playlist.length === 0;
  document.getElementById('nextBtn').disabled = playlist.length === 0;
}
updateTransportButtons();

async function loadTrack(index) {
  if (index < 0 || index >= playlist.length) return;
  currentTrackIndex = index;
  loadingOverlay.classList.add('visible');
  stopAudio();

  try {
    // decodeAudioData consumes the buffer, so we need a copy each time
    const bufferCopy = playlist[index].arrayBuffer.slice(0);
    audioBuffer = await audioCtx.decodeAudioData(bufferCopy);
    extractWaveformData(audioBuffer);
    detectedBPM = await detectBPM(audioBuffer);
    console.log('Detected BPM:', detectedBPM);
    resizeCanvases();
    drawMiniWaveform();
    pauseOffset = 0;
    playAudio();
  } catch (err) {
    alert('Impossible de lire ce fichier audio. Essaie un autre format (MP3, WAV, OGG).');
    console.error('Audio decode error:', err);
  } finally {
    loadingOverlay.classList.remove('visible');
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
let votes = { fire: 430, up: 96, down: 111 };

function updateVoteDisplay() {
  const total = votes.fire + votes.up + votes.down;
  if (total === 0) return;
  const pctFire = (votes.fire / total) * 100;
  const pctUp = (votes.up / total) * 100;
  const pctDown = (votes.down / total) * 100;

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
    const res = await fetch('/api/votes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type })
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
fetch('/api/votes')
  .then(r => r.json())
  .then(data => { votes = data; updateVoteDisplay(); })
  .catch(() => updateVoteDisplay());

// Simulated chat votes (local only for ambiance)
setInterval(() => {
  const keys = ['fire', 'fire', 'fire', 'up', 'up', 'down', 'fire', 'up'];
  votes[keys[Math.floor(Math.random() * keys.length)]]++;
  updateVoteDisplay();
}, 2000 + Math.random() * 2000);

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
document.getElementById('btnDown').addEventListener('click', function () {
  sendVote('down');
  const r = this.getBoundingClientRect();
  showEmojiSplash('\uD83D\uDC4E', r.left + r.width / 2 - 30, r.top - 20);
});

document.getElementById('btnUp').addEventListener('click', function () {
  sendVote('up');
  const r = this.getBoundingClientRect();
  showEmojiSplash('\uD83D\uDC4D', r.left + r.width / 2 - 30, r.top - 20);
});

// ===== FIRE BUTTON =====
let fireTimeout = null;
let fireFadeTimeout = null;

function triggerFire() {
  const overlay = document.getElementById('fireOverlay');
  const flameBottom = document.getElementById('flameBottom');
  const flameTop = document.getElementById('flameTop');
  const emberContainer = document.getElementById('emberContainer');
  const wrapper = document.getElementById('wrapper');

  if (fireTimeout) clearTimeout(fireTimeout);
  if (fireFadeTimeout) clearTimeout(fireFadeTimeout);

  flameBottom.innerHTML = '';
  flameTop.innerHTML = '';
  emberContainer.innerHTML = '';

  // Set BPM-synced pulse speed
  const bpm = detectedBPM || 120;
  const beatDur = (60 / bpm) + 's';
  overlay.style.setProperty('--beat-dur', beatDur);

  createFlames(flameBottom, 45, 90, 300, 45, 170);
  createFlames(flameTop, 20, 55, 170, 35, 110);

  const types = ['ember-orange', 'ember-red', 'ember-yellow'];
  for (let i = 0; i < 100; i++) {
    const ember = document.createElement('div');
    ember.className = 'ember ' + types[Math.floor(Math.random() * 3)];
    ember.style.left = Math.random() * 100 + '%';
    ember.style.animationDelay = Math.random() * 6 + 's';
    ember.style.animationDuration = (3 + Math.random() * 6) + 's';
    ember.style.setProperty('--drift', (Math.random() - .5) * 80 + 'px');
    const size = 1.5 + Math.random() * 5;
    ember.style.width = size + 'px';
    ember.style.height = size + 'px';
    emberContainer.appendChild(ember);
  }

  overlay.style.transition = 'opacity .3s';
  overlay.style.opacity = '';
  overlay.classList.remove('on');
  // Force reflow to restart animation
  void overlay.offsetWidth;
  overlay.classList.add('on');
  wrapper.classList.add('shaking');

  setTimeout(() => wrapper.classList.remove('shaking'), 600);

  // Progressive fade-out: start dimming at 5s, fully gone at 8s
  fireFadeTimeout = setTimeout(() => {
    overlay.style.transition = 'opacity 3s ease-out';
    overlay.style.opacity = '0';
  }, 5000);

  fireTimeout = setTimeout(() => {
    overlay.classList.remove('on');
    overlay.style.opacity = '';
    overlay.style.transition = '';
  }, 8000);
}

document.getElementById('btnFire').addEventListener('click', function () {
  sendVote('fire');
  triggerFire();
  const r = this.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;

  // Flash bang
  const flash = document.createElement('div');
  flash.className = 'fire-flash';
  document.body.appendChild(flash);
  flash.addEventListener('animationend', () => flash.remove());

  // Emoji explosion
  for (let i = 0; i < 20; i++) {
    setTimeout(() => {
      showEmojiSplash('\uD83D\uDD25',
        cx - 30 + (Math.random() - .5) * 300,
        cy - 20 + (Math.random() - .5) * 200
      );
    }, i * 60);
  }
});

// ===== INIT =====
resizeCanvases();
generateDemoData();
animationLoop();
