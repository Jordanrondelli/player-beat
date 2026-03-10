// ═══════════════════════════════════════════════════════════
// ON ÉCOUTE — Overlay Player Engine
// Matching reference design: capsule player + judge buttons
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
let currentSource = null;
let serverQueue = [];

// ===== YOUTUBE IFRAME PLAYER =====
let ytPlayer = null;
let ytReady = false;
let ytIsCurrentSource = false;
let ytDuration = 0;

function onYouTubeIframeAPIReady() {
  ytPlayer = new YT.Player('ytPlayer', {
    width: 320, height: 180,
    playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, modestbranding: 1, rel: 0 },
    events: {
      onReady: () => { ytReady = true; console.log('YT Player ready (overlay)'); },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED && ytIsCurrentSource) {
          stopAudio();
          if (playlist.length > 1) {
            const next = currentTrackIndex + 1;
            if (next < playlist.length) loadTrack(next, true);
            else fetchAndLoadQueue(currentSource);
          }
        }
      },
    },
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

// ===== DOM REFERENCES =====
const waveformCanvas = document.getElementById('waveformCanvas');
const waveformCtx = waveformCanvas.getContext('2d');
const playBtn = document.getElementById('playBtn');
const playImg = document.getElementById('playImg');
const pauseImg = document.getElementById('pauseImg');
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

// ===== SYNTHETIC WAVEFORM (for YouTube) =====
function generateSyntheticWaveform(duration, videoId) {
  const sampleRate = 30;
  const totalSamples = Math.floor(duration * sampleRate);
  waveformData = [];
  waveformSigned = [];

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

  const secLen = 12 + rand() * 20;
  const numSections = Math.max(3, Math.floor(duration / secLen));
  const templates = [
    [0.25, 0.45, 0.85, 0.35, 0.50, 0.90, 0.30, 0.85],
    [0.30, 0.55, 0.70, 0.45, 0.75, 0.55, 0.80, 0.40],
    [0.35, 0.60, 0.80, 0.40, 0.65, 0.85, 0.35, 0.75],
    [0.20, 0.40, 0.65, 0.30, 0.50, 0.70, 0.80, 0.25],
  ];
  const template = templates[Math.floor(rand() * templates.length)];
  const sectionEnergies = [];
  for (let s = 0; s < numSections; s++) {
    const tIdx = s % template.length;
    const base = template[tIdx];
    sectionEnergies.push(Math.max(0.15, Math.min(0.95, base + (rand() - 0.5) * 0.15)));
  }

  const fakeBPM = 100 + rand() * 60;
  const beatSamples = (60 / fakeBPM) * sampleRate;
  const modFreq1 = 0.003 + rand() * 0.008;
  const modFreq2 = 0.01 + rand() * 0.02;
  const modPhase1 = rand() * Math.PI * 2;
  const modPhase2 = rand() * Math.PI * 2;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / totalSamples;
    const rawIdx = t * numSections;
    const sIdx = Math.min(numSections - 1, Math.floor(rawIdx));
    const nIdx = Math.min(numSections - 1, sIdx + 1);
    const blend = rawIdx - sIdx;
    const smooth = blend * blend * (3 - 2 * blend);
    const sectionLevel = sectionEnergies[sIdx] * (1 - smooth) + sectionEnergies[nIdx] * smooth;

    const beatPos = (i % beatSamples) / beatSamples;
    const kick = Math.exp(-beatPos * 8) * 0.20 * sectionLevel;
    const halfBeat = ((i + beatSamples / 2) % beatSamples) / beatSamples;
    const snare = Math.exp(-halfBeat * 6) * 0.10 * sectionLevel;

    const n1 = Math.sin(i * modFreq1 * 6.28 + modPhase1) * 0.08;
    const n2 = Math.sin(i * modFreq2 * 6.28 + modPhase2) * 0.05;
    const n3 = (rand() - 0.5) * 0.08 * sectionLevel;

    const accentPeriod = beatSamples * (4 + Math.floor(rand() * 2) * 2);
    const accentPos = (i % accentPeriod) / accentPeriod;
    const accent = accentPos < 0.02 ? 0.15 * sectionLevel : 0;

    const val = Math.max(0.04, Math.min(1, sectionLevel + kick + snare + n1 + n2 + n3 + accent));
    waveformData.push(val);
    waveformSigned.push(val);
  }

  const maxVal = Math.max(...waveformData);
  if (maxVal > 0) {
    for (let i = 0; i < waveformData.length; i++) {
      waveformData[i] /= maxVal;
      waveformSigned[i] /= maxVal;
    }
  }
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
  const totalBars = Math.floor(w / 4); // bar width ~3px + 1px gap
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
      // Played: warm orange/gold gradient
      const grad = ctx.createLinearGradient(x, centerY - barH, x, centerY + barH);
      grad.addColorStop(0, `rgba(200, 100, 20, ${0.4 + amp * 0.3})`);
      grad.addColorStop(0.4, `rgba(232, 118, 42, ${0.6 + amp * 0.4})`);
      grad.addColorStop(0.5, `rgba(240, 160, 50, ${0.7 + amp * 0.3})`);
      grad.addColorStop(0.6, `rgba(232, 118, 42, ${0.6 + amp * 0.4})`);
      grad.addColorStop(1, `rgba(200, 100, 20, ${0.4 + amp * 0.3})`);
      ctx.fillStyle = grad;
    } else {
      // Unplayed: dim gray/warm
      ctx.fillStyle = `rgba(180, 140, 90, ${0.1 + amp * 0.12})`;
    }

    // Mirror bars
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
  if (ytIsCurrentSource) return ytDuration || 0;
  return audioBuffer ? audioBuffer.duration : 0;
}

