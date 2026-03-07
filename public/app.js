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
let lastKickTime = 0; // cooldown to avoid rapid re-triggers
let hammerSmooth = 0;

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
  const now = performance.now();
  const isKick = rise > .04 && kickLevel > .15 && (now - lastKickTime) > 120;
  prevKickLevel += (kickLevel - prevKickLevel) * .4;

  // Kick impact — strong hit, slow decay
  if (isKick) {
    lastKickTime = now;
    const intensity = Math.min(1, rise * 8 * Math.max(densitySmooth, .3));
    kickDecay = Math.max(kickDecay, intensity);

    // Scene impact: single punch transform
    if (intensity > .3) {
      const ox = (Math.random() - .5) * intensity * 6;
      const oy = intensity * 4;
      scene.style.transition = 'transform .06s ease-out';
      scene.style.transform = `perspective(1200px) rotateY(-5deg) rotateX(2deg) translate(${ox}px, ${oy}px) scale(${1 + intensity * .008})`;
      setTimeout(() => {
        scene.style.transition = 'transform .35s cubic-bezier(.25,.1,.25,1)';
        scene.style.transform = 'perspective(1200px) rotateY(-5deg) rotateX(2deg)';
      }, 60);
    }
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
  phGlow.addColorStop(.35, `rgba(245,60,30,${.06 + kickDecay * .12})`);
  phGlow.addColorStop(.5, `rgba(255,80,40,${.12 + kickDecay * .2})`);
  phGlow.addColorStop(.65, `rgba(245,60,30,${.06 + kickDecay * .12})`);
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

  // Glow elements — intensify blur + opacity on kicks
  if (glow1El) { glow1El.style.opacity = .3 + kickDecay * 1.4; glow1El.style.filter = `blur(${35 + kickDecay * 25}px)`; }
  if (glow2El) { glow2El.style.opacity = .15 + kickDecay * 1.1; glow2El.style.filter = `blur(${20 + kickDecay * 15}px)`; }

  // Background kick pump (scale only, no brightness flash)
  const bgPump = 1 + kickDecay * .02;
  if (bgEl) {
    bgEl.style.scale = bgPump;
  }

  // Hammer loudness meter — strict scoring, 100% = truly heavy
  const hammerRaw = Math.min(1, Math.pow(kickLevel, 1.8) * 1.2 + densitySmooth * 0.15 + kickDecay * 0.4);
  hammerSmooth += (hammerRaw - hammerSmooth) * .08;
  // Apply curve to make high values harder to reach
  const hammerCurved = Math.pow(hammerSmooth, 1.6);
  const hammerPct = Math.round(hammerCurved * 100);
  const hArcFill = document.querySelector('.hammer-arc-fill');
  const hPctEl = document.getElementById('hammerPct');
  const hIcon = document.getElementById('hammerIcon');
  if (hArcFill) {
    // Arc: 270deg total (3/4 circle). dasharray = 270 out of ~314 (2*PI*50)
    const arcLen = 2 * Math.PI * 50 * 0.75; // ~235.6
    const fillLen = arcLen * hammerCurved;
    hArcFill.style.strokeDasharray = fillLen + ' ' + (2 * Math.PI * 50);
    hArcFill.style.strokeDashoffset = '0';
    // Color: green < 33%, yellow 33-66%, red > 66%
    if (hammerPct < 33) {
      hArcFill.style.stroke = '#4ade80';
    } else if (hammerPct < 66) {
      hArcFill.style.stroke = '#facc15';
    } else {
      hArcFill.style.stroke = '#ef4444';
    }
    // Glow intensity scales with level
    const glowSize = 4 + hammerCurved * 12;
    hArcFill.style.filter = `drop-shadow(0 0 ${glowSize}px currentColor)`;
  }
  if (hPctEl) hPctEl.textContent = hammerPct + '%';
  if (hIcon && isKick && kickDecay > .15) {
    // Hammer hit animation — scale with intensity
    const hitScale = 1.2 + kickDecay * 0.4;
    hIcon.style.transform = `translate(-50%, -50%) rotate(-20deg) scale(${hitScale})`;
    hIcon.classList.add('hit');
    setTimeout(() => {
      hIcon.classList.remove('hit');
      hIcon.style.transform = '';
    }, 150);
  }

  // Mini waveform progress
  miniProgress.style.width = ((currentTime / duration) * 100) + '%';
}

function drawWaveformBars(ctx, w, h, timeStart, windowSec, playheadX, centerY, duration, kick, glowOnly) {
  const barW = 3, gap = 1.5, step = barW + gap;
  const numBars = Math.ceil(w / step);

  // Played region gradient
  const gradPlayed = ctx.createLinearGradient(0, centerY - h * .42, 0, centerY + h * .42);
  gradPlayed.addColorStop(0, 'rgba(180,40,20,0.55)');
  gradPlayed.addColorStop(.2, 'rgba(235,65,35,0.95)');
  gradPlayed.addColorStop(.5, 'rgba(250,80,45,1)');
  gradPlayed.addColorStop(.8, 'rgba(235,65,35,0.95)');
  gradPlayed.addColorStop(1, 'rgba(180,40,20,0.55)');

  for (let i = 0; i < numBars; i++) {
    const x = i * step;
    const tSec = timeStart + (x / w) * windowSec;
    const pNorm = tSec / duration;
    if (pNorm < 0 || pNorm > 1) continue;

    const idx = Math.floor(pNorm * waveformData.length);
    let val = waveformData[Math.min(idx, waveformData.length - 1)] || 0;

    // Kick pulse near playhead
    const distToHead = Math.abs(x - playheadX);
    const proximity = Math.max(0, 1 - distToHead / (w * .15));
    val = val * (1 + kick * proximity * .35);

    const barH = Math.max(1, val * h * .42);
    const isPlayed = x < playheadX;

    if (glowOnly) {
      if (!isPlayed) continue;
      ctx.fillStyle = 'rgba(245,60,30,1)';
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
}

function pauseAudio() {
  if (sourceNode) {
    sourceNode.stop();
    sourceNode.disconnect();
  }
  pauseOffset += audioCtx.currentTime - startTime;
  isPlaying = false;
  playImg.style.display = 'block'; pauseImg.style.display = 'none';
}

function stopAudio() {
  if (sourceNode) {
    try { sourceNode.stop(); } catch (e) { /* already stopped */ }
    sourceNode.disconnect();
    sourceNode = null;
  }
  isPlaying = false;
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
