// ═══════════════════════════════════════════════════════════
// ON ÉCOUTE — Independent Overlay Player Engine
// Only plays .mp3/.wav from on_ecoute_submissions table
// Emoji-based judge buttons, no YouTube
// ═══════════════════════════════════════════════════════════

// ===== AUDIO CONTEXT =====
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const gainNode = audioCtx.createGain();
// Analyser for real-time intensity glow
const analyser = audioCtx.createAnalyser();
analyser.fftSize = 512;
analyser.smoothingTimeConstant = 0.5;
gainNode.connect(analyser);
analyser.connect(audioCtx.destination);

const analyserData = new Uint8Array(analyser.frequencyBinCount);

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

// ===== WAVEFORM DRAWING (with intensity glow) =====
function drawWaveform(currentTime) {
  const dpr = window.devicePixelRatio || 1;
  const w = waveformCanvas.width / dpr;
  const h = waveformCanvas.height / dpr;
  const ctx = waveformCtx;

  ctx.clearRect(0, 0, w, h);

  const duration = getDuration();
  if (!duration || waveformData.length === 0) return;

  // Get real-time audio intensity for glow (bass-weighted for impact)
  let intensity = 0;
  let bassIntensity = 0;
  if (isPlaying) {
    analyser.getByteFrequencyData(analyserData);
    let sum = 0;
    let bassSum = 0;
    const bassEnd = Math.floor(analyserData.length * 0.15); // low frequencies
    for (let i = 0; i < analyserData.length; i++) {
      sum += analyserData[i];
      if (i < bassEnd) bassSum += analyserData[i];
    }
    intensity = sum / (analyserData.length * 255);
    bassIntensity = bassSum / (bassEnd * 255);
    // Amplify: square root to make differences more perceptible, then boost
    intensity = Math.pow(intensity, 0.6) * 1.8;
    bassIntensity = Math.pow(bassIntensity, 0.5) * 2.0;
    intensity = Math.min(1.0, Math.max(intensity, bassIntensity));
  }

  const centerY = h / 2;
  const totalBars = Math.floor(w / 4);
  const barW = 2.5;
  const gap = (w - totalBars * barW) / (totalBars - 1);
  const step = barW + gap;
  const progress = currentTime / duration;

  // Glow behind played portion — very visible, reacts to intensity
  if (intensity > 0.02) {
    const glowW = progress * w;
    const radius = 80 + intensity * 400;
    const glowGrad = ctx.createRadialGradient(glowW, centerY, 0, glowW, centerY, radius);
    glowGrad.addColorStop(0, `rgba(255, 140, 40, ${Math.min(1, intensity * 0.9)})`);
    glowGrad.addColorStop(0.3, `rgba(255, 100, 20, ${intensity * 0.5})`);
    glowGrad.addColorStop(0.6, `rgba(232, 80, 10, ${intensity * 0.25})`);
    glowGrad.addColorStop(1, 'rgba(200, 60, 10, 0)');
    ctx.fillStyle = glowGrad;
    ctx.fillRect(0, 0, w, h);

    // Additional wide ambient glow across played section during high intensity
    if (intensity > 0.4) {
      const ambientAlpha = (intensity - 0.4) * 0.3;
      const ambGrad = ctx.createLinearGradient(0, 0, glowW, 0);
      ambGrad.addColorStop(0, `rgba(255, 80, 0, 0)`);
      ambGrad.addColorStop(0.7, `rgba(255, 120, 30, ${ambientAlpha * 0.3})`);
      ambGrad.addColorStop(1, `rgba(255, 160, 50, ${ambientAlpha})`);
      ctx.fillStyle = ambGrad;
      ctx.fillRect(0, 0, glowW, h);
    }
  }

  for (let i = 0; i < totalBars; i++) {
    const x = i * step;
    const frac = i / totalBars;
    const idx = frac * (waveformData.length - 1);
    const amp = sampleWaveform(idx);
    const maxH = centerY * 0.85;
    const barH = Math.max(1, amp * maxH);
    const isPast = frac <= progress;

    if (isPast) {
      // Near playhead bars get strong intensity boost
      const nearPlayhead = 1 - Math.min(1, Math.abs(frac - progress) * 10);
      const boost = nearPlayhead * intensity * 1.2;
      const baseAlpha = 0.5 + amp * 0.4;
      const grad = ctx.createLinearGradient(x, centerY - barH, x, centerY + barH);
      grad.addColorStop(0, `rgba(${200 + boost * 55}, ${100 + boost * 120}, 20, ${Math.min(1, baseAlpha + boost * 0.5)})`);
      grad.addColorStop(0.4, `rgba(${232 + boost * 23}, ${118 + boost * 100}, 42, ${Math.min(1, baseAlpha + 0.15 + boost * 0.4)})`);
      grad.addColorStop(0.5, `rgba(${240 + boost * 15}, ${160 + boost * 70}, 50, ${Math.min(1, baseAlpha + 0.2 + boost * 0.3)})`);
      grad.addColorStop(0.6, `rgba(${232 + boost * 23}, ${118 + boost * 100}, 42, ${Math.min(1, baseAlpha + 0.15 + boost * 0.4)})`);
      grad.addColorStop(1, `rgba(${200 + boost * 55}, ${100 + boost * 120}, 20, ${Math.min(1, baseAlpha + boost * 0.5)})`);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = `rgba(180, 140, 90, ${0.1 + amp * 0.12})`;
    }

    const r = barW / 2;
    roundedBar(ctx, x, centerY - barH, barW, barH, r);
    roundedBar(ctx, x, centerY + 1, barW, barH, r);
  }

  // Playhead line with strong glow
  const px = progress * w;
  if (intensity > 0.02) {
    ctx.shadowBlur = 15 + intensity * 50;
    ctx.shadowColor = `rgba(255, 160, 40, ${Math.min(1, 0.5 + intensity * 0.8)})`;
  }
  ctx.fillStyle = `rgba(255, 200, 80, ${Math.min(1, 0.7 + intensity * 0.5)})`;
  ctx.fillRect(px - 1, 0, 2, h);
  ctx.shadowBlur = 0;
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

// ===== VOTES (On Écoute — only from Twitch chat, admin reactions are visual only) =====
let votes = { fire: 0, up: 0, down: 0 };

function updateOeChatDisplay() {
  const total = votes.fire + votes.up + votes.down;
  const pctFire = total > 0 ? (votes.fire / total) * 100 : 0;
  const pctUp = total > 0 ? (votes.up / total) * 100 : 0;
  const pctDown = total > 0 ? (votes.down / total) * 100 : 0;

  const p1 = document.getElementById('oeChatPct1');
  const p2 = document.getElementById('oeChatPct2');
  const p3 = document.getElementById('oeChatPct3');
  if (p1) p1.textContent = Math.round(pctFire) + '%';
  if (p2) p2.textContent = Math.round(pctUp) + '%';
  if (p3) p3.textContent = Math.round(pctDown) + '%';

  const b1 = document.getElementById('oeChatBar1');
  const b2 = document.getElementById('oeChatBar2');
  const b3 = document.getElementById('oeChatBar3');
  if (b1) b1.style.width = pctFire + '%';
  if (b2) b2.style.width = pctUp + '%';
  if (b3) b3.style.width = pctDown + '%';

  const c1 = document.getElementById('oeChatCount1');
  const c2 = document.getElementById('oeChatCount2');
  const c3 = document.getElementById('oeChatCount3');
  if (c1) c1.textContent = '(' + votes.fire + ')';
  if (c2) c2.textContent = '(' + votes.up + ')';
  if (c3) c3.textContent = '(' + votes.down + ')';
}

function loadVotesForCurrentTrack() {
  const subId = (playlist[currentTrackIndex] && playlist[currentTrackIndex].submission)
    ? playlist[currentTrackIndex].submission.id : undefined;
  if (!subId) return;
  fetch(`/api/on-ecoute/votes?submission_id=${subId}`)
    .then(r => r.json())
    .then(data => { votes = { fire: data.fire || 0, up: data.up || 0, down: data.down || 0 }; updateOeChatDisplay(); })
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

// ===== NAMES (loaded from settings) =====
async function loadJudgeNames() {
  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    const hostEl = document.getElementById('hostName');
    const guestEl = document.getElementById('guestName');
    if (hostEl) hostEl.textContent = settings.oe_host_name || '';
    if (guestEl) guestEl.textContent = settings.oe_guest_name || '';
  } catch {}
}
loadJudgeNames();
setInterval(loadJudgeNames, 10000);

// ===== REACTIONS SYSTEM (emoji rain — diffuse across full column) =====
const rainAnimations = ['rainFall1', 'rainFall2', 'rainFall3'];

function spawnReaction(judge, type) {
  const containerId = judge === 'host' ? 'hostReaction' : 'guestReaction';
  const container = document.getElementById(containerId);
  if (!container) return;

  const emojiMap = { fire: '\u{1F525}', up: '\u{1F44D}', down: '\u{1F44E}' };
  const classMap = { fire: 'react-fire', up: 'react-up', down: 'react-down' };

  const el = document.createElement('div');
  el.className = `reaction-float ${classMap[type] || ''}`;
  // Spread across the full 600px width of the zone
  el.style.left = `${30 + Math.random() * 520}px`;
  // Random size variation
  const scale = 0.6 + Math.random() * 0.7;
  // Pick random animation + random duration
  const anim = rainAnimations[Math.floor(Math.random() * rainAnimations.length)];
  const dur = 2.5 + Math.random() * 2;
  el.style.animation = `${anim} ${dur}s ease-out forwards`;

  const span = document.createElement('span');
  span.className = 'react-emoji';
  span.style.fontSize = `${Math.round(60 * scale)}px`;
  span.textContent = emojiMap[type] || '\u{1F525}';
  el.appendChild(span);
  container.appendChild(el);

  setTimeout(() => el.remove(), (dur + 0.5) * 1000);
}

// Spawn a burst of emojis — diffuse rain effect (12-18 staggered)
function spawnReactionBurst(judge, type) {
  const count = 12 + Math.floor(Math.random() * 7); // 12-18
  for (let i = 0; i < count; i++) {
    setTimeout(() => spawnReaction(judge, type), i * 60 + Math.random() * 100);
  }
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
    setTimeout(() => this.classList.remove('burst'), 700);

    // Spawn reaction burst
    spawnReactionBurst(judge, vote);

    // Overlay button clicks are visual only — no votes, no skip
    // Votes come only from Twitch chat, playback controlled only by admin
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

// Progress bar seek (works with both .progress-bar and .progress-bar-inline)
const progressBarEl = document.getElementById('progressBar');
if (progressBarEl) {
  progressBarEl.addEventListener('click', (e) => {
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
}

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
      spawnReactionBurst('host', 'fire');
      break;
    case 'KeyW':
      spawnReactionBurst('host', 'up');
      break;
    case 'KeyE':
      spawnReactionBurst('host', 'down');
      break;
    case 'KeyI':
      spawnReactionBurst('guest', 'fire');
      break;
    case 'KeyO':
      spawnReactionBurst('guest', 'up');
      break;
    case 'KeyP':
      spawnReactionBurst('guest', 'down');
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

// Auto-load On Écoute queue (but don't auto-play — wait for admin command)
fetchAndLoadQueue();

// ===== REMOTE CONTROL (admin → overlay) =====
let lastCommandTs = 0;

async function loadSubmissionById(submissionId, autoPlay) {
  // Check if already loaded as current track
  if (playlist[currentTrackIndex] && playlist[currentTrackIndex].submission?.id === submissionId) {
    if (autoPlay && !isPlaying) {
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      playAudio();
    }
    return;
  }
  // Check if in playlist
  const existing = playlist.findIndex(p => p.submission && p.submission.id === submissionId);
  if (existing >= 0) {
    await loadTrack(existing, autoPlay);
    return;
  }
  // Load audio from server
  try {
    const audioRes = await fetch(`/api/on-ecoute/audio/${submissionId}`);
    if (!audioRes.ok) return;
    const arrayBuffer = await audioRes.arrayBuffer();
    if (arrayBuffer.byteLength < 1000) return;
    // Fetch submission metadata
    let sub = { id: submissionId, title: 'Sans titre', artist: '', submitted_by: '' };
    try {
      const infoRes = await fetch(`/api/on-ecoute/playlist`);
      const submissions = await infoRes.json();
      const found = submissions.find(s => s.id === submissionId);
      if (found) sub = found;
    } catch {}
    playlist.push({ name: sub.title, arrayBuffer, submission: sub });
    updateQueueCounter();
    await loadTrack(playlist.length - 1, autoPlay);
  } catch (err) {
    console.error('Failed to load submission:', err);
  }
}

// Report playback state to server (so admin can display waveform position)
setInterval(() => {
  const subId = playlist[currentTrackIndex]?.submission?.id;
  if (!subId) return;
  const currentTime = isPlaying ? (pauseOffset + audioCtx.currentTime - startTime) : pauseOffset;
  const duration = audioBuffer ? audioBuffer.duration : 0;
  fetch('/api/on-ecoute/playback-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentTime, duration, isPlaying, submissionId: subId }),
  }).catch(() => {});
}, 300);

// Poll for admin commands every 400ms
setInterval(async () => {
  try {
    const res = await fetch(`/api/on-ecoute/command?since=${lastCommandTs}`);
    if (!res.ok) return;
    const cmd = await res.json();
    if (!cmd.action || cmd.ts <= lastCommandTs) return;
    lastCommandTs = cmd.ts;

    switch (cmd.action) {
      case 'play':
        if (cmd.submissionId) {
          await loadSubmissionById(cmd.submissionId, true);
        } else {
          if (audioCtx.state === 'suspended') await audioCtx.resume();
          if (!isPlaying) playAudio();
        }
        break;
      case 'pause':
        if (isPlaying) pauseAudio();
        break;
      case 'stop':
        stopAudio();
        updateTrackInfo(null);
        break;
      case 'seek':
        if (cmd.seekTo != null && audioBuffer) {
          const wasPlaying = isPlaying;
          if (isPlaying) {
            sourceNode.stop();
            sourceNode.disconnect();
          }
          pauseOffset = Math.max(0, Math.min(cmd.seekTo, audioBuffer.duration));
          if (wasPlaying) playAudio();
        }
        break;
      case 'reaction':
        if (cmd.judge && cmd.react) {
          // Trigger button burst animation
          const matchBtn = document.querySelector(`.judge-btn[data-judge="${cmd.judge}"][data-vote="${cmd.react}"]`);
          if (matchBtn) {
            matchBtn.classList.remove('burst');
            void matchBtn.offsetWidth;
            matchBtn.classList.add('burst');
            setTimeout(() => matchBtn.classList.remove('burst'), 700);
          }
          // Spawn burst of floating emojis (NOT just one)
          spawnReactionBurst(cmd.judge, cmd.react);
          // Admin reactions are VISUAL ONLY — no vote counting
        }
        break;
    }
  } catch {}
}, 400);