function getCurrentTime() {
  if (ytIsCurrentSource) {
    return (ytPlayer && ytReady) ? ytPlayer.getCurrentTime() : 0;
  }
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
  if (ytIsCurrentSource) {
    if (ytPlayer && ytReady) {
      ytPlayer.playVideo();
      isPlaying = true;
      playImg.style.display = 'none'; pauseImg.style.display = 'block';
    }
    return;
  }
  if (!audioBuffer) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(gainNode);
  sourceNode.start(0, pauseOffset);
  startTime = audioCtx.currentTime;
  isPlaying = true;
  playImg.style.display = 'none'; pauseImg.style.display = 'block';

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
  if (ytIsCurrentSource) {
    if (ytPlayer && ytReady) ytPlayer.pauseVideo();
    isPlaying = false;
    playImg.style.display = 'block'; pauseImg.style.display = 'none';
    return;
  }
  if (sourceNode) {
    sourceNode.stop();
    sourceNode.disconnect();
  }
  pauseOffset += audioCtx.currentTime - startTime;
  isPlaying = false;
  playImg.style.display = 'block'; pauseImg.style.display = 'none';
}

function stopAudio() {
  if (ytIsCurrentSource) {
    if (ytPlayer && ytReady) ytPlayer.stopVideo();
    ytIsCurrentSource = false;
    ytDuration = 0;
  }
  if (sourceNode) {
    try { sourceNode.stop(); } catch (e) {}
    sourceNode.disconnect();
    sourceNode = null;
  }
  isPlaying = false;
  pauseOffset = 0;
  playImg.style.display = 'block'; pauseImg.style.display = 'none';
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
  trackSepEl.textContent = item.artist && item.submitted_by ? '·' : '';
  trackSubmitterEl.textContent = item.submitted_by ? `par ${item.submitted_by}` : '';
}

function updateQueueCounter() {
  if (!queueCounterEl) return;
  if (serverQueue.length === 0) {
    queueCounterEl.textContent = '0 / 0';
  } else {
    queueCounterEl.textContent = `${currentTrackIndex + 1} / ${serverQueue.length}`;
  }
}

