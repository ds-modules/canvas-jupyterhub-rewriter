#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import {
  AsyncUnzipInflate,
  Unzip,
  UnzipPassThrough,
  AsyncZipDeflate,
  Zip,
  ZipPassThrough,
} from 'fflate';

import { rewriteText } from '../src/rewrite.js';

const TEXT_EXT_ALLOWLIST = new Set(['html', 'htm', 'xml', 'md', 'txt', 'json', 'csv']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--in') args.in = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--newHub') args.newHub = argv[++i];
    else if (a === '--newRepo') args.newRepo = argv[++i];
    else if (a === '--oldHub') args.oldHub = argv[++i];
    else if (a === '--oldRepo') args.oldRepo = argv[++i];
    else if (a === '--level') args.level = Number(argv[++i]);
    else if (a === '--maxTextMB') args.maxTextMB = Number(argv[++i]);
    else if (a === '--scan') args.scan = true;
    else if (a === '--quiet') args.quiet = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function usage() {
  return `
Usage:
  node cli/rewrite.mjs --in input.imscc --out output.imscc --newHub https://.../hub/ --newRepo https://github.com/u/r

Options:
  --in         Input .imscc/.zip path
  --out        Output .imscc path (required unless --scan)
  --newHub     New hub base URL (required unless --scan)
  --newRepo    New repo URL (required unless --scan)
  --oldHub     Old hub base (optional)
  --oldRepo    Old repo URL (optional)
  --level      Zip deflate level (default 6)
  --maxTextMB  Max per-text-file size to buffer (default 25)
  --scan       Scan only (no output). Prints counts + a few samples.
  --quiet      Less logging
`.trim();
}

