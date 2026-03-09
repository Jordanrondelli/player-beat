const express = require('express');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, execSync } = require('child_process');
const { parseBuffer } = require('music-metadata');
const ytdl = require('@distube/ytdl-core');

// Auto-update yt-dlp at startup for reliability
const ytdlpBinPath = path.join(__dirname, 'yt-dlp');
async function ensureYtdlp() {
  try {
    console.log('yt-dlp: checking/downloading latest version...');
    execSync(
      'curl -L --retry 3 --max-time 30 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o ' +
      JSON.stringify(ytdlpBinPath) + ' && chmod +x ' + JSON.stringify(ytdlpBinPath),
      { timeout: 60000, stdio: 'pipe' }
    );
    const ver = execSync(ytdlpBinPath + ' --version', { timeout: 10000, encoding: 'utf8' }).trim();
    console.log('yt-dlp: ready, version', ver);
  } catch (e) {
    console.error('yt-dlp: failed to download/update:', e.message);
  }
}

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

  // Seed default admin if none exists
  const { rows } = await pool.query('SELECT id FROM admin_users LIMIT 1');
  if (rows.length === 0) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    await pool.query('INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)', ['admin', hash]);
    console.log('Default admin created (user: admin)');
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sessions (use PG store in production)
const PgSession = require('connect-pg-simple')(session);
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, secure: false },
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

