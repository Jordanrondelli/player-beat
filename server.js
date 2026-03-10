const express = require('express');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const { parseBuffer } = require('music-metadata');
const ytdl = require('@distube/ytdl-core');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== DATABASE =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS queue (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT DEFAULT '',
      source_url TEXT DEFAULT '',
      file_path TEXT DEFAULT '',
      file_data BYTEA,
      file_mimetype TEXT DEFAULT 'audio/mpeg',
      submitted_by TEXT DEFAULT 'Anonyme',
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      queue_id INTEGER REFERENCES queue(id) ON DELETE CASCADE,
      fire INTEGER DEFAULT 0,
      up INTEGER DEFAULT 0,
      down INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migrate: add file_data column if missing
  await pool.query(`
    ALTER TABLE queue ADD COLUMN IF NOT EXISTS file_data BYTEA;
    ALTER TABLE queue ADD COLUMN IF NOT EXISTS file_mimetype TEXT DEFAULT 'audio/mpeg';
  `);

  // Twitch votes: 1 vote per user per track
  await pool.query(`
    CREATE TABLE IF NOT EXISTS twitch_votes (
      id SERIAL PRIMARY KEY,
      queue_id INTEGER REFERENCES queue(id) ON DELETE CASCADE,
      twitch_user TEXT NOT NULL,
      vote_type TEXT NOT NULL,
      UNIQUE(queue_id, twitch_user)
    );
  `);

  // Skins system
  await pool.query(`
    CREATE TABLE IF NOT EXISTS skins (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      is_active BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS skin_images (
      id SERIAL PRIMARY KEY,
      skin_id INTEGER REFERENCES skins(id) ON DELETE CASCADE,
      image_key TEXT NOT NULL,
      file_data BYTEA NOT NULL,
      file_mimetype TEXT DEFAULT 'image/png',
      UNIQUE(skin_id, image_key)
    );
  `);

  // Seed default admin if none exists
  const { rows } = await pool.query('SELECT id FROM admin_users LIMIT 1');
  if (rows.length === 0) {
    if (!process.env.ADMIN_PASSWORD) {
      console.error('WARNING: ADMIN_PASSWORD env variable is not set! Default admin will NOT be created.');
      console.error('Set ADMIN_PASSWORD in your environment to create the admin user.');
    } else {
      const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
      await pool.query('INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)', ['admin', hash]);
      console.log('Default admin created (user: admin)');
    }
  }

  // Seed default settings
  const defaults = {
    background_style: 'default',
    fire_button_enabled: 'true',
    power_sensitivity: '1.0',
    power_release: '0.006',
    primary_color: '#ff4400',
    player_source: 'community',
    twitch_channel: '',
    power_youtube: 'true',
    power_uploads: 'true',
  };
  for (const [key, value] of Object.entries(defaults)) {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, value]
    );
  }
  console.log('Database initialized');
}

// ===== MIDDLEWARE =====

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Let the app manage CSP
}));

// Trust proxy (for rate limiting behind Render/reverse proxy)
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sessions (use PG store in production)
const PgSession = require('connect-pg-simple')(session);
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict',
  },
}));

// Upload config
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'audio/mpeg' || file.mimetype === 'audio/mp3') {
      cb(null, true);
    } else {
      cb(new Error('Seuls les fichiers MP3 sont acceptés'));
    }
  },
});

// Serve uploaded files
app.use('/uploads', express.static(uploadDir));

// Auth middleware
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/login');
}

// ===== PAGES (before static to take priority) =====

// Public submit page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'submit.html'));
});

// Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// Player page (admin only)
app.get('/player', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// "On Écoute" overlay page (admin only)
app.get('/on-ecoute', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'on-ecoute.html'));
});

// Admin page (admin only)
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// Static assets (CSS, JS, images) — AFTER explicit routes
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ===== AUTH API =====

