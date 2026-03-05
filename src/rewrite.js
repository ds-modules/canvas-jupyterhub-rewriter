// Pure rewrite logic for strings. Intended to be small, testable, and deterministic.

const ALLOWED_ENDPOINTS = ['git-sync', 'git-pull'];

export function ensureHubBase(hub) {
  if (!hub) return '';
  hub = hub.trim();
  // normalize to https and ensure trailing /hub/
  hub = hub.replace(/^http:\/\//i, 'https://');
  if (!hub.startsWith('https://')) hub = 'https://' + hub.replace(/^https?:\/\//i, '');
  if (!/\/hub\/?$/.test(hub)) {
    // if ends with /hub/something, trim to include /hub/
    const m = hub.match(/^(https:\/\/[^\/]+).*?(\/hub\/)/i);
    if (m) hub = m[1] + '/hub/';
    else if (hub.endsWith('/')) hub = hub + 'hub/';
    else hub = hub + '/hub/';
  }
  // ensure trailing slash
  if (!hub.endsWith('/')) hub = hub + '/';
  return hub;
}

// Try to pull the repo owner/name from a repo URL like https://github.com/owner/repo
export function repoNameFromUrl(repoUrl) {
  try {
    const u = new URL(repoUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return parts[1];
  } catch (e) {}
  // fallback: last segment
  const m = repoUrl && repoUrl.split('/').filter(Boolean);
  return m && m[m.length - 1];
}

export function rewriteText(text, opts) {
  // opts: {oldHub?, newHub, oldRepo?, newRepo?}
  const patches = [];
  let out = text;
  let changed = false;

  if (!opts || !opts.newHub || !opts.newRepo) {
    return {out, changed: false, patches};
  }

  const newHubBase = ensureHubBase(opts.newHub);
  const oldRepoName = opts.oldRepo ? repoNameFromUrl(opts.oldRepo) : null;
  const newRepoName = repoNameFromUrl(opts.newRepo) || null;

  // regex: find candidate URLs containing /hub/user-redirect/(git-sync|git-pull)
  // do not match past ']' so CDATA terminators (]]>) are not consumed
  const urlRegex = new RegExp(
    'https?:\\/\\/[\\w@:\\.\\/%_\\+\\?=&;~#,\'!()\\[\\]]*?\\/hub\\/user-redirect\\/(?:git-sync|git-pull)[^\\s\"\'<>\\]]*',
    'gi'
  );

  out = out.replace(urlRegex, (orig) => {
    // strip trailing delimiters that may wrap the URL (e.g. CDATA ]] or ]]>) so they are not percent-encoded
    let suffix = '';
    const suffixMatch = orig.match(/(\]\]>|\]\]|\]|\))$/);
    if (suffixMatch) {
      suffix = suffixMatch[0];
      orig = orig.slice(0, -suffix.length);
    }
    // preserve ampersand style
    const usesAmpEscaped = orig.includes('&amp;');
    const normalized = orig.replace(/&amp;/g, '&');
    let parsed;
    try {
      parsed = new URL(normalized);
    } catch (e) {
      // If parsing fails, don't change
      return orig;
    }

    // ensure endpoint
    const seg = parsed.pathname.split('/');
    const last = seg.slice(-1)[0];
    if (!ALLOWED_ENDPOINTS.includes(last)) return orig;

    // Build remainder after '/hub/'
    const hubIndex = parsed.pathname.indexOf('/hub/');
    if (hubIndex === -1) return orig; // shouldn't happen
    const remainder = parsed.pathname.slice(hubIndex + '/hub/'.length) + parsed.search + parsed.hash;

    // Replace repo query param
    const params = new URLSearchParams(parsed.search);
    if (params.has('repo')) {
      // replace repo param with newRepo
      params.set('repo', opts.newRepo);
    }

    // urlpath conditional
    if (params.has('urlpath')) {
      const urlpath = params.get('urlpath');
      if (oldRepoName && newRepoName && urlpath.startsWith('tree/' + oldRepoName + '/')) {
        const replaced = urlpath.replace('tree/' + oldRepoName + '/', 'tree/' + newRepoName + '/');
        params.set('urlpath', replaced);
      }
    }

    // Construct new URL: newHubBase + remainderPath + params
    // remainderPath should not include the leading /
    let remainderPath = parsed.pathname.slice(hubIndex + '/hub/'.length);
    if (parsed.pathname.endsWith('/')) remainderPath = remainderPath.slice(0, -1);

    let newUrl = newHubBase + remainderPath;
    const paramStr = params.toString();
    if (paramStr) newUrl += '?' + paramStr;
    if (parsed.hash) newUrl += parsed.hash;

    // restore &amp; style if needed
    if (usesAmpEscaped) newUrl = newUrl.replace(/&/g, '&amp;');

    if (newUrl !== orig) {
      patches.push({from: orig + suffix, to: newUrl + suffix, loc: -1});
      changed = true;
      return newUrl + suffix;
    }
    return orig + suffix;
  });

  return {out, changed, patches};
}

export async function detectFromZipMap(map) {
  for (const [name, bytes] of map.entries()) {
    if (!/\.(html|htm|xml|md|txt|json|csv)$/i.test(name)) continue;
    try {
      const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      const m = text.match(/https?:\/\/[\w@:\-\.\/%_\+\?=&;~#,'!\(\)\[\]]*?\/hub\//i);
      if (m) return m[0];
    } catch (e) {}
  }
  return null;
}
