import {scanZipBlob, rewriteZipBlob} from './zip.js';
import {rewriteText} from './rewrite.js';

const fileInput = document.getElementById('file');
const scanBtn = document.getElementById('scan');
const rewriteBtn = document.getElementById('rewrite');
const resetBtn = document.getElementById('reset');
const newHubInput = document.getElementById('newHub');
const newRepoInput = document.getElementById('newRepo');
const oldHubInput = document.getElementById('oldHub');
const oldRepoInput = document.getElementById('oldRepo');
const themeToggle = document.getElementById('themeToggle');

const filesScannedEl = document.getElementById('filesScanned');
const linksFoundEl = document.getElementById('linksFound');
const linksRewrittenEl = document.getElementById('linksRewritten');
const samplesEl = document.getElementById('samples');

let lastZipMap = null; // Map filename->Uint8Array

scanBtn.addEventListener('click', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return alert('Select a .imscc or .zip file first');
  const newHub = newHubInput.value.trim();
  const newRepo = newRepoInput.value.trim();
  if (!newHub || !newRepo) return alert('New Hub and New Repo are required');

  setLoading(true, scanBtn, 'Scanning...');
  try {
    samplesEl.innerHTML = '';
    const opts = {
      oldHub: oldHubInput.value || null,
      newHub,
      oldRepo: oldRepoInput.value || null,
      newRepo,
    };

    const detectHubRegex = /https?:\/\/[\w@:\-\.\/%_\+\?=&;~#,'!\(\)\[\]]*?\/hub\//i;
    const res = await scanZipBlob(file, { rewriteText, detectHubRegex, opts, sampleLimit: 10 });

    lastZipMap = null; // no longer used; keep variable for minimal diff

    // Auto-detect if fields are empty
    if (res.detectedHub && !oldHubInput.value) oldHubInput.value = res.detectedHub;

    for (const p of res.samples) {
      if (samplesEl.children.length >= 10) break;
      const d = document.createElement('div');
      d.className = 'sample-item';
      d.innerHTML = `
        <div><strong>Original:</strong> <pre>${escapeHtml(p.from)}</pre></div>
        <div><strong>Rewritten:</strong> <pre>${escapeHtml(p.to)}</pre></div>
      `;
      samplesEl.appendChild(d);
    }

    filesScannedEl.textContent = res.filesScanned.toString();
    linksFoundEl.textContent = res.linksFound.toString();
    linksRewrittenEl.textContent = res.linksRewritten.toString();
    rewriteBtn.disabled = res.linksRewritten === 0;
    resetBtn.style.display = 'inline-block';
  } catch (err) {
    console.error(err);
    let msg = (err && err.message) ? err.message : String(err);
    if (/array buffer allocation failed|out of memory/i.test(msg)) {
      msg += '\n\nThis is usually caused by loading the entire ZIP into RAM. This app now streams ZIPs, but extremely large exports can still exceed browser memory (especially during re-zipping). If possible, try a smaller export (remove large media) or run a Node-based rewrite on a machine with more memory.';
    }
    alert('Error scanning file: ' + msg);
  } finally {
    setLoading(false, scanBtn, 'Scan & Preview');
  }
});

rewriteBtn.addEventListener('click', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return alert('Select a .imscc or .zip file first');
  const newHub = newHubInput.value.trim();
  const newRepo = newRepoInput.value.trim();
  if (!newHub || !newRepo) return alert('New Hub and New Repo are required');

  setLoading(true, rewriteBtn, 'Processing...');
  try {
    const opts = {
      oldHub: oldHubInput.value || null,
      newHub,
      oldRepo: oldRepoInput.value || null,
      newRepo,
    };
    const blob = await rewriteZipBlob(file, { rewriteText, opts, level: 6 });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (fileInput.files && fileInput.files[0] && fileInput.files[0].name) ? fileInput.files[0].name.replace(/\.zip$|\.imscc$/i, '') + '-rewritten.imscc' : 'rewritten.imscc';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    let msg = (err && err.message) ? err.message : String(err);
    if (/array buffer allocation failed|out of memory/i.test(msg)) {
      msg += '\n\nThis is usually a browser memory limit. Consider exporting without large media, or run the rewrite on a machine with more memory.';
    }
    alert('Error rewriting file: ' + msg);
  } finally {
    setLoading(false, rewriteBtn, 'Rewrite & Download');
  }
});

resetBtn.addEventListener('click', () => {
  fileInput.value = '';
  lastZipMap = null;
  filesScannedEl.textContent = '0';
  linksFoundEl.textContent = '0';
  linksRewrittenEl.textContent = '0';
  samplesEl.innerHTML = '';
  rewriteBtn.disabled = true;
  resetBtn.style.display = 'none';
});

const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = loadingOverlay ? loadingOverlay.querySelector('p') : null;

const MIN_LOADING_MS = 600;
let loadingShownAt = 0;
let loadingHideTimer = null;

function setLoading(isLoading, btn, text) {
  if (loadingHideTimer) {
    clearTimeout(loadingHideTimer);
    loadingHideTimer = null;
  }

  if (isLoading) {
    loadingShownAt = Date.now();
    loadingOverlay.style.display = 'flex';
  } else {
    const elapsed = Date.now() - loadingShownAt;
    const remaining = Math.max(0, MIN_LOADING_MS - elapsed);
    if (remaining > 0) {
      loadingHideTimer = setTimeout(() => {
        loadingOverlay.style.display = 'none';
        loadingHideTimer = null;
      }, remaining);
    } else {
      loadingOverlay.style.display = 'none';
    }
  }

  if (btn && text) {
    btn.disabled = isLoading;
    btn.textContent = text;
  }
  if (loadingText) loadingText.textContent = text || (isLoading ? 'Loading...' : '');
}

function escapeHtml(s){
  return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  let next = 'light';
  
  if (current === 'light') next = 'dark';
  else if (current === 'dark') next = 'light';
  else next = systemDark ? 'light' : 'dark';

  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});