function extLower(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.in) throw new Error('--in is required');
  if (!args.scan && !args.out) throw new Error('--out is required unless --scan');
  if (!args.scan && (!args.newHub || !args.newRepo)) throw new Error('--newHub and --newRepo are required unless --scan');

  const level = Number.isFinite(args.level) ? args.level : 6;
  const maxTextBytes = (Number.isFinite(args.maxTextMB) ? args.maxTextMB : 25) * 1024 * 1024;

  const opts = args.scan ? null : {
    oldHub: args.oldHub || null,
    newHub: args.newHub,
    oldRepo: args.oldRepo || null,
    newRepo: args.newRepo,
  };

  const rs = fs.createReadStream(args.in);

  let ws = null;
  let zip = null;
  let zipFinalSeen = false;
  let resolveZipFinal, rejectZipFinal;
  const zipFinalPromise = new Promise((res, rej) => { resolveZipFinal = res; rejectZipFinal = rej; });
  let draining = false;
  if (!args.scan) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    ws = fs.createWriteStream(args.out);
    zip = new Zip((err, chunk, final) => {
      if (err) {
        rejectZipFinal(err);
        return;
      }
      if (chunk && ws) {
        const ok = ws.write(chunk);
        if (!ok && !draining) {
          draining = true;
          rs.pause();
          ws.once('drain', () => {
            draining = false;
            rs.resume();
          });
        }
      }
      if (final && !zipFinalSeen) {
        zipFinalSeen = true;
        resolveZipFinal();
      }
    });
  }

  const uz = new Unzip();
  uz.register(AsyncUnzipInflate);
  uz.register(UnzipPassThrough);

  let filesScanned = 0;
  let linksFound = 0;
  const samples = [];

  let openFiles = 0;
  let doneFeeding = false;

  let resolveDone, rejectDone;
  const donePromise = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  const maybeFinish = () => {
    if (!doneFeeding || openFiles !== 0) return;
    try {
      if (zip) zip.end();
      resolveDone();
    } catch (e) {
      rejectDone(e);
    }
  };

  uz.onfile = (file) => {
    filesScanned++;
    const name = file.name || '';

    // Directory entry
    if (name.endsWith('/')) {
      if (zip) {
        const dir = new ZipPassThrough(name);
        zip.add(dir);
        dir.push(new Uint8Array(0), true);
      }
      return;
    }

    openFiles++;
    const ext = extLower(name);
    const isText = TEXT_EXT_ALLOWLIST.has(ext);

    // Scan mode: only read text files and count patches
    if (args.scan) {
      if (!isText) {
        openFiles--;
        return;
      }
      const chunks = [];
      let total = 0;
      file.ondata = (err, chunk, final) => {
        if (err) return rejectDone(err);
        if (chunk && chunk.length) {
          total += chunk.length;
          if (total > maxTextBytes) return rejectDone(new Error(`Text file too large to scan (${name}, ${Math.round(total / (1024 * 1024))}MB). Use --maxTextMB to raise.`));
          chunks.push(chunk);
        }
        if (final) {
          try {
            const u8 = concatChunks(chunks, total);
            let text;
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
            } catch {
              return;
            }
            // In scan mode we need newHub/newRepo to count rewrite patches; if not provided, just detect.
            if (args.newHub && args.newRepo) {
              const tmpOpts = { oldHub: args.oldHub || null, newHub: args.newHub, oldRepo: args.oldRepo || null, newRepo: args.newRepo };
              const res = rewriteText(text, tmpOpts);
              if (res.patches && res.patches.length) {
                linksFound += res.patches.length;
                for (const p of res.patches) {
                  if (samples.length >= 10) break;
                  samples.push({ from: p.from, to: p.to, file: name });
                }
              }
            }
          } finally {
            openFiles--;
            maybeFinish();
          }
        }
      };
      file.start();
      return;
    }

    // Rewrite mode: stream binaries, buffer+rewrite text
    if (!isText) {
      const zf = new AsyncZipDeflate(name, { level });
      zip.add(zf);
      file.ondata = (err, chunk, final) => {
        if (err) return rejectDone(err);
        try {
          zf.push(chunk || new Uint8Array(0), !!final);
        } catch (e) {
          return rejectDone(e);
        }
        if (final) {
          openFiles--;
          maybeFinish();
        }
      };
      file.start();
      return;
    }

    const chunks = [];
    let total = 0;
    const zf = new AsyncZipDeflate(name, { level });
    zip.add(zf);
    file.ondata = (err, chunk, final) => {
      if (err) return rejectDone(err);
      if (chunk && chunk.length) {
        total += chunk.length;
        if (total > maxTextBytes) return rejectDone(new Error(`Text file too large to rewrite (${name}, ${Math.round(total / (1024 * 1024))}MB). Use --maxTextMB to raise.`));
        chunks.push(chunk);
      }
      if (final) {
        try {
          const u8 = concatChunks(chunks, total);
          let text;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
          } catch {
            zf.push(u8, true);
            return;
          }
          const res = rewriteText(text, opts);
          const out = res.changed ? new TextEncoder().encode(res.out) : u8;
          zf.push(out, true);
          if (res.patches && res.patches.length) linksFound += res.patches.length;
        } catch (e) {
          return rejectDone(e);
        } finally {
          openFiles--;
          maybeFinish();
        }
      }
    };
    file.start();
  };

  try {
    await new Promise((resolve, reject) => {
      rs.on('data', (chunk) => {
        try {
          uz.push(chunk, false);
        } catch (e) {
          reject(e);
        }
      });
      rs.on('end', () => resolve());
      rs.on('error', (e) => reject(e));
    });

    doneFeeding = true;
    uz.push(new Uint8Array(0), true);
    maybeFinish();
    await donePromise;

    if (ws) {
      await zipFinalPromise;
      await new Promise((res, rej) => {
        ws.end(() => res());
        ws.on('error', rej);
      });
    }
  } catch (e) {
    if (ws) ws.destroy();
    throw e;
  }

  if (!args.quiet) {
    if (args.scan) {
      console.log(`Files scanned: ${filesScanned}`);
      console.log(`Links found (requires --newHub/--newRepo): ${linksFound}`);
      for (const s of samples) {
        console.log(`\n[${s.file}]\nFROM: ${s.from}\nTO:   ${s.to}`);
      }
    } else {
      console.log(`Wrote: ${args.out}`);
      console.log(`Files scanned: ${filesScanned}`);
      console.log(`Links rewritten: ${linksFound}`);
    }
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});