// Rate limit login: 5 attempts per 15 min per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de tentatives, réessaie dans 15 minutes' },
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Mot de passe requis' });

  const { rows } = await pool.query('SELECT * FROM admin_users WHERE username = $1', ['admin']);
  if (rows.length === 0) return res.status(401).json({ error: 'Identifiants incorrects' });

  const valid = bcrypt.compareSync(password, rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'Mot de passe incorrect' });

  req.session.isAdmin = true;
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ===== QUEUE API =====

// Rate limit queue submissions: 10 per hour per IP
const queueLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de soumissions, réessaie plus tard' },
});

// Submit a track (public)
app.post('/api/queue', queueLimiter, upload.single('audio'), async (req, res) => {
  try {
    const { type, title, artist, source_url, submitted_by } = req.body;

    // Input length validation
    if (submitted_by && submitted_by.length > 50) {
      return res.status(400).json({ error: 'Pseudo trop long (max 50 caractères)' });
    }
    if (title && title.length > 200) {
      return res.status(400).json({ error: 'Titre trop long (max 200 caractères)' });
    }
    if (artist && artist.length > 200) {
      return res.status(400).json({ error: 'Artiste trop long (max 200 caractères)' });
    }

    if (type === 'upload') {
      if (!req.file) return res.status(400).json({ error: 'Fichier audio requis' });
      // Read file into buffer for DB storage
      const fileBuffer = fs.readFileSync(req.file.path);
      const mimetype = req.file.mimetype || 'audio/mpeg';

      // Extract ID3 metadata from MP3
      let metaTitle = title || '';
      let metaArtist = artist || '';
      try {
        const metadata = await parseBuffer(fileBuffer, { mimeType: mimetype });
        if (!metaTitle && metadata.common.title) metaTitle = metadata.common.title;
        if (!metaArtist && metadata.common.artist) metaArtist = metadata.common.artist;
      } catch (e) {
        console.error('ID3 parse error (non-fatal):', e.message);
      }
      if (!metaTitle) metaTitle = req.file.originalname.replace(/\.mp3$/i, '');

      const { rows } = await pool.query(
        'INSERT INTO queue (type, title, artist, file_data, file_mimetype, submitted_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, type, title, artist, submitted_by, status, created_at',
        ['upload', metaTitle, metaArtist, fileBuffer, mimetype, submitted_by || 'Anonyme']
      );
      // Clean up temp file
      fs.unlinkSync(req.file.path);
      await pool.query('INSERT INTO votes (queue_id) VALUES ($1)', [rows[0].id]);
      return res.json(rows[0]);
    }

    if (type === 'youtube') {
      if (!source_url) return res.status(400).json({ error: 'Lien YouTube requis' });

      // Validate YouTube URL format
      const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/|music\.youtube\.com\/watch\?v=)/;
      if (!ytRegex.test(source_url)) {
        return res.status(400).json({ error: 'Lien YouTube invalide.' });
      }

      // Fetch title/artist via oEmbed (fast, works from any server)
      let ytTitle = title || '';
      let ytArtist = artist || '';
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(source_url)}&format=json`;
        const oembedRes = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
        if (oembedRes.ok) {
          const oembedData = await oembedRes.json();
          if (!ytTitle && oembedData.title) ytTitle = oembedData.title;
          if (!ytArtist && oembedData.author_name) ytArtist = oembedData.author_name;
        }
      } catch (e) {
        console.error('YouTube oEmbed error (non-fatal):', e.message);
      }
      if (!ytTitle) ytTitle = 'YouTube Track';

      // Store YouTube URL only — audio is fetched on-demand when the player loads the track
      const { rows } = await pool.query(
        'INSERT INTO queue (type, title, artist, source_url, submitted_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, type, title, artist, source_url, submitted_by, status, created_at',
        ['youtube', ytTitle, ytArtist, source_url, submitted_by || 'Anonyme']
      );
      await pool.query('INSERT INTO votes (queue_id) VALUES ($1)', [rows[0].id]);
      return res.json(rows[0]);
    }

    res.status(400).json({ error: 'Type invalide (upload ou youtube)' });
  } catch (err) {
    console.error('Queue submit error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Public queue count
app.get('/api/queue/count', async (req, res) => {
  const { rows } = await pool.query("SELECT COUNT(*) as count FROM queue WHERE status = 'pending'");
  res.json({ count: parseInt(rows[0].count) });
});

// Get queue (admin)
app.get('/api/queue', requireAdmin, async (req, res) => {
  const status = req.query.status || 'pending';
  const { rows } = await pool.query(
    'SELECT q.id, q.type, q.title, q.artist, q.source_url, q.submitted_by, q.status, q.created_at, v.fire, v.up, v.down FROM queue q LEFT JOIN votes v ON v.queue_id = q.id WHERE q.status = $1 ORDER BY q.created_at ASC',
    [status]
  );
  res.json(rows);
});

// Update queue item status (admin)
app.patch('/api/queue/:id', requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'playing', 'played', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status invalide' });
  }
  await pool.query('UPDATE queue SET status = $1 WHERE id = $2', [status, req.params.id]);
  // When a track starts playing, reset its votes so each track starts fresh
  if (status === 'playing') {
    await pool.query('UPDATE votes SET fire = 0, up = 0, down = 0 WHERE queue_id = $1', [req.params.id]);
    await pool.query('DELETE FROM twitch_votes WHERE queue_id = $1', [req.params.id]);
  }
  res.json({ success: true });
});

// Wipe all by type (admin)
app.delete('/api/queue/wipe-all', requireAdmin, async (req, res) => {
  const type = req.query.type;
  if (type && ['upload', 'youtube'].includes(type)) {
    await pool.query('DELETE FROM queue WHERE type = $1', [type]);
  } else {
    await pool.query('DELETE FROM queue');
  }
  res.json({ success: true });
});

// Delete queue item (admin)
app.delete('/api/queue/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM queue WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ===== VOTES API =====

app.get('/api/votes', async (req, res) => {
  const queueId = req.query.queue_id;
  if (queueId) {
    const { rows } = await pool.query('SELECT * FROM votes WHERE queue_id = $1', [queueId]);
    return res.json(rows[0] || { fire: 0, up: 0, down: 0 });
  }
  // Legacy: return total votes
  const { rows } = await pool.query('SELECT COALESCE(SUM(fire),0) as fire, COALESCE(SUM(up),0) as up, COALESCE(SUM(down),0) as down FROM votes');
  res.json(rows[0]);
});

// Rate limit votes: 30 per minute per IP
const voteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Trop de votes, réessaie dans une minute' },
});

app.post('/api/votes', voteLimiter, async (req, res) => {
  const { type, queue_id } = req.body;
  if (!type || !['fire', 'up', 'down'].includes(type)) {
    return res.status(400).json({ error: 'Type must be fire, up, or down' });
  }
  const amount = type === 'fire' ? 5 : 1;
  if (queue_id) {
    await pool.query(
      `UPDATE votes SET
        fire = fire + CASE WHEN $1 = 'fire' THEN $2 ELSE 0 END,
        up = up + CASE WHEN $1 = 'up' THEN $2 ELSE 0 END,
        down = down + CASE WHEN $1 = 'down' THEN $2 ELSE 0 END
      WHERE queue_id = $3`,
      [type, amount, queue_id]
    );
    const { rows } = await pool.query('SELECT * FROM votes WHERE queue_id = $1', [queue_id]);
    return res.json(rows[0]);
  }
  res.json({ fire: 0, up: 0, down: 0 });
});

// Player marks a track as now playing (resets votes + enables Twitch voting)
app.post('/api/player/now-playing/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  // Set all other tracks to non-playing, then set this one to playing
  await pool.query("UPDATE queue SET status = 'pending' WHERE status = 'playing'");
  await pool.query("UPDATE queue SET status = 'playing' WHERE id = $1", [id]);
  // Reset votes for fresh start
  await pool.query('UPDATE votes SET fire = 0, up = 0, down = 0 WHERE queue_id = $1', [id]);
  await pool.query('DELETE FROM twitch_votes WHERE queue_id = $1', [id]);
  res.json({ fire: 0, up: 0, down: 0 });
});

// Reset all votes (admin only)
app.delete('/api/votes', requireAdmin, async (req, res) => {
  await pool.query('UPDATE votes SET fire = 0, up = 0, down = 0');
  await pool.query('DELETE FROM twitch_votes');
  res.json({ success: true });
});

// ===== LEGEND WALL API =====
app.get('/api/legend', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT q.title, q.artist, q.submitted_by, v.fire
      FROM votes v JOIN queue q ON v.queue_id = q.id
      WHERE v.fire > 0
      ORDER BY v.fire DESC LIMIT 1
    `);
    if (rows.length > 0) {
      res.json(rows[0]);
    } else {
      res.json(null);
    }
  } catch (e) {
    res.json(null);
  }
});

