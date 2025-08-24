/* --- helpers & state --- */
const $ = sel => document.querySelector(sel);
const spinnerTpl = $('#spinnerTpl');

/* Dev/Prod environment toggle (persisted) */
let ENV = (localStorage.getItem('env') || 'dev');
const isDev = () => ENV === 'dev';
function setEnv(mode){
  ENV = (mode === 'prod') ? 'prod' : 'dev';
  try { localStorage.setItem('env', ENV); } catch {}
  updateEnvUI();
}

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
  toolIndicator: $('#toolIndicator'),
  llmOutput: $('#llmOutput'),
  copyLLM: $('#copyLLM'),
  rawJson: $('#rawJson'),
  rawWrap: $('#rawWrap'),
  articleTitle: $('#articleTitle'),
  envToggle: $('#envToggle'),
  envDev: $('#envDev'),
  envProd: $('#envProd'),
};

const STATE = {
  title: null,
  url: null,
  wikitext: null,
};

/* --- URL helpers (query param for shareable links) --- */
function setQueryParam(key, value, mode = 'replace'){
  try {
    const url = new URL(window.location.href);
    if (value == null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    const newUrl = url.pathname + url.search + url.hash;
    if (mode === 'replace') history.replaceState(null, '', newUrl);
    else history.pushState(null, '', newUrl);
  } catch { /* ignore */ }
}

function getInitialTitleFromQuery(){
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

/* --- dev indicator + toggle wiring --- */
function updateEnvUI(){
  const devIndicator = document.getElementById('devIndicator');
  if (devIndicator) devIndicator.style.display = isDev() ? 'inline' : 'none';
  if (UI.envDev && UI.envProd) {
    UI.envDev.classList.toggle('active', isDev());
    UI.envProd.classList.toggle('active', !isDev());
    UI.envToggle?.setAttribute('aria-label', `Environment: ${isDev() ? 'DEV' : 'PROD'}`);
  }
}
document.addEventListener('DOMContentLoaded', () => {
  updateEnvUI();
  if (UI.envDev && UI.envProd) {
    UI.envDev.addEventListener('click', () => setEnv('dev'));
    UI.envProd.addEventListener('click', () => setEnv('prod'));
  }
});

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

/* --- boot from URL ?title=... if present --- */
document.addEventListener('DOMContentLoaded', () => {
  const qTitle = getInitialTitleFromQuery();
  if (qTitle) {
    UI.wikiInput.value = qTitle;
    loadByInput();
  }
});

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
      if (UI.articleTitle) { UI.articleTitle.textContent = finalResult.title; }
      setQueryParam('title', finalResult.title, 'replace');
    } else {
      STATE.title = result.title; 
      STATE.url = result.url; 
      STATE.wikitext = result.wikitext;
      UI.wikitext.textContent = result.wikitext || '(Empty wikitext)';
      setStatus(UI.pageStatus, `<span style="color:var(--ok)">Loaded:</span> ${escapeHtml(result.title)}`);
      setStatus(UI.pageStatus, `<span style=\"color:var(--ok)\">Loaded.</span>`);
      UI.pageLink.href = result.url;
      if (UI.articleTitle) { UI.articleTitle.textContent = result.title; }
      setQueryParam('title', result.title, 'replace');
    }
    UI.pageLink.classList.remove('hidden');
  } catch (e) {
    setStatus(UI.pageStatus, `<span style="color:var(--err)">Error:</span> ${escapeHtml(e.message)}`);
    STATE.title = STATE.url = STATE.wikitext = null;
    if (UI.articleTitle) { UI.articleTitle.textContent = 'Page'; }
    setQueryParam('title', '', 'replace');
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
      ...(isDev() ? DEV_PROMPT : PROMPT)
    },
    input: STATE.wikitext,
    stream: true
  };

  UI.llmOutput.textContent = '';
  UI.rawJson.textContent = '';
  UI.llmStatus.textContent = 'Calling OpenAI…';
  setBusy(UI.runBtn, true);
  UI.rawWrap.open = false;
  if (UI.toolIndicator) { UI.toolIndicator.classList.add('hidden'); }

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

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      // Stream and handle tool-call events
      await handleStreamResponse(res);
    } else {
      // Fallback: non-streaming JSON
      const data = await res.json();
      const text = extractTextFromResponse(data);
      const cost = calculateCost(data);
      UI.llmOutput.textContent = text || '(No text output)';
      UI.llmStatus.textContent = cost ? `Done. Cost: ${cost}` : 'Done.';
      UI.rawJson.textContent = JSON.stringify(data, null, 2);
    }
  } catch (e) {
    UI.llmStatus.textContent = 'Error from OpenAI.';
    UI.llmOutput.textContent = e.message;
  } finally {
    setBusy(UI.runBtn, false);
  }
}

