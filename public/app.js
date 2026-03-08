// ===== FLAME GENERATION =====
function createFlames(container, count, hMin, hMax, wMin, wMax) {
  for (let i = 0; i < count; i++) {
    const flame = document.createElement('div');
    flame.className = 'flame';
    const color = Math.random() > .6
      ? 'rgba(255,60,0,.6)'
      : Math.random() > .4
        ? 'rgba(255,120,0,.5)'
        : 'rgba(255,180,40,.4)';
    flame.style.cssText = `
      width:${wMin + Math.random() * (wMax - wMin)}px;
      height:${hMin + Math.random() * (hMax - hMin)}px;
      left:${Math.random() * 100}%;
      background:radial-gradient(ellipse at 50% 80%,${color},rgba(255,80,0,.2) 50%,transparent 70%);
      --dur:${.4 + Math.random() * .6}s;
      --op:${.4 + Math.random() * .3};
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
let waveformData = [];

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
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    a += .15 + Math.random() * .05;
    b += .08 + Math.random() * .03;
    c += .3 + Math.random() * .1;
    let v = Math.sin(a) * .35 + Math.sin(b) * .25 + Math.sin(c) * .15 + (Math.random() - .5) * .25;
    v *= Math.max(.08, Math.pow(Math.sin(t * Math.PI), .5) * (.5 + .5 * Math.sin(t * 8 + Math.sin(t * 3) * 2)));
    waveformData.push(Math.abs(v));
  }
  const max = Math.max(...waveformData);
  waveformData = waveformData.map(v => v / max);
  // No smoothing on demo data
}

function extractWaveformData(buffer) {
  const raw = buffer.getChannelData(0);
  const n = 20000;
  const blockLen = Math.floor(raw.length / n);
  waveformData = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < blockLen; j++) {
      const s = raw[i * blockLen + j] || 0;
      sum += s * s;
    }
    // RMS — preserves transient peaks better than average abs
    waveformData.push(Math.sqrt(sum / blockLen));
  }
  const max = Math.max(...waveformData);
  if (max > 0) waveformData = waveformData.map(v => v / max);
  // No smoothing — preserve kick transients
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
let detectedBPM = 0;
let beatIntervalId = null;

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
  kickDecay *= .88;



  const windowSec = 4;
  const playheadX = w * 0.35;
  const scrollBack = 0.35 * windowSec;
  const timeStart = currentTime - scrollBack;
  const centerY = h * 0.5;

  // Bass glow pass — extra warm aura on kicks (screen blend)
  if (kickDecay > .02) {
    waveformCtx.save();
    waveformCtx.filter = `blur(${14 + kickDecay * 22}px)`;
    waveformCtx.globalAlpha = kickDecay * .55;
    waveformCtx.globalCompositeOperation = 'screen';
    drawWaveformBars(waveformCtx, w, h, timeStart, windowSec, playheadX, centerY, duration, kickDecay, true);
    waveformCtx.restore();
  }

  // Glow pass — played side only, red glow
  waveformCtx.save();
  waveformCtx.filter = `blur(${8 + kickDecay * 16}px)`;
  waveformCtx.globalAlpha = .12 + kickDecay * .45;
  drawWaveformBars(waveformCtx, w, h, timeStart, windowSec, playheadX, centerY, duration, kickDecay, true);
  waveformCtx.restore();

  // Sharp pass — full waveform
  waveformCtx.globalAlpha = 1;
  waveformCtx.filter = 'none';
  drawWaveformBars(waveformCtx, w, h, timeStart, windowSec, playheadX, centerY, duration, kickDecay, false);

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

  // Hammer power % — based on loudness (how loud/saturated the sound is)
  // RMS typically ranges 0.05 (quiet) to 0.45 (loud/saturated)
  const hammerRaw = Math.min(1, Math.max(0, (loudnessSmooth - 0.03) / 0.4));
  hammerSmooth += (hammerRaw - hammerSmooth) * .08;
  const hammerPct = Math.round(Math.pow(hammerSmooth, 0.7) * 100);
  const hPctEl = document.getElementById('hammerPct');
  if (hPctEl) {
    hPctEl.textContent = hammerPct + '%';
    if (hammerPct < 33) {
      hPctEl.style.color = 'rgba(255, 255, 255, .45)';
    } else if (hammerPct < 66) {
      hPctEl.style.color = 'rgba(250, 204, 21, .7)';
    } else {
      hPctEl.style.color = 'rgba(239, 68, 68, .85)';
    }
    hPctEl.style.transform = kickDecay > .3 ? `scale(${1 + kickDecay * .15})` : '';
  }



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

function drawWaveformBars(ctx, w, h, timeStart, windowSec, playheadX, centerY, duration, kick, glowOnly) {
  const barW = 2, gap = 1, step = barW + gap;
  const numBars = Math.ceil(w / step);

  // Played region gradient
  const gradPlayed = ctx.createLinearGradient(0, centerY - h * .42, 0, centerY + h * .42);
  gradPlayed.addColorStop(0, 'rgba(150,15,10,0.55)');
  gradPlayed.addColorStop(.2, 'rgba(200,25,15,0.95)');
  gradPlayed.addColorStop(.5, 'rgba(220,30,20,1)');
  gradPlayed.addColorStop(.8, 'rgba(200,25,15,0.95)');
  gradPlayed.addColorStop(1, 'rgba(150,15,10,0.55)');

  for (let i = 0; i < numBars; i++) {
    const x = i * step;
    const tSec = timeStart + (x / w) * windowSec;
    const pNorm = tSec / duration;
    if (pNorm < 0 || pNorm > 1) continue;

    // Interpolated sample with contrast boost
    const fIdx = pNorm * (waveformData.length - 1);
    let val = Math.pow(sampleWaveform(fIdx), 0.85);

    const barH = Math.max(1, val * h * .42);
    const isPlayed = x < playheadX;

    if (glowOnly) {
      if (!isPlayed) continue;
      ctx.fillStyle = 'rgba(200,25,15,1)';
      ctx.fillRect(x, centerY - barH, barW, barH * 2);
      continue;
    }

    if (isPlayed) {
      ctx.fillStyle = gradPlayed;
    } else {
      const fadeAlpha = Math.max(0.06, 0.5 - ((x - playheadX) / (w - playheadX)) * 0.44);
      ctx.fillStyle = `rgba(200,210,230,${fadeAlpha})`;
    }

    // Draw bar (mirrored top/bottom)
    ctx.beginPath();
    ctx.roundRect(x, centerY - barH, barW, barH * 2, 1.5);
    ctx.fill();
  }
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

function startBeatSync() {
  stopBeatSync();
  if (!detectedBPM || !hammerIconEl) return;
  const ms = 60000 / detectedBPM;
  function hammerHit() {
    if (!isPlaying) return;
    // Power-driven amplitude (exponential curve)
    const pwr = Math.pow(hammerSmooth, 2.5);
    if (pwr < 0.001) return; // 0% power = no movement
    const angle = -8 - pwr * 52;
    const scl = 1 + pwr * 0.4;
    hammerIconEl.style.transform = `rotate(${angle}deg) scale(${scl})`;
    hammerIconEl.style.transition = 'transform .03s ease-out';
    hammerIconEl.style.filter = `drop-shadow(0 ${2 + pwr * 6}px ${8 + pwr * 16}px rgba(255,120,0,${0.3 + pwr * 0.5}))`;
    if (hammerHitTimeout) clearTimeout(hammerHitTimeout);
    hammerHitTimeout = setTimeout(() => {
      hammerIconEl.style.transform = 'rotate(0deg) scale(1)';
      hammerIconEl.style.transition = 'transform .12s cubic-bezier(.1,.9,.3,1)';
      hammerIconEl.style.filter = 'drop-shadow(0 2px 8px rgba(255,120,0,.4))';
    }, 60 + pwr * 80);
  }
  hammerHit();
  beatIntervalId = setInterval(hammerHit, ms);
}

function stopBeatSync() {
  if (beatIntervalId) { clearInterval(beatIntervalId); beatIntervalId = null; }
  if (hammerIconEl) {
    hammerIconEl.style.transform = 'rotate(0deg) scale(1)';
    hammerIconEl.style.filter = 'drop-shadow(0 2px 8px rgba(255,120,0,.4))';
  }
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

// File input with loading + error handling
document.getElementById('audioFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  loadingOverlay.classList.add('visible');
  stopAudio();

  try {
    const arrayBuffer = await file.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
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

function triggerFire() {
  const overlay = document.getElementById('fireOverlay');
  const flameBottom = document.getElementById('flameBottom');
  const flameTop = document.getElementById('flameTop');
  const emberContainer = document.getElementById('emberContainer');
  const wrapper = document.getElementById('wrapper');

  if (fireTimeout) clearTimeout(fireTimeout);

  flameBottom.innerHTML = '';
  flameTop.innerHTML = '';
  emberContainer.innerHTML = '';

  createFlames(flameBottom, 35, 80, 260, 40, 150);
  createFlames(flameTop, 15, 50, 150, 30, 100);

  const types = ['ember-orange', 'ember-red', 'ember-yellow'];
  for (let i = 0; i < 80; i++) {
    const ember = document.createElement('div');
    ember.className = 'ember ' + types[Math.floor(Math.random() * 3)];
    ember.style.left = Math.random() * 100 + '%';
    ember.style.animationDelay = Math.random() * 4 + 's';
    ember.style.animationDuration = (2.5 + Math.random() * 5) + 's';
    ember.style.setProperty('--drift', (Math.random() - .5) * 60 + 'px');
    const size = 1.5 + Math.random() * 4;
    ember.style.width = size + 'px';
    ember.style.height = size + 'px';
    emberContainer.appendChild(ember);
  }

  overlay.style.transition = 'opacity .3s';
  overlay.classList.add('on');
  wrapper.classList.add('shaking');

  setTimeout(() => wrapper.classList.remove('shaking'), 2500);

  fireTimeout = setTimeout(() => {
    overlay.style.transition = 'opacity 2.5s ease-out';
    overlay.classList.remove('on');
  }, 2500);
}

document.getElementById('btnFire').addEventListener('click', function () {
  sendVote('fire');
  triggerFire();
  const r = this.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;

  // Shockwave from button center
  const shock = document.createElement('div');
  shock.className = 'fire-shockwave';
  shock.style.left = cx + 'px';
  shock.style.top = cy + 'px';
  shock.style.transform = 'translate(-50%, -50%)';
  document.body.appendChild(shock);
  shock.addEventListener('animationend', () => shock.remove());

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