async function loadTrack(index, autoPlay) {
  if (index < 0 || index >= playlist.length) return;
  currentTrackIndex = index;
  loadingOverlay.classList.add('visible');
  stopAudio();

  votes = { fire: 0, up: 0, down: 0 };

  const qItem = playlist[index] && playlist[index].queueItem;
  if (qItem && qItem.id) {
    fetch(`/api/player/now-playing/${qItem.id}`, { method: 'POST' }).catch(() => {});
  }

  const track = playlist[index];
  updateTrackInfo(track.queueItem);
  updateQueueCounter();

  // YouTube track
  if (track.youtubeId) {
    ytIsCurrentSource = true;
    audioBuffer = null;
    waveformData = [];
    waveformSigned = [];

    if (ytPlayer && ytReady) {
      const cuePromise = new Promise((resolve) => {
        const onStateChange = (e) => {
          if (e.data === YT.PlayerState.CUED || e.data === YT.PlayerState.PLAYING) {
            ytPlayer.removeEventListener('onStateChange', onStateChange);
            resolve();
          }
        };
        ytPlayer.addEventListener('onStateChange', onStateChange);
        ytPlayer.cueVideoById(track.youtubeId);
        setTimeout(resolve, 2000);
      });
      await cuePromise;

      ytDuration = ytPlayer.getDuration();
      if (ytDuration <= 0) ytDuration = 180;

      generateSyntheticWaveform(ytDuration, track.youtubeId);
      resizeCanvases();
      pauseOffset = 0;
      if (autoPlay !== false) {
        ytPlayer.playVideo();
        isPlaying = true;
        playImg.style.display = 'none'; pauseImg.style.display = 'block';
      }
    }
    loadingOverlay.classList.remove('visible');

    // Background: try to upgrade to real audio
    const ytVideoId = track.youtubeId;
    fetch(`/api/yt-audio/${ytVideoId}`, { signal: AbortSignal.timeout(12000) })
      .then(async (audioRes) => {
        if (!audioRes.ok) return;
        const arrayBuffer = await audioRes.arrayBuffer();
        if (arrayBuffer.byteLength <= 1000) return;
        const realAudioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        console.log(`Overlay: YouTube audio upgraded: ${realAudioBuffer.duration.toFixed(1)}s`);
        if (playlist[currentTrackIndex] && playlist[currentTrackIndex].youtubeId === ytVideoId) {
          const currentPos = (ytPlayer && ytReady) ? ytPlayer.getCurrentTime() : 0;
          const wasPlaying = isPlaying;
          audioBuffer = realAudioBuffer;
          extractWaveformData(audioBuffer);
          resizeCanvases();
          if (ytPlayer && ytReady) ytPlayer.pauseVideo();
          ytIsCurrentSource = false;
          pauseOffset = currentPos;
          if (wasPlaying) playAudio();
        }
      })
      .catch((e) => console.log('Overlay: YouTube upgrade skipped:', e.message));
    return;
  }

  // Regular upload track
  ytIsCurrentSource = false;
  try {
    const bufferCopy = track.arrayBuffer.slice(0);
    audioBuffer = await audioCtx.decodeAudioData(bufferCopy);
    extractWaveformData(audioBuffer);
    resizeCanvases();
    pauseOffset = 0;
    if (autoPlay !== false) playAudio();
  } catch (err) {
    console.error('Overlay: Audio decode error:', err);
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

// ===== QUEUE MANAGEMENT =====
async function fetchAndLoadQueue(type) {
  currentSource = type;
  serverQueue = [];
  playlist = [];
  currentTrackIndex = -1;
  updateQueueCounter();
  updateTrackInfo(null);

  try {
    const url = type ? `/api/player/playlist?type=${type}` : '/api/player/playlist';
    const res = await fetch(url);
    if (!res.ok) throw new Error('Server error');
    serverQueue = await res.json();

    if (serverQueue.length === 0) {
      updateTrackInfo(null);
      trackTitleEl.textContent = 'Aucun son en attente';
      return;
    }

    loadingOverlay.classList.add('visible');

    const fetchPromises = serverQueue.map(async (item) => {
      if (item.type === 'youtube' && item.source_url) {
        const m = item.source_url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|music\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/);
        if (m) return { name: item.title, youtubeId: m[1], queueItem: item };
        return null;
      }
      try {
        const response = await fetch(`/api/audio/${item.id}`);
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength < 1000) return null;
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
      updateQueueCounter();
      await loadTrack(0);
    }
  } catch (err) {
    console.error('Overlay queue error:', err);
    trackTitleEl.textContent = 'Erreur de chargement';
    loadingOverlay.classList.remove('visible');
  }
}

// ===== VOTES =====
let votes = { fire: 0, up: 0, down: 0 };

function loadVotesForCurrentTrack() {
  const queueId = (playlist[currentTrackIndex] && playlist[currentTrackIndex].queueItem)
    ? playlist[currentTrackIndex].queueItem.id : undefined;
  const url = queueId ? `/api/votes?queue_id=${queueId}` : '/api/votes';
  fetch(url)
    .then(r => r.json())
    .then(data => { votes = { fire: data.fire || 0, up: data.up || 0, down: data.down || 0 }; })
    .catch(() => {});
}
setInterval(loadVotesForCurrentTrack, 3000);

// ===== LEGEND (Meilleur Son) =====
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
      trackEl.textContent = (data.title || 'Sans titre') + (data.artist ? ' — ' + data.artist : '');
      fireEl.textContent = '\u{1F525} ' + data.fire + ' FIRE';
      if (currentLegendUser !== null && currentLegendUser !== newUser) {
        const card = document.getElementById('legendCard');
        card.classList.add('legend-new');
        setTimeout(() => card.classList.remove('legend-new'), 1500);
      }
      currentLegendUser = newUser;
    } else {
      userEl.textContent = '—';
      trackEl.textContent = 'En attente du premier \u{1F525}';
      fireEl.textContent = '';
      currentLegendUser = null;
    }
  } catch (e) {}
}
loadLegend();
setInterval(loadLegend, 5000);

