import {unzipBuffer, zipFiles} from './zip.js';
import {rewriteText, detectFromZipMap} from './rewrite.js';

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
    const ab = await file.arrayBuffer();
    const map = await unzipBuffer(ab);
    lastZipMap = map;

    // Auto-detect if fields are empty
    if (!oldHubInput.value || !oldRepoInput.value) {
      const detected = await detectFromZipMap(map);
      if (detected && !oldHubInput.value) oldHubInput.value = detected;
    }

    let filesScanned = 0;
    let linksFound = 0;
    let linksRewritten = 0;
    samplesEl.innerHTML = '';

    for (const [name, bytes] of map.entries()) {
      filesScanned++;
      // only attempt to decode allowlist extensions
      if (!/\.(html|htm|xml|md|txt|json|csv)$/i.test(name)) continue;
      let text;
      try {
        text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      } catch (e) {
        // skip binary or non-utf8
        continue;
      }

      const res = rewriteText(text, {oldHub: oldHubInput.value || null, newHub, oldRepo: oldRepoInput.value || null, newRepo});
      if (res.patches && res.patches.length) {
        linksFound += res.patches.length;
        linksRewritten += res.patches.length;
        // show up to 10 samples across files
        for (const p of res.patches.slice(0, 10)) {
          if (samplesEl.children.length >= 10) break;
          const d = document.createElement('div');
          d.className = 'sample-item';
          d.innerHTML = `
            <div><strong>Original:</strong> <pre>${escapeHtml(p.from)}</pre></div>
            <div><strong>Rewritten:</strong> <pre>${escapeHtml(p.to)}</pre></div>
          `;
          samplesEl.appendChild(d);
        }
      }
    }

    filesScannedEl.textContent = filesScanned.toString();
    linksFoundEl.textContent = linksFound.toString();
    linksRewrittenEl.textContent = linksRewritten.toString();
    rewriteBtn.disabled = linksRewritten === 0;
    resetBtn.style.display = 'inline-block';
  } catch (err) {
    console.error(err);
    alert('Error scanning file: ' + err.message);
  } finally {
    setLoading(false, scanBtn, 'Scan & Preview');
  }
});

rewriteBtn.addEventListener('click', async () => {
  if (!lastZipMap) return alert('Scan first');
  const newHub = newHubInput.value.trim();
  const newRepo = newRepoInput.value.trim();
  if (!newHub || !newRepo) return alert('New Hub and New Repo are required');

  setLoading(true, rewriteBtn, 'Processing...');
  try {
    const outMap = new Map(lastZipMap);
    let modifiedCount = 0;

    for (const [name, bytes] of lastZipMap.entries()) {
      if (!/\.(html|htm|xml|md|txt|json|csv)$/i.test(name)) continue;

      let text;
      try {
        text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      } catch (e) { continue; }

      const res = rewriteText(text, {oldHub: oldHubInput.value || null, newHub, oldRepo: oldRepoInput.value || null, newRepo});
      
      if (res.changed) {
        modifiedCount++;
        outMap.set(name, new TextEncoder().encode(res.out));
      }
    }

    // zip back
    const zipU8 = await zipFiles(outMap);
    const blob = new Blob([zipU8], {type: 'application/zip'});
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
    alert('Error rewriting file: ' + err.message);
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

function setLoading(isLoading, btn, text) {
  loadingOverlay.style.display = isLoading ? 'flex' : 'none';
  if (btn && text) {
    btn.disabled = isLoading;
    btn.textContent = text;
  }
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
