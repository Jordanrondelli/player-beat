// ═══════════════════════════════════════════════════════════
// ON ÉCOUTE — Independent Overlay Player Engine
// Only plays .mp3/.wav from on_ecoute_submissions table
// Emoji-based judge buttons, no YouTube
// ═══════════════════════════════════════════════════════════

// ===== AUDIO CONTEXT =====
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const gainNode = audioCtx.createGain();
gainNode.connect(audioCtx.destination);

let audioBuffer = null;
let sourceNode = null;
let isPlaying = false;
let startTime = 0;
let pauseOffset = 0;
let playlist = [];
let currentTrackIndex = -1;
let waveformData = [];
let waveformSigned = [];

// ===== DOM REFERENCES =====
const waveformCanvas = document.getElementById('waveformCanvas');
const waveformCtx = waveformCanvas.getContext('2d');
const playBtn = document.getElementById('playBtn');
const playIcon = document.getElementById('playIcon');
const pauseIcon = document.getElementById('pauseIcon');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl = document.getElementById('totalTime');
const progressFill = document.getElementById('progressFill');
const loadingOverlay = document.getElementById('loadingOverlay');
const trackTitleEl = document.getElementById('trackTitle');
const trackArtistEl = document.getElementById('trackArtist');
const trackSubmitterEl = document.getElementById('trackSubmitter');
const trackSepEl = document.getElementById('trackSep');
const queueCounterEl = document.getElementById('queueCounter');

// ===== CANVAS RESIZE =====
function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  const wrap = document.querySelector('.waveform-wrap');
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  waveformCanvas.width = rect.width * dpr;
  waveformCanvas.height = rect.height * dpr;
  waveformCtx.setTransform(1, 0, 0, 1, 0, 0);
  waveformCtx.scale(dpr, dpr);
  waveformCanvas.style.width = rect.width + 'px';
  waveformCanvas.style.height = rect.height + 'px';
}
window.addEventListener('resize', resizeCanvases);

// ===== WAVEFORM DATA =====
function extractWaveformData(buffer) {
  const raw = buffer.getChannelData(0);
  const n = 20000;
  const blockLen = Math.floor(raw.length / n);
  waveformData = [];
  waveformSigned = [];
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
    waveformSigned.push(maxAbs);
  }
  const maxRms = Math.max(...waveformData);
  if (maxRms > 0) waveformData = waveformData.map(v => v / maxRms);
  const maxPeak = Math.max(...waveformSigned);
  if (maxPeak > 0) waveformSigned = waveformSigned.map(v => v / maxPeak);
}

function sampleWaveform(fIdx) {
  const i = Math.floor(fIdx);
  const f = fIdx - i;
  const a = waveformData[Math.min(i, waveformData.length - 1)] || 0;
  const b = waveformData[Math.min(i + 1, waveformData.length - 1)] || 0;
  return a + (b - a) * f;
}

// ===== WAVEFORM DRAWING (inside capsule) =====
function drawWaveform(currentTime) {
  const dpr = window.devicePixelRatio || 1;
  const w = waveformCanvas.width / dpr;
  const h = waveformCanvas.height / dpr;
  const ctx = waveformCtx;

  ctx.clearRect(0, 0, w, h);

  const duration = getDuration();
  if (!duration || waveformData.length === 0) return;

  const centerY = h / 2;
  const totalBars = Math.floor(w / 4);
  const barW = 2.5;
  const gap = (w - totalBars * barW) / (totalBars - 1);
  const step = barW + gap;
  const progress = currentTime / duration;

  for (let i = 0; i < totalBars; i++) {
    const x = i * step;
    const frac = i / totalBars;
    const idx = frac * (waveformData.length - 1);
    const amp = sampleWaveform(idx);
    const maxH = centerY * 0.85;
    const barH = Math.max(1, amp * maxH);
    const isPast = frac <= progress;

    if (isPast) {
      const grad = ctx.createLinearGradient(x, centerY - barH, x, centerY + barH);
      grad.addColorStop(0, `rgba(200, 100, 20, ${0.4 + amp * 0.3})`);
      grad.addColorStop(0.4, `rgba(232, 118, 42, ${0.6 + amp * 0.4})`);
      grad.addColorStop(0.5, `rgba(240, 160, 50, ${0.7 + amp * 0.3})`);
      grad.addColorStop(0.6, `rgba(232, 118, 42, ${0.6 + amp * 0.4})`);
      grad.addColorStop(1, `rgba(200, 100, 20, ${0.4 + amp * 0.3})`);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = `rgba(180, 140, 90, ${0.1 + amp * 0.12})`;
    }

    const r = barW / 2;
    roundedBar(ctx, x, centerY - barH, barW, barH, r);
    roundedBar(ctx, x, centerY + 1, barW, barH, r);
  }

  // Playhead line
  const px = progress * w;
  ctx.fillStyle = 'rgba(255, 200, 80, 0.8)';
  ctx.fillRect(px - 0.5, 0, 1, h);
}