async function handleStreamResponse(res){
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finalResponse = null;
  let sawTool = false;
  UI.llmOutput.textContent = '';
  UI.llmStatus.textContent = 'Generating…';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      // Parse SSE frame
      let event = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      const dataStr = dataLines.join('\n');
      if (!dataStr) continue;
      let payload;
      try { payload = JSON.parse(dataStr); } catch { continue; }
      // Detect tool calls by event name or payload shape
      if (!sawTool && (/tool/i.test(event) || hasToolCall(payload))) {
        sawTool = true;
        if (UI.toolIndicator) UI.toolIndicator.classList.remove('hidden');
        UI.toolIndicator && (UI.toolIndicator.textContent = 'Tool called!');
      }
      // Text deltas
      if (event === 'response.output_text.delta' && typeof payload.delta === 'string') {
        UI.llmOutput.textContent += payload.delta;
      }
      // Completed: final object may be present
      if (event === 'response.completed' && payload?.response) {
        finalResponse = payload.response;
      }
      // Error
      if (event === 'response.error') {
        throw new Error(payload?.error?.message || 'Streaming error');
      }
    }
  }
  if (finalResponse) {
    UI.rawJson.textContent = JSON.stringify(finalResponse, null, 2);
    const cost = calculateCost(finalResponse);
    UI.llmStatus.textContent = cost ? `Done. Cost: ${cost}` : 'Done.';
  } else {
    UI.llmStatus.textContent = 'Done.';
  }
}

function hasToolCall(obj){
  try {
    if (!obj || typeof obj !== 'object') return false;
    // Check common shapes
    if (obj.type === 'tool_call' || obj.event === 'tool_call') return true;
    if (Array.isArray(obj?.output)) {
      return obj.output.some(x => x?.type === 'tool_call' || Array.isArray(x?.content) && x.content.some(c => c?.type === 'tool_call'));
    }
    if (obj?.delta && typeof obj.delta === 'object' && (obj.delta.type === 'tool_call' || /tool/i.test(obj.delta.type || ''))) return true;
    return false;
  } catch { return false; }
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

/* --- Pricing & cost calc for GPT-5 family --- */
/* Rates are USD per 1M tokens (official OpenAI pricing) */
const PRICING = {
  'gpt-5':      { input: 1.25,  cached: 0.125, output: 10.00 },
  'gpt-5-mini': { input: 0.25,  cached: 0.025, output:  2.00 },
  'gpt-5-nano': { input: 0.05,  cached: 0.005, output:  0.40 },
  // alias for chat-latest, same as gpt-5
  'gpt-5-chat': { input: 1.25,  cached: 0.125, output: 10.00 },
};

function detectModelFamily(resp){
  const m = (resp?.model || '').toLowerCase();
  if (m.includes('gpt-5-mini')) return 'gpt-5-mini';
  if (m.includes('gpt-5-nano')) return 'gpt-5-nano';
  if (m.includes('gpt-5-chat')) return 'gpt-5-chat';
  if (m.includes('gpt-5')) return 'gpt-5';
  // Fallback by environment if model string is missing:
  return isDev() ? 'gpt-5-mini' : 'gpt-5';
}

/**
 * Calculates total $ cost using:
 *   non-cached input @ input rate
 * + cached input @ cached rate
 * + output @ output rate
 * Works with Responses API (usage.input_tokens / output_tokens) and
 * legacy Chat Completions-style (prompt_tokens / completion_tokens).
 */
function calculateCost(resp){
  try {
    const u = resp?.usage || resp?.choices?.[0]?.usage || {};
    const inputTokens =
      (typeof u.input_tokens === 'number') ? u.input_tokens :
      (typeof u.prompt_tokens === 'number') ? u.prompt_tokens : 0;

    const cachedTokens =
      (typeof u?.input_tokens_details?.cached_tokens === 'number') ? u.input_tokens_details.cached_tokens :
      (typeof u?.prompt_tokens_details?.cached_tokens === 'number') ? u.prompt_tokens_details.cached_tokens : 0;

    const outputTokens =
      (typeof u.output_tokens === 'number') ? u.output_tokens :
      (typeof u.completion_tokens === 'number') ? u.completion_tokens : 0;

    const family = detectModelFamily(resp);
    const rate = PRICING[family];
    if (!rate) return '';

    const nonCached = Math.max(0, inputTokens - cachedTokens);

    const costInput  = ((nonCached * rate.input)  / 1_000_000) + ((cachedTokens * rate.cached) / 1_000_000);
    const costOutput =  (outputTokens * rate.output) / 1_000_000;
    const total = costInput + costOutput;

    const fmt = v => '$' + v.toFixed(6);
    // In dev, include a short breakdown & token counts; in prod just the total.
    return isDev()
      ? `${fmt(total)} (input ${fmt(costInput)} + output ${fmt(costOutput)}) • ${family} • in:${inputTokens} (cached:${cachedTokens}) out:${outputTokens}`
      : fmt(total);
  } catch {
    return '';
  }
}
