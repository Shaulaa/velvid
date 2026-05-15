const API = 'http://localhost:3001';
const placeholders = {
  facebook:'https://www.facebook.com/watch?v=123456789',
  instagram:'https://www.instagram.com/reel/AbCdEfGhIj/',
  tiktok:'https://www.tiktok.com/@user/video/1234567890123'
};
let currentPlatform = 'facebook';
let selectedRes = '720p';
let selectedFmt = 'MP4';
let downloading = false;

function selectTab(el, platform) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  currentPlatform = platform;
  document.getElementById('urlInput').placeholder = placeholders[platform];
  document.getElementById('infoPanel').classList.remove('show');
}

function selectRes(el, res) {
  document.querySelectorAll('.res-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  selectedRes = res;
}

function selectFmt(el) {
  document.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  selectedFmt = el.textContent;
}

async function pasteUrl() {
  try {
    const text = await navigator.clipboard.readText();
    document.getElementById('urlInput').value = text;
    showToast('URL ditempel ✦');
  } catch { showToast('Izinkan akses clipboard'); }
}

function setLoading(state, text) {
  const btn = document.getElementById('dlBtn');
  btn.classList.toggle('loading', state);
  btn.disabled = state;
  document.getElementById('btnText').textContent = text || '✦ Unduh Video';
  document.querySelector('.spin-ring').style.display = state ? 'block' : 'none';
}

async function handleDownload() {
  if (downloading) return;
  const url = document.getElementById('urlInput').value.trim();
  if (!url) { showToast('Masukkan URL video dulu ✦'); return; }

  // Step 1: Ambil info video
  setLoading(true, 'Mengambil info...');
  try {
    const r = await fetch(`${API}/api/info?url=${encodeURIComponent(url)}`);
    const data = await r.json();
    if (!r.ok) { showToast(data.error || 'Gagal ambil info'); setLoading(false); return; }

    // Tampilkan info
    const panel = document.getElementById('infoPanel');
    document.getElementById('infoTitle').textContent = data.title || 'Video';
    document.getElementById('infoMeta').textContent =
      `${data.platform || currentPlatform} · ${data.uploader || ''} · ${formatDur(data.duration)}`;
    if (data.thumbnail) {
      const img = document.getElementById('infoThumb');
      img.src = data.thumbnail;
      img.style.display = 'block';
    }
    panel.classList.add('show');

    // Step 2: Mulai download
    setLoading(true, 'Mengunduh...');
    await startDownload(url);
  } catch (e) {
    showToast('Tidak bisa terhubung ke server. Pastikan server berjalan!');
    setLoading(false);
  }
}

function startDownload(url) {
  return new Promise((resolve) => {
    downloading = true;
    const prog = document.getElementById('progressSection');
    prog.classList.add('show');
    updateProgress(0, '', '');

    fetch(`${API}/api/download`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ url, resolution: selectedRes, format: selectedFmt })
    }).then(async res => {
      if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch {}
        showToast(data.error || 'Unduhan gagal. Coba lagi.');
        downloading = false;
        setLoading(false);
        resolve();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      function read() {
        reader.read().then(({ done, value }) => {
          if (done) { downloading = false; setLoading(false); resolve(); return; }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            try {
              const evt = JSON.parse(line.slice(5).trim());
              handleEvent(evt);
            } catch {}
          }
          read();
        });
      }
      read();
    }).catch(() => {
      showToast('Unduhan gagal. Coba lagi.');
      downloading = false;
      setLoading(false);
      resolve();
    });
  });
}

function handleEvent(evt) {
  if (evt.type === 'progress') {
    updateProgress(evt.percent, evt.speed, evt.eta);
  } else if (evt.type === 'done') {
    updateProgress(100, '', '');
    showToast('Unduhan selesai! ✦');
    setTimeout(() => {
      document.getElementById('progressSection').classList.remove('show');
      loadFiles();
    }, 1200);
  } else if (evt.type === 'error') {
    showToast((evt.message || 'Terjadi kesalahan').slice(0, 180));
    document.getElementById('progressSection').classList.remove('show');
  }
}

function updateProgress(pct, speed, eta) {
  document.getElementById('progFill').style.width = pct + '%';
  document.getElementById('progPct').textContent = Math.floor(pct) + '%';
  document.getElementById('progSpeed').textContent = speed || '';
  document.getElementById('progEta').textContent = eta || '—';
}

async function loadFiles() {
  try {
    const r = await fetch(`${API}/api/files`);
    const files = await r.json();
    const section = document.getElementById('filesSection');
    const list = document.getElementById('fileList');
    if (files.length === 0) {
      section.style.display = 'none'; return;
    }
    section.style.display = 'block';
    list.innerHTML = files.map(f => `
      <div class="file-item" id="fi-${CSS.escape(f.name)}">
        <div class="file-icon">${getExt(f.name)}</div>
        <div class="file-info">
          <div class="file-name">${f.name}</div>
          <div class="file-size">${formatSize(f.size)}</div>
        </div>
        <div class="file-actions">
          <a class="act-btn dl" href="${API}${f.downloadUrl}" download title="Unduh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg>
          </a>
          <button class="act-btn del" title="Hapus" onclick="deleteFile('${f.name}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>
      </div>
    `).join('');
  } catch {}
}

async function deleteFile(name) {
  if (!confirm(`Hapus "${name}"?`)) return;
  await fetch(`${API}/api/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
  loadFiles();
  showToast('File dihapus');
}

function getExt(name) {
  const ext = name.split('.').pop()?.toUpperCase() || '?';
  return ext.slice(0,4);
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes > 1e9) return (bytes/1e9).toFixed(1) + ' GB';
  if (bytes > 1e6) return (bytes/1e6).toFixed(1) + ' MB';
  return (bytes/1e3).toFixed(0) + ' KB';
}

function formatDur(sec) {
  if (!sec) return '';
  const m = Math.floor(sec/60), s = sec%60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// Load files on start
loadFiles();