// Player page (public)
app.get('/player', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin page (admin only)
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// Static assets (CSS, JS, images) — AFTER explicit routes
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ===== AUTH API =====

app.post('/api/login', async (req, res) => {
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

// Submit a track (public)
app.post('/api/queue', upload.single('audio'), async (req, res) => {
  try {
    const { type, title, artist, source_url, submitted_by } = req.body;

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

      // Fetch title/artist via oEmbed
      let ytTitle = title || '';
      let ytArtist = artist || '';
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(source_url)}&format=json`;
        const oembedRes = await fetch(oembedUrl);
        if (oembedRes.ok) {
          const oembedData = await oembedRes.json();
          if (!ytTitle && oembedData.title) ytTitle = oembedData.title;
          if (!ytArtist && oembedData.author_name) ytArtist = oembedData.author_name;
        }
      } catch (e) {
        console.error('YouTube oEmbed error (non-fatal):', e.message);
      }
      if (!ytTitle) ytTitle = 'YouTube Track';

      let fileBuffer = null;
      let fileMime = 'audio/mpeg';

      // Method 1: yt-dlp binary (auto-updated at startup)
      const tmpBase = path.join(uploadDir, `yt-${Date.now()}`);
      try {
        console.log('yt-dlp: downloading audio for', source_url);
        await new Promise((resolve, reject) => {
          execFile(ytdlpBinPath, [
            '-f', 'bestaudio[ext=m4a]/bestaudio/bestaudio',
            '--no-playlist',
            '--max-filesize', '50m',
            '--no-check-certificates',
            '--extractor-args', 'youtube:player_client=web,default',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            '-o', tmpBase + '.%(ext)s',
            source_url
          ], { timeout: 120000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout);
          });
        });
        const candidates = fs.readdirSync(uploadDir)
          .filter(f => f.startsWith(path.basename(tmpBase)))
          .map(f => path.join(uploadDir, f));
        if (candidates.length > 0) {
          const actualFile = candidates[0];
          fileBuffer = fs.readFileSync(actualFile);
          fileMime = actualFile.endsWith('.m4a') ? 'audio/mp4' : actualFile.endsWith('.webm') ? 'audio/webm' : 'audio/mpeg';
          candidates.forEach(f => { try { fs.unlinkSync(f); } catch {} });
          console.log('yt-dlp: downloaded', fileBuffer.length, 'bytes');
        }
      } catch (e) {
        console.error('yt-dlp error:', e.message);
        try {
          fs.readdirSync(uploadDir)
            .filter(f => f.startsWith(path.basename(tmpBase)))
            .forEach(f => fs.unlinkSync(path.join(uploadDir, f)));
        } catch {}
      }

      // Method 2: ytdl-core fallback (pure JS, no binary needed)
      if (!fileBuffer) {
        console.log('yt-dlp failed, trying ytdl-core...');
        try {
          const chunks = [];
          await new Promise((resolve, reject) => {
            const stream = ytdl(source_url, {
              filter: 'audioonly',
              quality: 'highestaudio',
            });
            const timeout = setTimeout(() => {
              stream.destroy();
              reject(new Error('ytdl timeout (2min)'));
            }, 120000);
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => { clearTimeout(timeout); resolve(); });
            stream.on('error', err => { clearTimeout(timeout); reject(err); });
          });
          fileBuffer = Buffer.concat(chunks);
          fileMime = 'audio/webm';
          console.log('ytdl-core: downloaded', fileBuffer.length, 'bytes');
        } catch (e) {
          console.error('ytdl-core error:', e.message);
        }
      }

      // Method 3: cobalt API fallback
      if (!fileBuffer) {
        console.log('ytdl-core failed, trying cobalt API...');
        try {
          const cobaltRes = await fetch('https://api.cobalt.tools/api/json', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify({
              url: source_url,
              isAudioOnly: true,
              aFormat: 'mp3',
              filenamePattern: 'basic',
            }),
          });
          const cobaltData = await cobaltRes.json();
          if (cobaltData.url) {
            const audioRes = await fetch(cobaltData.url, { signal: AbortSignal.timeout(120000) });
            if (audioRes.ok) {
              const arrayBuf = await audioRes.arrayBuffer();
              fileBuffer = Buffer.from(arrayBuf);
              fileMime = 'audio/mpeg';
              console.log('cobalt: downloaded', fileBuffer.length, 'bytes');
            }
          } else {
            console.error('cobalt: no URL in response', cobaltData);
          }
        } catch (e) {
          console.error('cobalt API error:', e.message);
        }
      }

      if (!fileBuffer || fileBuffer.length < 1000) {
        return res.status(400).json({ error: 'Impossible de télécharger l\'audio YouTube. Vérifiez le lien et réessayez.' });
      }

      const { rows } = await pool.query(
        'INSERT INTO queue (type, title, artist, source_url, file_data, file_mimetype, submitted_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, type, title, artist, source_url, submitted_by, status, created_at',
        ['youtube', ytTitle, ytArtist, source_url, fileBuffer, fileMime, submitted_by || 'Anonyme']
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

// Wipe all uploads (admin)
app.delete('/api/queue/wipe-all', requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM queue WHERE type = 'upload'");
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

app.post('/api/votes', async (req, res) => {
  const { type, queue_id } = req.body;
  if (!type || !['fire', 'up', 'down'].includes(type)) {
    return res.status(400).json({ error: 'Type must be fire, up, or down' });
  }
  const amount = type === 'fire' ? 5 : 1;
  if (queue_id) {
    await pool.query(`UPDATE votes SET ${type} = ${type} + $1 WHERE queue_id = $2`, [amount, queue_id]);
    const { rows } = await pool.query('SELECT * FROM votes WHERE queue_id = $1', [queue_id]);
    return res.json(rows[0]);
  }
  res.json({ fire: 0, up: 0, down: 0 });
});

// ===== SETTINGS API =====

app.get('/api/settings', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM settings');
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json(settings);
});

// ===== SERVE AUDIO FROM DB =====
app.get('/api/audio/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT file_data, file_mimetype, title FROM queue WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length || !rows[0].file_data) {
      return res.status(404).json({ error: 'Audio non trouvé' });
    }
    const { file_data, file_mimetype, title } = rows[0];
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
          `UPDATE votes SET ${voteType} = ${voteType} + 1 WHERE queue_id = $1`,
          [queueId]
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

// ===== START =====
initDB().then(async () => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  // Download/update yt-dlp in background (non-blocking)
  ensureYtdlp().catch(() => {});
  // Start Twitch bot
  await startTwitchBot();
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