// ===== SETTINGS API =====

app.get('/api/settings', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM settings');
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json(settings);
});

// ===== SERVE AUDIO FROM DB (uploads only — YouTube is played client-side) =====
app.get('/api/audio/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT file_data, file_mimetype, title FROM queue WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length || !rows[0].file_data) {
      return res.status(404).json({ error: 'Audio non trouvé' });
    }
    const { file_data, file_mimetype } = rows[0];
    res.set({
      'Content-Type': file_mimetype || 'audio/mpeg',
      'Content-Length': file_data.length,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    });
    res.send(file_data);
  } catch (err) {
    console.error('Audio serve error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ===== YOUTUBE AUDIO PROXY (via Piped/Invidious) =====
// Rate limit YT proxy: 30 per hour per IP
const ytProxyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { error: 'Trop de requêtes YouTube, réessaie plus tard' },
});

// Server fetches from Piped (no CORS issues), Piped fetches from YouTube (different IP than Render)
app.get('/api/yt-audio/:videoId', ytProxyLimiter, async (req, res) => {
  const videoId = req.params.videoId;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  // Check DB cache first
  try {
    const { rows } = await pool.query(
      "SELECT file_data, file_mimetype FROM queue WHERE source_url LIKE $1 AND file_data IS NOT NULL LIMIT 1",
      [`%${videoId}%`]
    );
    if (rows.length && rows[0].file_data && rows[0].file_data.length > 1000) {
      console.log(`YT proxy: serving cached audio for ${videoId}`);
      res.set({
        'Content-Type': rows[0].file_mimetype || 'audio/mp4',
        'Content-Length': rows[0].file_data.length,
        'Cache-Control': 'public, max-age=86400',
      });
      return res.send(rows[0].file_data);
    }
  } catch (e) { /* ignore cache errors */ }

  // Race all providers in parallel — first successful response wins
  async function tryPiped(instance) {
    console.log(`YT proxy (${instance}): fetching streams for ${videoId}`);
    const infoRes = await fetch(`${instance}/streams/${videoId}`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!infoRes.ok) throw new Error(`HTTP ${infoRes.status}`);
    const info = await infoRes.json();
    const audioStreams = (info.audioStreams || [])
      .filter(s => s.url && s.mimeType && s.mimeType.startsWith('audio/'))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (audioStreams.length === 0) throw new Error('no audio streams');
    const stream = audioStreams[0];
    console.log(`YT proxy: downloading from ${instance} (${stream.mimeType}, ${stream.bitrate}bps)`);
    const audioRes = await fetch(stream.url, {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!audioRes.ok) throw new Error(`download HTTP ${audioRes.status}`);
    const buf = Buffer.from(await audioRes.arrayBuffer());
    if (buf.length < 1000) throw new Error('too small');
    return { buf, mime: stream.mimeType.split(';')[0], source: `Piped ${instance}` };
  }

  async function tryInvidious(instance) {
    console.log(`YT proxy Invidious (${instance}): trying ${videoId}`);
    const infoRes = await fetch(`${instance}/api/v1/videos/${videoId}`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'Accept': 'application/json' },
    });
    if (!infoRes.ok) throw new Error(`HTTP ${infoRes.status}`);
    const info = await infoRes.json();
    const audioFormats = (info.adaptiveFormats || [])
      .filter(f => f.type && f.type.startsWith('audio/'))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (audioFormats.length === 0 || !audioFormats[0].url) throw new Error('no audio');
    const audioRes = await fetch(audioFormats[0].url, { signal: AbortSignal.timeout(30000) });
    if (!audioRes.ok) throw new Error(`download HTTP ${audioRes.status}`);
    const buf = Buffer.from(await audioRes.arrayBuffer());
    if (buf.length < 1000) throw new Error('too small');
    return { buf, mime: audioFormats[0].type.split(';')[0], source: `Invidious ${instance}` };
  }

  // Launch all providers in parallel, take first success
  const providers = [
    tryPiped('https://pipedapi.kavin.rocks'),
    tryPiped('https://pipedapi.adminforge.de'),
    tryPiped('https://piped-api.codespace.cz'),
    tryInvidious('https://inv.nadeko.net'),
    tryInvidious('https://yewtu.be'),
  ];

  // Promise.any resolves with the first fulfilled promise
  try {
    const result = await Promise.any(providers);
    console.log(`YT proxy: success via ${result.source}! ${result.buf.length} bytes (${result.mime})`);
    pool.query(
      "UPDATE queue SET file_data = $1, file_mimetype = $2 WHERE source_url LIKE $3 AND file_data IS NULL",
      [result.buf, result.mime, `%${videoId}%`]
    ).catch(() => {});
    res.set({ 'Content-Type': result.mime, 'Content-Length': result.buf.length, 'Cache-Control': 'public, max-age=86400' });
    return res.send(result.buf);
  } catch (e) {
    console.log('YT proxy: all Piped/Invidious failed, trying Cobalt...');
  }

  // Try Cobalt API instances in parallel as fallback
  async function tryCobaltV10(cobaltBase) {
    console.log(`YT proxy Cobalt v10 (${cobaltBase}): trying ${videoId}`);
    const cobaltRes = await fetch(`${cobaltBase}/`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `https://www.youtube.com/watch?v=${videoId}`,
        downloadMode: 'audio',
        audioFormat: 'mp3',
        audioBitrate: '128',
      }),
    });
    if (!cobaltRes.ok) throw new Error(`HTTP ${cobaltRes.status}`);
    const cobaltData = await cobaltRes.json();
    const downloadUrl = cobaltData.url || cobaltData.audio;
    if (!downloadUrl) throw new Error('no URL');
    const audioRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
    if (!audioRes.ok) throw new Error(`download HTTP ${audioRes.status}`);
    const buf = Buffer.from(await audioRes.arrayBuffer());
    if (buf.length < 1000) throw new Error('too small');
    const mime = audioRes.headers.get('content-type')?.split(';')[0] || 'audio/mpeg';
    return { buf, mime, source: `Cobalt v10 ${cobaltBase}` };
  }

  async function tryCobaltV7(cobaltBase) {
    console.log(`YT proxy Cobalt v7 (${cobaltBase}): trying ${videoId}`);
    const cobaltRes = await fetch(`${cobaltBase}/api/json`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `https://www.youtube.com/watch?v=${videoId}`,
        isAudioOnly: true,
        aFormat: 'mp3',
      }),
    });
    if (!cobaltRes.ok) throw new Error(`HTTP ${cobaltRes.status}`);
    const cobaltData = await cobaltRes.json();
    if (cobaltData.status !== 'stream' && cobaltData.status !== 'redirect') throw new Error(`status=${cobaltData.status}`);
    const downloadUrl = cobaltData.url;
    if (!downloadUrl) throw new Error('no URL');
    const audioRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
    if (!audioRes.ok) throw new Error(`download HTTP ${audioRes.status}`);
    const buf = Buffer.from(await audioRes.arrayBuffer());
    if (buf.length < 1000) throw new Error('too small');
    const mime = audioRes.headers.get('content-type')?.split(';')[0] || 'audio/mpeg';
    return { buf, mime, source: `Cobalt v7 ${cobaltBase}` };
  }

  const cobaltProviders = [
    tryCobaltV10('https://api.cobalt.tools'),
    tryCobaltV10('https://cobalt-api.ayo.tf'),
    tryCobaltV7('https://cobaltapi.clebootin.com'),
    tryCobaltV7('https://ca.haloz.at'),
    tryCobaltV7('https://nyc1.coapi.ggtyler.dev'),
  ];

  try {
    const result = await Promise.any(cobaltProviders);
    console.log(`YT proxy: success via ${result.source}! ${result.buf.length} bytes (${result.mime})`);
    pool.query("UPDATE queue SET file_data = $1, file_mimetype = $2 WHERE source_url LIKE $3 AND file_data IS NULL", [result.buf, result.mime, `%${videoId}%`]).catch(() => {});
    res.set({ 'Content-Type': result.mime, 'Content-Length': result.buf.length, 'Cache-Control': 'public, max-age=86400' });
    return res.send(result.buf);
  } catch (e) {
    console.log('YT proxy: all Cobalt instances failed too');
  }

  res.status(502).json({ error: 'Audio YouTube indisponible' });
});

