import {
  AsyncUnzipInflate,
  Unzip,
  UnzipPassThrough,
  AsyncZipDeflate,
  Zip,
  ZipPassThrough,
} from 'fflate';

function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function extLower(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

export const TEXT_EXT_ALLOWLIST = new Set(['html', 'htm', 'xml', 'md', 'txt', 'json', 'csv']);

/**
 * Stream-unzip a Blob/File and invoke per-file handlers without ever allocating
 * one giant ArrayBuffer for the full ZIP.
 */
export async function streamUnzipBlob(blob, { onFile } = {}) {
  const uz = new Unzip((file) => onFile && onFile(file));
  // Register common decoders (deflate + stored)
  uz.register(AsyncUnzipInflate);
  uz.register(UnzipPassThrough);

  const reader = blob.stream().getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // value is a Uint8Array
      uz.push(value, false);
    }
    uz.push(new Uint8Array(0), true);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Scan a ZIP without materializing every file in memory.
 * Only extracts text-ish files; all other entries are skipped.
 *
 * Returns:
 *  - filesScanned: total entries seen in the archive
 *  - linksFound: total links matched (patches)
 *  - linksRewritten: same as linksFound (preview assumes rewriteable)
 *  - samples: up to N {from,to} samples
 *  - detectedHub: first detected hub base url, if any
 */
export async function scanZipBlob(blob, { rewriteText, detectHubRegex, opts, sampleLimit = 10, maxTextBytes = 25 * 1024 * 1024 } = {}) {
  let filesScanned = 0;
  let linksFound = 0;
  let linksRewritten = 0;
  let detectedHub = null;
  const samples = [];

  let openFiles = 0;
  let doneFeeding = false;

  let resolveDone, rejectDone;
  const donePromise = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });

  const maybeFinish = () => {
    if (doneFeeding && openFiles === 0) resolveDone();
  };

  await streamUnzipBlob(blob, {
    onFile(file) {
      filesScanned++;

      const name = file.name || '';
      // directories: add nothing
      if (name.endsWith('/')) return;

      const ext = extLower(name);
      if (!TEXT_EXT_ALLOWLIST.has(ext)) {
        // Skip extracting non-text files to avoid huge memory/time
        return;
      }

      openFiles++;
      const chunks = [];
      let total = 0;

      file.ondata = (err, chunk, final) => {
        if (err) {
          try { file.terminate && file.terminate(); } catch (e) {}
          rejectDone(err);
          return;
        }

        if (chunk && chunk.length) {
          total += chunk.length;
          // Guardrail for pathological "text" files
          if (total > maxTextBytes) {
            rejectDone(new Error(`Text file too large to scan in-browser (${name}, ${Math.round(total / (1024 * 1024))}MB).`));
            try { file.terminate && file.terminate(); } catch (e) {}
            return;
          }
          chunks.push(chunk);
        }

        if (final) {
          try {
            const u8 = concatChunks(chunks, total);
            let text;
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
            } catch (e) {
              // skip binary/non-utf8
              return;
            }

            if (!detectedHub && detectHubRegex) {
              const m = text.match(detectHubRegex);
              if (m) detectedHub = m[0];
            }

            if (rewriteText && opts) {
              const res = rewriteText(text, opts);
              if (res.patches && res.patches.length) {
                linksFound += res.patches.length;
                linksRewritten += res.patches.length;
                for (const p of res.patches) {
                  if (samples.length >= sampleLimit) break;
                  samples.push({ from: p.from, to: p.to });
                }
              }
            }
          } finally {
            openFiles--;
            maybeFinish();
          }
        }
      };

      // Begin extraction
      file.start();
    },
  }).then(() => {
    doneFeeding = true;
    maybeFinish();
  }).catch((e) => {
    rejectDone(e);
  });

  await donePromise;
  return { filesScanned, linksFound, linksRewritten, samples, detectedHub };
}

