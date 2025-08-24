// utils.js
// Small, framework-free helpers. No UI globals.

export const $ = sel => document.querySelector(sel);

export function setQueryParam(key, value, mode = 'replace') {
  try {
    const url = new URL(window.location.href);
    if (value == null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    const newUrl = url.pathname + url.search + url.hash;
    if (mode === 'replace') history.replaceState(null, '', newUrl);
    else history.pushState(null, '', newUrl);
  } catch { /* ignore */ }
}

export function getInitialTitleFromQuery() {
  try {
    const url = new URL(window.location.href);
    return (
      url.searchParams.get('title') ||
      url.searchParams.get('q') ||
      url.searchParams.get('article') ||
      ''
    );
  } catch { return ''; }
}

export function escapeHtml(str = '') {
  return str.replace(/[&<>"']/g, s => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[s]));
}

export function setBusy(el, busy = true, spinnerTpl = null) {
  if (!el) return;
  if (busy) {
    el.setAttribute('disabled', 'true');
    el.dataset._label = el.textContent;
    el.textContent = '';
    if (spinnerTpl?.content) {
      el.appendChild(spinnerTpl.content.cloneNode(true));
    } else {
      el.textContent = '…';
    }
  } else {
    el.removeAttribute('disabled');
    if (el.dataset._label != null) el.textContent = el.dataset._label;
    delete el.dataset._label;
  }
}

export function setStatus(el, msg) {
  if (!el) return;
  el.innerHTML = msg;
}

export function copyText(txt) {
  if (!txt) return Promise.resolve();
  return navigator.clipboard.writeText(txt);
}

export function showToast(statusEl, msg, isErr = false, timeoutMs = 1400) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.style.color = isErr ? 'var(--err)' : 'var(--muted)';
  setTimeout(() => { statusEl.textContent = ' '; }, timeoutMs);
}

export async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}
