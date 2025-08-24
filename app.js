/* --- helpers & state --- */
const $ = sel => document.querySelector(sel);
const spinnerTpl = $('#spinnerTpl');

/* Dev mode toggle */
const IS_DEV = true;

/* Hard-coded saved Prompt info */
const PROMPT = {
  id: "pmpt_68a9fbeee5e08197bad62ab3b3af571b00b77a91997c08b9",
  version: "10"
};

const DEV_PROMPT = {
  id: "pmpt_68ab3c7109188194b8e24cfa8522e6f8035e7ed800a5fffb",
  version: "2"
};

const UI = {
  apiKey: $('#apiKey'),
  saveKeyBtn: $('#saveKeyBtn'),
  wikiInput: $('#wikiInput'),
  loadBtn: $('#loadBtn'),
  randomBtn: $('#randomBtn'),
  runBtn: $('#runBtn'),
  pageLink: $('#pageLink'),
  pageStatus: $('#pageStatus'),
  wikitext: $('#wikitext'),
  copyWiki: $('#copyWiki'),
  llmStatus: $('#llmStatus'),
  llmOutput: $('#llmOutput'),
  copyLLM: $('#copyLLM'),
  rawJson: $('#rawJson'),
  rawWrap: $('#rawWrap'),
};

const STATE = {
  title: null,
  url: null,
  wikitext: null,
};

/* --- show dev indicator --- */
if (IS_DEV) {
  document.addEventListener('DOMContentLoaded', () => {
    const devIndicator = document.getElementById('devIndicator');
    if (devIndicator) devIndicator.style.display = 'inline';
  });
}

/* --- persist key --- */
(function initKey(){
  const saved = localStorage.getItem('openai_api_key');
  if (saved) UI.apiKey.value = saved;
  UI.saveKeyBtn.addEventListener('click', () => {
    localStorage.setItem('openai_api_key', UI.apiKey.value.trim());
    UI.saveKeyBtn.textContent = 'Saved';
    setTimeout(() => (UI.saveKeyBtn.textContent = 'Save'), 900);
  });
})();

/* --- events --- */
UI.loadBtn.addEventListener('click', () => loadByInput());
UI.randomBtn.addEventListener('click', () => randomArticle());
UI.runBtn.addEventListener('click', () => runPrompt());
UI.copyWiki.addEventListener('click', () => copyText(STATE.wikitext));
UI.copyLLM.addEventListener('click', () => copyText(UI.llmOutput.textContent));
UI.wikiInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadByInput(); });

/* --- visual helpers --- */
function setBusy(el, busy=true){
  if (!el) return;
  if (busy) {
    el.setAttribute('disabled', 'true');
    const s = spinnerTpl.content.cloneNode(true);
    el.dataset._label = el.textContent;
    el.textContent = '';
    el.appendChild(s);
  } else {
    el.removeAttribute('disabled');
    if (el.dataset._label) el.textContent = el.dataset._label;
  }
}
function setStatus(el, msg){
  el.innerHTML = msg;
}
function copyText(txt){
  if (!txt) return;
  navigator.clipboard.writeText(txt).then(() => {
    toast('Copied!');
  }).catch(() => toast('Copy failed', true));
}
function toast(msg, err=false){
  UI.llmStatus.textContent = msg;
  UI.llmStatus.style.color = err ? 'var(--err)' : 'var(--muted)';
  setTimeout(() => { UI.llmStatus.textContent = ' '; }, 1400);
}

