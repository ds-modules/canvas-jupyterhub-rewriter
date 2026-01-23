# canvas-jupyterhub-rewriter
Migrate Canvas course exports between JupyterHubs by rewriting hub and GitHub repo links directly in the browser.

## Usage

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open the URL provided (usually `http://localhost:5173`).

### CLI (recommended for very large exports / browser memory errors)
If you see errors like **"Array buffer allocation failed"** in the browser, use the streaming CLI instead:

```bash
npm run rewrite -- \
  --in input.imscc \
  --out output-rewritten.imscc \
  --newHub "https://YOUR-HUB/hub/" \
  --newRepo "https://github.com/YOUR-ORG/YOUR-REPO"
```

Optional flags:
- `--oldHub "https://OLD-HUB/hub/"` and `--oldRepo "https://github.com/OLD/REPO"` if you want stricter matching
- `--scan` to scan without writing output
- `--maxTextMB 50` to raise the per-text-file buffer limit (default 25MB)

### Validate output before uploading to Canvas
If Canvas reports `Zip end of central directory signature not found`, the file is truncated/corrupt. You can validate locally:

```bash
python -m zipfile -t YOUR-FILE.imscc
```

## Privacy Note
All processing happens locally in your browser. Files are never uploaded or stored on any server.
