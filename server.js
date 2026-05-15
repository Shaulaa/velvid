const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
const PORT = 3001;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const YTDLP = fs.existsSync(path.join(__dirname, 'yt-dlp.exe'))
  ? path.join(__dirname, 'yt-dlp.exe')
  : 'yt-dlp';

function findLocalFfmpeg() {
  const candidates = [
    path.join(__dirname, 'ffmpeg.exe'),
    path.join(__dirname, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join(__dirname, 'ffmpeg-8.1', 'bin', 'ffmpeg.exe'),
    path.join(__dirname, 'ffmpeg-8.1', 'ffmpeg-8.1', 'bin', 'ffmpeg.exe')
  ];
  const local = candidates.find(fs.existsSync);
  if (local) return local;

  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  const pathMatch = pathDirs
    .map(dir => path.join(dir, 'ffmpeg.exe'))
    .find(fs.existsSync);
  if (pathMatch) return pathMatch;

  const wingetDir = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft',
    'WinGet',
    'Packages'
  );
  if (!fs.existsSync(wingetDir)) return '';

  const stack = [wingetDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'ffmpeg.exe') {
        return fullPath;
      }
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }

  return '';
}

const FFMPEG = findLocalFfmpeg();

app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(DOWNLOAD_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/styles.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'styles.css'));
});

app.get('/script.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'script.js'));
});

// ─── GET /api/thumbnail ────────────────────────────────────────
app.get('/api/thumbnail', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL diperlukan');
  try {
    const parsed = new URL(url);
    const proto = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': parsed.origin
      }
    };
    proto.get(options, (imgRes) => {
      res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      imgRes.pipe(res);
    }).on('error', () => res.status(500).send('Gagal fetch thumbnail'));
  } catch {
    res.status(400).send('URL tidak valid');
  }
});

// ─── Cek yt-dlp tersedia ───────────────────────────────────────
function checkYtDlp() {
  return new Promise((resolve) => {
    exec(`"${YTDLP}" --version`, (err, stdout) => {
      resolve(!err ? stdout.trim() : null);
    });
  });
}

// ─── GET /api/info ─────────────────────────────────────────────
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  const version = await checkYtDlp();
  if (!version) {
    return res.status(500).json({
      error: 'yt-dlp tidak ditemukan. Download yt-dlp.exe dan taruh di folder Velvid.'
    });
  }

  exec(
    `"${YTDLP}" --dump-json --no-playlist "${url}"`,
    { timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) {
        return res.status(400).json({
          error: 'Gagal mengambil info video. Periksa URL dan coba lagi.',
          detail: stderr?.slice(0, 300)
        });
      }
      try {
        const info = JSON.parse(stdout);
        const rawThumb = info.thumbnail || '';
        const thumbnail = rawThumb
          ? `http://localhost:${PORT}/api/thumbnail?url=${encodeURIComponent(rawThumb)}`
          : '';
        res.json({
          title: info.title,
          thumbnail,
          duration: info.duration,
          uploader: info.uploader,
          platform: info.extractor_key,
          formats: (info.formats || [])
            .filter(f => f.ext && (f.vcodec !== 'none' || f.acodec !== 'none'))
            .map(f => ({
              format_id: f.format_id,
              ext: f.ext,
              resolution: f.resolution || (f.height ? `${f.height}p` : 'audio'),
              filesize: f.filesize || f.filesize_approx,
              vcodec: f.vcodec,
              acodec: f.acodec,
              tbr: f.tbr
            }))
            .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))
        });
      } catch (e) {
        res.status(500).json({ error: 'Gagal parse respons video' });
      }
    }
  );
});