function roundedBar(ctx, x, y, w, h, r) {
  if (h < 1) { ctx.fillRect(x, y, w, 1); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.fill();
}

// ===== PLAYBACK HELPERS =====
function getDuration() {
  return audioBuffer ? audioBuffer.duration : 0;
}

function getCurrentTime() {
  if (!isPlaying) return pauseOffset;
  return pauseOffset + (audioCtx.currentTime - startTime);
}

function formatTime(sec) {
  if (!sec || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ===== PLAYBACK CONTROL =====
function playAudio() {
  if (!audioBuffer) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(gainNode);
  sourceNode.start(0, pauseOffset);
  startTime = audioCtx.currentTime;
  isPlaying = true;
  playIcon.style.display = 'none'; pauseIcon.style.display = 'inline';

  sourceNode.onended = () => {
    if (isPlaying && getCurrentTime() >= getDuration() - 0.5) {
      stopAudio();
      if (playlist.length > 1) {
        const next = (currentTrackIndex + 1) % playlist.length;
        loadTrack(next, true);
      }
    }
  };
}

function pauseAudio() {
  if (sourceNode) {
    sourceNode.stop();
    sourceNode.disconnect();
  }
  pauseOffset += audioCtx.currentTime - startTime;
  isPlaying = false;
  playIcon.style.display = 'inline'; pauseIcon.style.display = 'none';
}

function stopAudio() {
  if (sourceNode) {
    try { sourceNode.stop(); } catch (e) {}
    sourceNode.disconnect();
    sourceNode = null;
  }
  isPlaying = false;
  pauseOffset = 0;
  playIcon.style.display = 'inline'; pauseIcon.style.display = 'none';
}

// ===== TRACK LOADING =====
function updateTrackInfo(item) {
  if (!item) {
    trackTitleEl.textContent = 'En attente...';
    trackArtistEl.textContent = '';
    trackSubmitterEl.textContent = '';
    trackSepEl.textContent = '';
    return;
  }
  trackTitleEl.textContent = item.title || 'Sans titre';
  trackArtistEl.textContent = item.artist || '';
  trackSepEl.textContent = item.artist && item.submitted_by ? '\u00B7' : '';
  trackSubmitterEl.textContent = item.submitted_by ? `par ${item.submitted_by}` : '';
}

function updateQueueCounter() {
  if (!queueCounterEl) return;
  queueCounterEl.textContent = playlist.length === 0
    ? '0 / 0'
    : `${currentTrackIndex + 1} / ${playlist.length}`;
}

async function loadTrack(index, autoPlay) {
  if (index < 0 || index >= playlist.length) return;
  currentTrackIndex = index;
  loadingOverlay.classList.add('visible');
  stopAudio();

  const track = playlist[index];

  // Notify server this track is now playing
  if (track.submission && track.submission.id) {
    fetch(`/api/on-ecoute/now-playing/${track.submission.id}`, { method: 'POST' }).catch(() => {});
  }

  updateTrackInfo(track.submission);
  updateQueueCounter();

  try {
    const bufferCopy = track.arrayBuffer.slice(0);
    audioBuffer = await audioCtx.decodeAudioData(bufferCopy);
    extractWaveformData(audioBuffer);
    resizeCanvases();
    pauseOffset = 0;
    if (autoPlay !== false) playAudio();
  } catch (err) {
    console.error('On Ecoute: Audio decode error:', err);
    if (playlist.length > 1 && index + 1 < playlist.length) {
      loadingOverlay.classList.remove('visible');
      loadTrack(index + 1, autoPlay);
      return;
    }
  } finally {
    loadingOverlay.classList.remove('visible');
  }
}

function skipToNext() {
  if (playlist.length === 0) return;
  if (playlist.length === 1) { loadTrack(0, true); return; }
  const next = (currentTrackIndex + 1) % playlist.length;
  loadTrack(next, true);
}

// ===== QUEUE MANAGEMENT (On Écoute independent API) =====
async function fetchAndLoadQueue() {
  playlist = [];
  currentTrackIndex = -1;
  updateQueueCounter();
  updateTrackInfo(null);

  try {
    const res = await fetch('/api/on-ecoute/playlist');
    if (!res.ok) throw new Error('Server error');
    const submissions = await res.json();

    if (submissions.length === 0) {
      trackTitleEl.textContent = 'Aucun son en attente';
      return;
    }

    loadingOverlay.classList.add('visible');

    const fetchPromises = submissions.map(async (item) => {
      try {
        const response = await fetch(`/api/on-ecoute/audio/${item.id}`);
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength < 1000) return null;
        return { name: item.title, arrayBuffer, submission: item };
      } catch (err) {
        console.error('Failed to load:', item.title, err);
        return null;
      }
    });

    const results = await Promise.all(fetchPromises);
    playlist = results.filter(r => r !== null);
    loadingOverlay.classList.remove('visible');

    if (playlist.length > 0) {
      updateQueueCounter();
      await loadTrack(0);
    }
  } catch (err) {
    console.error('On Ecoute queue error:', err);
    trackTitleEl.textContent = 'Erreur de chargement';
    loadingOverlay.classList.remove('visible');
  }
}

// ===== VOTES (On Écoute) =====
let votes = { fire: 0, up: 0, down: 0 };

function loadVotesForCurrentTrack() {
  const subId = (playlist[currentTrackIndex] && playlist[currentTrackIndex].submission)
    ? playlist[currentTrackIndex].submission.id : undefined;
  if (!subId) return;
  fetch(`/api/on-ecoute/votes?submission_id=${subId}`)
    .then(r => r.json())
    .then(data => { votes = { fire: data.fire || 0, up: data.up || 0, down: data.down || 0 }; })
    .catch(() => {});
}
setInterval(loadVotesForCurrentTrack, 3000);

// ===== LEGEND (Meilleur Son — On Écoute) =====
let currentLegendUser = null;

async function loadLegend() {
  try {
    const res = await fetch('/api/on-ecoute/legend');
    const data = await res.json();
    const userEl = document.getElementById('legendUser');
    const trackEl = document.getElementById('legendTrack');
    const fireEl = document.getElementById('legendFire');
    if (!userEl) return;
    if (data && data.fire > 0) {
      const newUser = data.submitted_by || 'Anonyme';
      userEl.textContent = newUser;
      trackEl.textContent = (data.title || 'Sans titre') + (data.artist ? ' \u2014 ' + data.artist : '');
      fireEl.textContent = '\u{1F525} ' + data.fire + ' FIRE';
      if (currentLegendUser !== null && currentLegendUser !== newUser) {
        const card = document.getElementById('legendCard');
        card.classList.add('legend-new');
        setTimeout(() => card.classList.remove('legend-new'), 1500);
      }
      currentLegendUser = newUser;
    } else {
      userEl.textContent = '\u2014';
      trackEl.textContent = 'En attente du premier \u{1F525}';
      fireEl.textContent = '';
      currentLegendUser = null;
    }
  } catch (e) {}
}
loadLegend();
setInterval(loadLegend, 5000);

// ===== REACTIONS SYSTEM (emoji based) =====
function spawnReaction(judge, type) {
  const containerId = judge === 'host' ? 'hostReaction' : 'guestReaction';
  const container = document.getElementById(containerId);
  if (!container) return;

  const emojiMap = { fire: '\u{1F525}', up: '\u{1F44D}', down: '\u{1F44E}' };
  const classMap = { fire: 'react-fire', up: 'react-up', down: 'react-down' };

  const el = document.createElement('div');
  el.className = `reaction-float ${classMap[type] || ''}`;
  el.style.left = `${20 + Math.random() * 200}px`;

  const span = document.createElement('span');
  span.className = 'react-emoji';
  span.textContent = emojiMap[type] || '\u{1F525}';
  el.appendChild(span);
  container.appendChild(el);

  setTimeout(() => el.remove(), 3000);
}

// ===== JUDGE BUTTON HANDLERS =====
document.querySelectorAll('.judge-btn').forEach(btn => {
  btn.addEventListener('click', function () {
    const judge = this.dataset.judge;
    const vote = this.dataset.vote;

    // Visual burst
    this.classList.remove('burst');
    void this.offsetWidth;
    this.classList.add('burst');
    setTimeout(() => this.classList.remove('burst'), 500);

    // Spawn reaction
    spawnReaction(judge, vote);

    // Send vote to server (On Écoute API)
    const subId = (playlist[currentTrackIndex] && playlist[currentTrackIndex].submission)
      ? playlist[currentTrackIndex].submission.id : undefined;
    if (subId) {
      fetch('/api/on-ecoute/votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submission_id: subId, type: vote }),
      }).catch(() => {});
    }

    // Down = skip to next
    if (vote === 'down') {
      const bar = document.getElementById('topBar');
      bar.classList.add('skip-flash');
      setTimeout(() => bar.classList.remove('skip-flash'), 500);
      setTimeout(() => skipToNext(), 300);
    }
  });
});

// ===== TRANSPORT CONTROLS =====
playBtn.addEventListener('click', () => {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  isPlaying ? pauseAudio() : playAudio();
});

const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
if (prevBtn) prevBtn.addEventListener('click', () => {
  if (playlist.length === 0) return;
  const prev = (currentTrackIndex - 1 + playlist.length) % playlist.length;
  loadTrack(prev, true);
});
if (nextBtn) nextBtn.addEventListener('click', () => {
  if (playlist.length === 0) return;
  skipToNext();
});

// Progress bar seek
document.getElementById('progressBar').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const duration = getDuration();
  if (!duration || !audioBuffer) return;
  const wasPlaying = isPlaying;
  if (isPlaying) {
    sourceNode.stop();
    sourceNode.disconnect();
  }
  pauseOffset = pct * audioBuffer.duration;
  if (wasPlaying) playAudio();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target !== document.body) return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      isPlaying ? pauseAudio() : playAudio();
      break;
    case 'ArrowRight':
      e.preventDefault();
      skipToNext();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (playlist.length > 0) {
        const prev = (currentTrackIndex - 1 + playlist.length) % playlist.length;
        loadTrack(prev, true);
      }
      break;
    case 'KeyQ':
      spawnReaction('host', 'fire');
      break;
    case 'KeyW':
      spawnReaction('host', 'up');
      break;
    case 'KeyE':
      spawnReaction('host', 'down');
      document.getElementById('topBar').classList.add('skip-flash');
      setTimeout(() => document.getElementById('topBar').classList.remove('skip-flash'), 500);
      setTimeout(() => skipToNext(), 300);
      break;
    case 'KeyI':
      spawnReaction('guest', 'fire');
      break;
    case 'KeyO':
      spawnReaction('guest', 'up');
      break;
    case 'KeyP':
      spawnReaction('guest', 'down');
      document.getElementById('topBar').classList.add('skip-flash');
      setTimeout(() => document.getElementById('topBar').classList.remove('skip-flash'), 500);
      setTimeout(() => skipToNext(), 300);
      break;
  }
});

// ===== ANIMATION LOOP =====
function animationLoop() {
  requestAnimationFrame(animationLoop);

  const ct = getCurrentTime();
  const dur = getDuration();

  currentTimeEl.textContent = formatTime(ct);
  totalTimeEl.textContent = formatTime(dur);

  if (dur > 0) {
    progressFill.style.width = `${(ct / dur) * 100}%`;
  }

  if (waveformData.length > 0) {
    drawWaveform(ct);
  }

  // Auto-advance
  if (isPlaying && audioBuffer && ct >= audioBuffer.duration - 0.1) {
    stopAudio();
    if (playlist.length > 1) {
      const next = (currentTrackIndex + 1) % playlist.length;
      loadTrack(next, true);
    }
  }
}

// ===== INIT =====
resizeCanvases();
animationLoop();

// Auto-load On Écoute queue
fetchAndLoadQueue();
