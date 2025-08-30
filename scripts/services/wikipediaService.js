// wikipediaService.js
// Wikipedia API helpers for fetching and parsing Wikipedia content.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse arbitrary user input (URL or plain text) into a Wikipedia page title.
 * @param {string} input
 * @returns {string|null}
 */
export function parseInputToTitle(input) {
  const s = (input ?? '').trim();
  if (!s) return null;

  // Try URL first
  try {
    const u = new URL(s);
    // ".../wiki/<Title>" form
    const m = u.pathname.match(/\/wiki\/(.+)/);
    if (m) return decodeURIComponent(m[1]);
    // "...?title=<Title>" form
    const title = u.searchParams.get('title');
    if (title) return decodeURIComponent(title);
    // If it was a URL but not a Wikipedia pattern, fall through to plain text
  } catch {}

  // Plain text or non-Wikipedia URL
  return s;
}

/**
 * If the wikitext is a redirect, return the target title; otherwise null.
 * @param {string} wikitext
 */
export function extractRedirectTarget(wikitext) {
  if (!wikitext) return null;
  const m = wikitext.match(/^\s*#redirect\s*\[\[([^\]]+)\]\]/i);
  return m ? m[1].trim() : null;
}

/**
 * Fetch the page wikitext by title. Returns { title, url, wikitext }.
 * Throws if the page is missing or the request fails.
 * @param {string} title
 */
export async function fetchWikitextByTitle(title) {
  const endpoint = 'https://en.wikipedia.org/w/api.php';
  const params = new URLSearchParams({
    action: 'query',
    prop: 'revisions|info',
    rvprop: 'content',
    rvslots: 'main',
    inprop: 'url',
    titles: title,
    formatversion: '2',
    format: 'json',
    origin: '*',
  });

  const res = await fetch(`${endpoint}?${params}`);
  if (!res.ok) throw new Error(`Wikipedia request failed (${res.status})`);
  const data = await res.json();

  const page = data?.query?.pages?.[0];
  if (!page || page.missing) throw new Error('Page not found');

  const wikitext = page?.revisions?.[0]?.slots?.main?.content ?? '';
  const fullurl = page?.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`;
  return { title: page.title, url: fullurl, wikitext };
}

/**
 * Get a random article title.
 */
export async function getRandomArticleTitle() {
  const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/random/summary');
  if (!res.ok) throw new Error('Failed to get random article');
  const data = await res.json();
  const title = data?.title;
  if (!title) throw new Error('No random title returned');
  return title;
}