// ===== PLAYER PLAYLIST (public) =====

// Returns shuffled tracks for the player, filtered by type
app.get('/api/player/playlist', async (req, res) => {
  try {
    const type = req.query.type; // 'upload' or 'youtube'
    let query = "SELECT q.id, q.type, q.title, q.artist, q.source_url, q.submitted_by, q.status, q.created_at, v.fire, v.up, v.down FROM queue q LEFT JOIN votes v ON v.queue_id = q.id WHERE q.status IN ('pending', 'playing')";
    const params = [];
    if (type && ['upload', 'youtube'].includes(type)) {
      query += ' AND q.type = $1';
      params.push(type);
    }
    query += ' ORDER BY RANDOM()';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Player playlist error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Count by type for the player
app.get('/api/player/count', async (req, res) => {
  try {
    const uploadRes = await pool.query("SELECT COUNT(*) as count FROM queue WHERE status IN ('pending', 'playing') AND type = 'upload'");
    const ytRes = await pool.query("SELECT COUNT(*) as count FROM queue WHERE status IN ('pending', 'playing') AND type = 'youtube'");
    res.json({
      upload: parseInt(uploadRes.rows[0].count),
      youtube: parseInt(ytRes.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ===== CURRENT TRACK (for player) =====

app.get('/api/current-track', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT q.id, q.type, q.title, q.artist, q.source_url, q.submitted_by, q.status, q.created_at, v.fire, v.up, v.down FROM queue q LEFT JOIN votes v ON v.queue_id = q.id WHERE q.status = 'playing' ORDER BY q.created_at DESC LIMIT 1"
  );
  res.json(rows[0] || null);
});

app.post('/api/play-next', requireAdmin, async (req, res) => {
  // Mark current playing as played
  await pool.query("UPDATE queue SET status = 'played' WHERE status = 'playing'");
  // Get next pending
  const { rows } = await pool.query(
    "SELECT * FROM queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
  );
  if (rows.length === 0) return res.json(null);
  await pool.query("UPDATE queue SET status = 'playing' WHERE id = $1", [rows[0].id]);
  // Reset votes for this new track
  await pool.query('UPDATE votes SET fire = 0, up = 0, down = 0 WHERE queue_id = $1', [rows[0].id]);
  await pool.query('DELETE FROM twitch_votes WHERE queue_id = $1', [rows[0].id]);
  rows[0].status = 'playing';
  res.json(rows[0]);
});

// ===== TWITCH CHAT INTEGRATION =====
const tmi = require('tmi.js');
let twitchClient = null;
let currentTwitchChannel = '';

async function startTwitchBot() {
  // Get twitch channel from settings
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'twitch_channel'");
  const channel = (rows[0] && rows[0].value || '').trim().toLowerCase();

  if (!channel) {
    console.log('No Twitch channel configured, bot not started');
    return;
  }
  if (channel === currentTwitchChannel && twitchClient) {
    return; // Already connected to this channel
  }

  // Disconnect existing client
  if (twitchClient) {
    try { twitchClient.disconnect(); } catch {}
    twitchClient = null;
  }

  currentTwitchChannel = channel;
  console.log(`Connecting to Twitch channel: ${channel}`);

  twitchClient = new tmi.Client({
    channels: [channel],
  });

  twitchClient.on('message', async (ch, tags, message, self) => {
    if (self) return;
    const msg = message.trim().toLowerCase();
    const user = tags['display-name'] || tags.username || 'anonymous';

    let voteType = null;
    if (msg === '!jaime') voteType = 'up';
    else if (msg === '!jaimepas') voteType = 'down';
    else if (msg === '!fire') voteType = 'fire';
    else return;

    try {
      // Only vote on the currently PLAYING track
      const { rows: playing } = await pool.query(
        "SELECT id FROM queue WHERE status = 'playing' LIMIT 1"
      );
      if (!playing.length) return;
      const queueId = playing[0].id;

      // 1 vote per user per track (UNIQUE constraint prevents duplicates)
      const { rowCount } = await pool.query(
        'INSERT INTO twitch_votes (queue_id, twitch_user, vote_type) VALUES ($1, $2, $3) ON CONFLICT (queue_id, twitch_user) DO NOTHING',
        [queueId, user, voteType]
      );

      // Only update votes table if the insert actually happened (not a duplicate)
      if (rowCount > 0) {
        await pool.query(
          `UPDATE votes SET
            fire = fire + CASE WHEN $1 = 'fire' THEN 1 ELSE 0 END,
            up = up + CASE WHEN $1 = 'up' THEN 1 ELSE 0 END,
            down = down + CASE WHEN $1 = 'down' THEN 1 ELSE 0 END
          WHERE queue_id = $2`,
          [voteType, queueId]
        );
      }
    } catch (e) {
      console.error('Twitch vote error:', e.message);
    }
  });

  try {
    await twitchClient.connect();
    console.log(`Twitch bot connected to #${channel}`);
  } catch (e) {
    console.error('Twitch connect error:', e.message);
    twitchClient = null;
    currentTwitchChannel = '';
  }
}

// Settings update (+ reconnect twitch if channel changed)
app.put('/api/settings', requireAdmin, async (req, res) => {
  const entries = Object.entries(req.body);
  for (const [key, value] of entries) {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, String(value)]
    );
  }
  res.json({ success: true });
  // Restart twitch bot if channel changed
  if ('twitch_channel' in req.body) {
    startTwitchBot().catch(e => console.error('Twitch restart error:', e));
  }
});

// API: get twitch votes for current track (for the player to poll)
app.get('/api/twitch-votes', async (req, res) => {
  const queueId = req.query.queue_id;
  if (!queueId) return res.json({ fire: 0, up: 0, down: 0 });
  const { rows } = await pool.query('SELECT * FROM votes WHERE queue_id = $1', [queueId]);
  res.json(rows[0] || { fire: 0, up: 0, down: 0 });
});

// ===== SKINS API =====

const SKIN_IMAGE_KEYS = ['bg', 'marteau', 'play', 'pause', 'fire', 'pouce_rouge', 'pouce_vert', 'bloc_titre', 'bloc_chat', 'murlegende'];

const skinUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Seuls les fichiers image sont acceptés'));
  },
});

// List all skins
app.get('/api/skins', requireAdmin, async (req, res) => {
  try {
    const { rows: skins } = await pool.query('SELECT * FROM skins ORDER BY created_at ASC');
    // Get image keys for each skin
    for (const skin of skins) {
      const { rows: imgs } = await pool.query('SELECT image_key FROM skin_images WHERE skin_id = $1', [skin.id]);
      skin.images = imgs.map(i => i.image_key);
    }
    res.json(skins);
  } catch (err) {
    console.error('List skins error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Create new skin
app.post('/api/skins', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.length > 50) return res.status(400).json({ error: 'Nom requis (max 50 caractères)' });
    const { rows } = await pool.query('INSERT INTO skins (name) VALUES ($1) RETURNING *', [name]);
    rows[0].images = [];
    res.json(rows[0]);
  } catch (err) {
    console.error('Create skin error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Delete skin
app.delete('/api/skins/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM skins WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete skin error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Upload image for a skin slot
app.post('/api/skins/:id/images/:key', requireAdmin, skinUpload.single('image'), async (req, res) => {
  try {
    const { id, key } = req.params;
    if (!SKIN_IMAGE_KEYS.includes(key)) return res.status(400).json({ error: 'Clé image invalide' });
    if (!req.file) return res.status(400).json({ error: 'Fichier image requis' });
    await pool.query(
      'INSERT INTO skin_images (skin_id, image_key, file_data, file_mimetype) VALUES ($1, $2, $3, $4) ON CONFLICT (skin_id, image_key) DO UPDATE SET file_data = $3, file_mimetype = $4',
      [id, key, req.file.buffer, req.file.mimetype]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Upload skin image error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Remove image from skin slot
app.delete('/api/skins/:id/images/:key', requireAdmin, async (req, res) => {
  try {
    const { id, key } = req.params;
    await pool.query('DELETE FROM skin_images WHERE skin_id = $1 AND image_key = $2', [id, key]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete skin image error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Activate a skin
app.post('/api/skins/:id/activate', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE skins SET is_active = FALSE');
    if (id !== '0') {
      await pool.query('UPDATE skins SET is_active = TRUE WHERE id = $1', [id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Activate skin error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Serve skin image (public — needed by the player)
app.get('/api/skins/:id/images/:key', async (req, res) => {
  try {
    const { id, key } = req.params;
    const { rows } = await pool.query(
      'SELECT file_data, file_mimetype FROM skin_images WHERE skin_id = $1 AND image_key = $2',
      [id, key]
    );
    if (!rows.length || !rows[0].file_data) return res.status(404).json({ error: 'Image non trouvée' });
    res.set({
      'Content-Type': rows[0].file_mimetype || 'image/png',
      'Content-Length': rows[0].file_data.length,
      'Cache-Control': 'public, max-age=3600',
    });
    res.send(rows[0].file_data);
  } catch (err) {
    console.error('Serve skin image error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Get active skin info (public — player uses this to load skin)
app.get('/api/active-skin', async (req, res) => {
  try {
    const { rows: skins } = await pool.query('SELECT id, name FROM skins WHERE is_active = TRUE LIMIT 1');
    if (!skins.length) return res.json({ id: null, name: 'Défaut', images: {} });
    const skin = skins[0];
    const { rows: imgs } = await pool.query('SELECT image_key FROM skin_images WHERE skin_id = $1', [skin.id]);
    const images = {};
    for (const img of imgs) {
      images[img.image_key] = `/api/skins/${skin.id}/images/${img.image_key}`;
    }
    res.json({ id: skin.id, name: skin.name, images });
  } catch (err) {
    console.error('Active skin error:', err);
    res.json({ id: null, name: 'Défaut', images: {} });
  }
});

// ===== START =====
initDB().then(async () => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  // Start Twitch bot
  await startTwitchBot();
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