/**
 * Rewrite and re-zip a ZIP Blob in a streaming fashion:
 * - Non-text files are piped through without buffering.
 * - Text files are buffered, rewritten, then emitted.
 *
 * Returns a Blob of the rewritten ZIP.
 */
export async function rewriteZipBlob(blob, { rewriteText, opts, level = 6, maxTextBytes = 25 * 1024 * 1024 } = {}) {
  if (!rewriteText || !opts) throw new Error('rewriteZipBlob requires rewriteText and opts');

  const outChunks = [];
  let resolveZipFinal, rejectZipFinal;
  const zipFinalPromise = new Promise((res, rej) => { resolveZipFinal = res; rejectZipFinal = rej; });
  let zipFinalSeen = false;

  const zip = new Zip((err, chunk, final) => {
    if (err) {
      rejectZipFinal(err);
      return;
    }
    if (chunk) outChunks.push(chunk);
    if (final && !zipFinalSeen) {
      zipFinalSeen = true;
      resolveZipFinal();
    }
  });

  let openFiles = 0;
  let doneFeeding = false;

  let resolveDone, rejectDone;
  const donePromise = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  const maybeFinish = () => {
    if (doneFeeding && openFiles === 0) {
      try {
        zip.end(); // zipFinalPromise resolves when central directory is emitted
        resolveDone();
      } catch (e) {
        rejectDone(e);
      }
    }
  };

  await streamUnzipBlob(blob, {
    onFile(file) {
      const name = file.name || '';
      openFiles++;

      // Directory entry
      if (name.endsWith('/')) {
        const dir = new ZipPassThrough(name);
        zip.add(dir);
        dir.push(new Uint8Array(0), true);
        openFiles--;
        return;
      }

      const ext = extLower(name);
      const isText = TEXT_EXT_ALLOWLIST.has(ext);

      if (!isText) {
        // Pipe through binary files without buffering
        const zf = new AsyncZipDeflate(name, { level });
        zip.add(zf);
        file.ondata = (err, chunk, final) => {
          if (err) {
            rejectDone(err);
            try { file.terminate && file.terminate(); } catch (e) {}
            return;
          }
          try {
            zf.push(chunk || new Uint8Array(0), !!final);
          } catch (e) {
            rejectDone(e);
          }
          if (final) {
            openFiles--;
            maybeFinish();
          }
        };
        file.start();
        return;
      }

      // Buffer text file, rewrite at end
      const chunks = [];
      let total = 0;
      const zf = new AsyncZipDeflate(name, { level });
      zip.add(zf);

      file.ondata = (err, chunk, final) => {
        if (err) {
          rejectDone(err);
          try { file.terminate && file.terminate(); } catch (e) {}
          return;
        }
        if (chunk && chunk.length) {
          total += chunk.length;
          if (total > maxTextBytes) {
            rejectDone(new Error(`Text file too large to rewrite in-browser (${name}, ${Math.round(total / (1024 * 1024))}MB).`));
            try { file.terminate && file.terminate(); } catch (e) {}
            return;
          }
          chunks.push(chunk);
        }
        if (final) {
          try {
            const u8 = concatChunks(chunks, total);
            let text;
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
            } catch (e) {
              // Non-utf8: write original bytes back
              zf.push(u8, true);
              return;
            }
            const res = rewriteText(text, opts);
            const out = res.changed ? new TextEncoder().encode(res.out) : u8;
            zf.push(out, true);
          } catch (e) {
            rejectDone(e);
          } finally {
            openFiles--;
            maybeFinish();
          }
        }
      };
      file.start();
    },
  }).then(() => {
    doneFeeding = true;
    maybeFinish();
  }).catch((e) => {
    rejectDone(e);
  });

  await donePromise;
  // Ensure the ZIP stream emitted its final chunk (central directory),
  // otherwise the output archive may be truncated/corrupt.
  await zipFinalPromise;
  return new Blob(outChunks, { type: 'application/zip' });
}