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
const playBtn = document.getElementById('playBtn');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl = document.getElementById('totalTime');
const miniProgress = document.getElementById('miniProgress');
const loadingOverlay = document.getElementById('loadingOverlay');
const volumeSlider = document.getElementById('volumeSlider');
const volumeIcon = document.getElementById('volumeIcon');

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
}

function extractWaveformData(buffer) {
  const raw = buffer.getChannelData(0);
  const n = 10000;
  const blockLen = Math.floor(raw.length / n);
  waveformData = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < blockLen; j++) {
      sum += Math.abs(raw[i * blockLen + j] || 0);
    }
    waveformData.push(sum / blockLen);
  }
  const max = Math.max(...waveformData);
  if (max > 0) waveformData = waveformData.map(v => v / max);
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

// ===== KICK DETECTION STATE =====
let prevKickLevel = 0;
let kickDecay = 0;
let density = 0;
let densitySmooth = 0;

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

  // Kick detection
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
  const isKick = rise > .025 && kickLevel > .1;
  prevKickLevel += (kickLevel - prevKickLevel) * .5;

  // Shake only during dense sections (drops/chorus)
  if (isKick && densitySmooth > .35) {
    kickDecay = Math.min(1, rise * 6 * densitySmooth * 2);
  }
  kickDecay *= .78;

  // Apply shake to waveform panel
  const panel = document.querySelector('.waveform-panel');
  if (panel) {
    if (kickDecay > .03) {
      const intensity = kickDecay * densitySmooth * 2;
      const sx = Math.sin(currentTime * 73) * intensity * 6;
      const sy = Math.cos(currentTime * 97) * intensity * 3;
      panel.style.animation = 'none';
      panel.style.transform = `translate(${sx}px,${sy}px)`;
    } else {
      panel.style.animation = '';
      panel.style.transform = '';
    }
  }

  const windowSec = 3;
  const playheadX = w * 0.4;
  const scrollBack = 0.4 * windowSec;
  const timeStart = currentTime - scrollBack;
  const centerY = h * 0.52;

  // Glow pass
  const glowAlpha = .15 + kickDecay * .4;
  waveformCtx.save();
  waveformCtx.filter = `blur(${6 + kickDecay * 12}px)`;
  waveformCtx.globalAlpha = glowAlpha;
  drawWaveformBars(waveformCtx, w, h, timeStart, windowSec, playheadX, centerY, duration);
  waveformCtx.restore();

  // Sharp pass
  waveformCtx.globalAlpha = 1;
  waveformCtx.filter = 'none';
  drawWaveformBars(waveformCtx, w, h, timeStart, windowSec, playheadX, centerY, duration);

  // Playhead line
  waveformCtx.fillStyle = `rgba(255,255,255,${.3 + kickDecay * .2})`;
  waveformCtx.fillRect(playheadX - .5, 0, 1.5, h);

  // Spectrum at bottom
  if (isPlaying) {
    const specH = h * .12;
    const specY = h - specH - 4;
    const binCount = 64;
    const binW = w / binCount;
    for (let i = 0; i < binCount; i++) {
      const val = frequencyData[Math.floor(i * analyser.frequencyBinCount / binCount / 2)] || 0;
      const norm = val / 255;
      const barH = norm * specH;
      const hue = i / binCount;
      if (hue < .3)
        waveformCtx.fillStyle = `rgba(255,${80 + hue * 200},30,${.15 + norm * .25})`;
      else if (hue < .6)
        waveformCtx.fillStyle = `rgba(${255 - hue * 200},200,${100 + hue * 200},${.1 + norm * .2})`;
      else
        waveformCtx.fillStyle = `rgba(100,${180 + hue * 75},255,${.08 + norm * .15})`;
      waveformCtx.fillRect(i * binW, specY + specH - barH, binW - .5, barH);
    }
  }

  // Glow elements
  const glow1 = document.querySelector('.waveform-glow');
  const glow2 = document.querySelector('.waveform-glow2');
  if (glow1) glow1.style.opacity = .4 + kickDecay * 1.2;
  if (glow2) glow2.style.opacity = .2 + kickDecay * 1;

  // Mini waveform progress
  miniProgress.style.width = ((currentTime / duration) * 100) + '%';
}

function drawWaveformBars(ctx, w, h, timeStart, windowSec, playheadX, centerY, duration) {
  const barW = 4, gap = 0.4, step = barW + gap;
  const numBars = Math.ceil(w / step);
  for (let i = 0; i < numBars; i++) {
    const x = i * step;
    const t = timeStart + (x / w) * windowSec;
    const p = t / duration;
    if (p < 0 || p > 1) continue;

    // Smooth interpolation
    const fIdx = p * waveformData.length;
    const idx0 = Math.floor(fIdx);
    const idx1 = Math.min(idx0 + 1, waveformData.length - 1);
    const frac = fIdx - idx0;
    const val = (waveformData[idx0] || 0) * (1 - frac) + (waveformData[idx1] || 0) * frac;
    const barH = Math.max(2, val * h * .42);

    if (x <= playheadX) {
      const grad = ctx.createLinearGradient(0, centerY - barH, 0, centerY + barH);
      grad.addColorStop(0, 'rgba(200,45,25,0.7)');
      grad.addColorStop(.3, 'rgba(245,70,40,1)');
      grad.addColorStop(.7, 'rgba(245,70,40,1)');
      grad.addColorStop(1, 'rgba(170,30,15,0.65)');
      ctx.fillStyle = grad;
    } else {
      const d = (x - playheadX) / (w - playheadX);
      ctx.fillStyle = `rgba(255,255,255,${Math.max(.04, .8 - d * .55)})`;
    }
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
  playBtn.textContent = '\u23F8';
}

function pauseAudio() {
  if (sourceNode) {
    sourceNode.stop();
    sourceNode.disconnect();
  }
  pauseOffset += audioCtx.currentTime - startTime;
  isPlaying = false;
  playBtn.textContent = '\u25B6';
}

function stopAudio() {
  if (sourceNode) {
    try { sourceNode.stop(); } catch (e) { /* already stopped */ }
    sourceNode.disconnect();
    sourceNode = null;
  }
  isPlaying = false;
  pauseOffset = 0;
  playBtn.textContent = '\u25B6';
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
  for (let i = 0; i < 12; i++) {
    setTimeout(() => {
      showEmojiSplash('\uD83D\uDD25',
        r.left + r.width / 2 - 30 + (Math.random() - .5) * 200,
        r.top - 20 + (Math.random() - .5) * 100
      );
    }, i * 90);
  }
});

// ===== INIT =====
resizeCanvases();
generateDemoData();
animationLoop();