// ===== REACTIONS SYSTEM =====
function spawnReaction(judge, type) {
  const containerId = judge === 'host' ? 'hostReaction' : 'guestReaction';
  const container = document.getElementById(containerId);
  if (!container) return;

  const imgMap = { fire: 'fire.png', up: 'pouce-vert.png', down: 'pouce-rouge.png' };
  const classMap = { fire: 'react-fire', up: 'react-up', down: 'react-down' };

  const el = document.createElement('div');
  el.className = `reaction-float ${classMap[type] || ''}`;
  el.style.left = `${20 + Math.random() * 200}px`;

  const img = document.createElement('img');
  img.src = imgMap[type] || 'fire.png';
  el.appendChild(img);
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

    // Send vote to server
    const queueId = (playlist[currentTrackIndex] && playlist[currentTrackIndex].queueItem)
      ? playlist[currentTrackIndex].queueItem.id : undefined;
    if (queueId && vote === 'fire') {
      fetch('/api/votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queue_id: queueId, vote_type: 'fire', value: 5 }),
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

// Source toggle
document.querySelectorAll('.src-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.src-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    stopAudio();
    const type = btn.id === 'srcUpload' ? 'upload' : btn.id === 'srcYoutube' ? 'youtube' : null;
    fetchAndLoadQueue(type);
  });
});

// Progress bar seek
document.getElementById('progressBar').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const duration = getDuration();
  if (!duration) return;

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

  // Update time display
  currentTimeEl.textContent = formatTime(ct);
  totalTimeEl.textContent = formatTime(dur);

  // Update progress bar
  if (dur > 0) {
    progressFill.style.width = `${(ct / dur) * 100}%`;
  }

  // Draw waveform
  if (waveformData.length > 0) {
    drawWaveform(ct);
  }

  // Auto-advance for uploads
  if (isPlaying && !ytIsCurrentSource && audioBuffer && ct >= audioBuffer.duration - 0.1) {
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

// Auto-load queue on page load (all sources)
fetchAndLoadQueue(null);