// ─── POST /api/download ────────────────────────────────────────
app.post('/api/download', (req, res) => {
  const { url, resolution, format } = req.body;
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  const isTikTok = /tiktok\.com|vt\.tiktok\.com/i.test(url);
  const isAudio = format === 'MP3' || format === 'M4A';
  const hasFfmpeg = Boolean(FFMPEG);
  const outputExt = isAudio
    ? (format?.toLowerCase() || 'mp3')
    : (format?.toLowerCase() || 'mp4');
  const outputTemplate = path.join(DOWNLOAD_DIR, '%(title).60s.%(ext)s');

  if (isAudio && !hasFfmpeg) {
    return res.status(500).json({
      error: 'Download audio butuh ffmpeg.exe. Taruh ffmpeg.exe di folder Velvid atau pilih format MP4/WEBM.'
    });
  }

  // Tentukan format string
  let formatStr;
  if (isAudio) {
    formatStr = 'bestaudio/best';
  } else if (isTikTok) {
    const h = resolution?.replace('p', '') || '720';
    formatStr = `best[height<=${h}]/best`;
  } else if (!hasFfmpeg) {
    const h = resolution?.replace('p', '');
    const extFilter = outputExt === 'webm' ? 'webm' : 'mp4';
    const heightFilter = resolution === 'best' || !h ? '' : `[height<=${h}]`;
    formatStr = `best[ext=${extFilter}]${heightFilter}/best${heightFilter}/best`;
  } else if (resolution === 'best') {
    formatStr = 'bestvideo+bestaudio/best';
  } else {
    const h = resolution?.replace('p', '') || '720';
    formatStr = `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
  }

  // Bangun args — pisah audio vs video
  const args = [
    '--no-playlist',
    '-f', formatStr,
    '-o', outputTemplate,
    '--newline',
    '--retries', '3',
    '--fragment-retries', '3',
    '--no-warnings'
  ];

  if (isAudio) {
    // ✅ Audio: TIDAK pakai --merge-output-format (konflik dengan -x)
    args.push('-x', '--audio-format', outputExt, '--audio-quality', '0');
  } else if (hasFfmpeg) {
    // ✅ Video: merge ke mp4 atau webm
    args.push('--merge-output-format', outputExt === 'webm' ? 'webm' : 'mp4');
  }

  if (hasFfmpeg) {
    args.push('--ffmpeg-location', FFMPEG);
  }

  args.push(url); // URL selalu di akhir

  console.log('[download] CMD:', YTDLP, args.join(' '));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: 'start', message: 'Memulai unduhan...' });

  const proc = spawn(YTDLP, args);
  let filename = '';
  let stderrTail = '';
  let procClosed = false;

  proc.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      const match = line.match(/\[download\]\s+([\d.]+)%.*?(\d+\.\d+\w+\/s)?.*?ETA\s+(\S+)?/);
      if (match) {
        send({ type: 'progress', percent: parseFloat(match[1]), speed: match[2] || '', eta: match[3] || '' });
      }
      const destMatch = line.match(/\[(?:download|Merger|ExtractAudio)\] Destination: (.+)/);
      if (destMatch) filename = path.basename(destMatch[1]);
      const mergeMatch = line.match(/\[Merger\] Merging formats into "(.+)"/);
      if (mergeMatch) filename = path.basename(mergeMatch[1]);
    }
  });

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) {
      console.error('[yt-dlp stderr]', msg);
      stderrTail = (stderrTail + '\n' + msg).slice(-500);
      send({ type: 'log', message: msg.slice(0, 200) });
    }
  });

  proc.on('close', (code) => {
    procClosed = true;
    if (code === 0) {
      // Fallback: ambil file terbaru jika filename belum tertangkap
      if (!filename) {
        try {
          const files = fs.readdirSync(DOWNLOAD_DIR)
            .map(f => ({ name: f, time: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
          if (files.length > 0) filename = files[0].name;
        } catch (_) {}
      }
      send({
        type: 'done',
        message: 'Unduhan selesai!',
        filename,
        downloadUrl: filename ? `/downloads/${encodeURIComponent(filename)}` : null
      });
    } else {
      send({
        type: 'error',
        message: stderrTail || 'Unduhan gagal. Cek URL atau coba resolusi lain.'
      });
    }
    res.end();
  });

  res.on('close', () => {
    if (!procClosed) proc.kill();
  });
});

// ─── GET /api/files ────────────────────────────────────────────
app.get('/api/files', (req, res) => {
  const files = fs.readdirSync(DOWNLOAD_DIR).map(name => {
    const stat = fs.statSync(path.join(DOWNLOAD_DIR, name));
    return { name, size: stat.size, downloadUrl: `/downloads/${encodeURIComponent(name)}`, created: stat.birthtime };
  }).sort((a, b) => new Date(b.created) - new Date(a.created));
  res.json(files);
});

// ─── DELETE /api/files/:name ───────────────────────────────────
app.delete('/api/files/:name', (req, res) => {
  const filePath = path.join(DOWNLOAD_DIR, req.params.name);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'File tidak ditemukan' });
  }
});

// ─── Start server ──────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n✦ Velvid Backend berjalan di http://localhost:${PORT}`);
  console.log(`✦ yt-dlp path: ${YTDLP}`);
  console.log(`✦ ffmpeg path: ${FFMPEG || 'tidak ditemukan, memakai format single-file'}`);
  console.log(`✦ File unduhan disimpan di: ${DOWNLOAD_DIR}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✘ Port ${PORT} sudah dipakai proses lain.`);
    console.log(`  PowerShell: Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force\n`);
    process.exit(1);
  } else {
    throw err;
  }
});