/* --- Wikipedia helpers --- */
function extractRedirectTarget(wikitext){
  if (!wikitext) return null;
  // Match #REDIRECT [[Target]] or #redirect [[Target]] (case insensitive)
  const match = wikitext.match(/^\s*#redirect\s*\[\[([^\]]+)\]\]/i);
  return match ? match[1].trim() : null;
}

function parseInputToTitle(input){
  input = (input || '').trim();
  if (!input) return null;
  try {
    const u = new URL(input);
    // Accept /wiki/Title or /w/index.php?title=Title
    const m = u.pathname.match(/\/wiki\/(.+)/);
    if (m) return decodeURIComponent(m[1]);
    const title = u.searchParams.get('title');
    if (title) return decodeURIComponent(title);
    return input; // fallback
  } catch {
    return input; // plain title typed
  }
}

async function fetchWikitextByTitle(title){
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
    origin: '*', // CORS
  });
  const res = await fetch(`${endpoint}?${params.toString()}`);
  if (!res.ok) throw new Error(`Wikipedia request failed (${res.status})`);
  const data = await res.json();

  const page = data?.query?.pages?.[0];
  if (!page || page.missing) throw new Error('Page not found');
  const wikitext = page?.revisions?.[0]?.slots?.main?.content ?? '';
  const fullurl = page?.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`;

  return { title: page.title, url: fullurl, wikitext };
}

async function randomArticle(){
  UI.randomBtn.classList.add('spin');
  try{
    const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/random/summary');
    if (!res.ok) throw new Error('Failed to get random article');
    const data = await res.json();
    const title = data?.title;
    if (!title) throw new Error('No random title returned');
    UI.wikiInput.value = title;
    await loadByInput();
  } catch (e){
    setStatus(UI.pageStatus, `<span style="color:var(--err)">Random error:</span> ${e.message}`);
  } finally {
    setTimeout(() => UI.randomBtn.classList.remove('spin'), 500);
  }
}

async function loadByInput(){
  const title = parseInputToTitle(UI.wikiInput.value);
  if (!title) { setStatus(UI.pageStatus, 'Please enter a Wikipedia URL or title.'); return; }
  setBusy(UI.loadBtn, true);
  setStatus(UI.pageStatus, 'Loading wikitext…');
  UI.wikitext.textContent = '';
  UI.pageLink.classList.add('hidden');

  try {
    const result = await fetchWikitextByTitle(title);
    
    // Check if this is a redirect
    const redirectTarget = extractRedirectTarget(result.wikitext);
    if (redirectTarget) {
      setStatus(UI.pageStatus, `Following redirect to ${escapeHtml(redirectTarget)}…`);
      const finalResult = await fetchWikitextByTitle(redirectTarget);
      STATE.title = finalResult.title; 
      STATE.url = finalResult.url; 
      STATE.wikitext = finalResult.wikitext;
      UI.wikitext.textContent = finalResult.wikitext || '(Empty wikitext)';
      setStatus(UI.pageStatus, `<span style="color:var(--ok)">Loaded (via redirect):</span> ${escapeHtml(finalResult.title)}`);
      UI.pageLink.href = finalResult.url;
    } else {
      STATE.title = result.title; 
      STATE.url = result.url; 
      STATE.wikitext = result.wikitext;
      UI.wikitext.textContent = result.wikitext || '(Empty wikitext)';
      setStatus(UI.pageStatus, `<span style="color:var(--ok)">Loaded:</span> ${escapeHtml(result.title)}`);
      UI.pageLink.href = result.url;
    }
    UI.pageLink.classList.remove('hidden');
  } catch (e) {
    setStatus(UI.pageStatus, `<span style="color:var(--err)">Error:</span> ${escapeHtml(e.message)}`);
    STATE.title = STATE.url = STATE.wikitext = null;
  } finally {
    setBusy(UI.loadBtn, false);
  }
}

/* --- OpenAI Responses call (Prompt-based) --- */
async function runPrompt(){
  const key = UI.apiKey.value.trim();
  if (!key) { toast('Add your API key', true); return; }
  if (!STATE.wikitext) { toast('Load a Wikipedia page first', true); return; }

  const body = {
    prompt: {
      ...(IS_DEV ? DEV_PROMPT : PROMPT)
    },
    input: STATE.wikitext
  };

  UI.llmOutput.textContent = '';
  UI.rawJson.textContent = '';
  UI.llmStatus.textContent = 'Calling OpenAI…';
  setBusy(UI.runBtn, true);
  UI.rawWrap.open = false;

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await safeJson(res);
      throw new Error(err?.error?.message || `OpenAI error (${res.status})`);
    }

    const data = await res.json();
    const text = extractTextFromResponse(data);
    UI.llmOutput.textContent = text || '(No text output)';
    UI.llmStatus.textContent = 'Done.';
    UI.rawJson.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    UI.llmStatus.textContent = 'Error from OpenAI.';
    UI.llmOutput.textContent = e.message;
  } finally {
    setBusy(UI.runBtn, false);
  }
}

/* Robustly extract text across Responses API variants */
function extractTextFromResponse(resp){
  if (resp && typeof resp.output_text === 'string') return resp.output_text;

  if (Array.isArray(resp?.output)) {
    const parts = [];
    for (const item of resp.output) {
      if (Array.isArray(item?.content)) {
        for (const c of item.content) {
          if (typeof c?.text === 'string') parts.push(c.text);
          if (typeof c?.content === 'string') parts.push(c.content);
        }
      }
      if (typeof item?.text === 'string') parts.push(item.text);
    }
    if (parts.length) return parts.join('\n');
  }

  const choice = resp?.choices?.[0];
  if (typeof choice?.message?.content === 'string') return choice.message.content;
  if (typeof choice?.text === 'string') return choice.text;

  return '';
}

async function safeJson(res){
  try { return await res.json(); } catch { return null; }
}

function escapeHtml(str=''){
  return str.replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[s]));
}
