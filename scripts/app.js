// app.js
// Wires UI to services. Keep HTML IDs identical to your original page.

import { $, setBusy, setStatus, setQueryParam, getInitialTitleFromQuery, escapeHtml, copyText, showToast } from './utils.js';
import { parseInputToTitle, extractRedirectTarget, fetchWikitextByTitle, getRandomArticleTitle } from './services/wikipediaService.js';
import { runResponses } from './services/openaiService.js';

/* --- DOM handles --- */
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
  toolConsole: $('#toolConsole'),
  llmOutput: $('#llmOutput'),
  copyLLM: $('#copyLLM'),
  articleTitle: $('#articleTitle'),
  envToggle: $('#envToggle'),
  envDev: $('#envDev'),
  envProd: $('#envProd'),
};
const spinnerTpl = $('#spinnerTpl');

/* --- App state --- */
const STATE = { title: null, url: null, wikitext: null };



/* --- Environment toggle (persisted) --- */
let ENV = (localStorage.getItem('env') || 'dev');
const isDev = () => ENV === 'dev';

function setEnv(mode) {
  ENV = (mode === 'prod') ? 'prod' : 'dev';
  try { localStorage.setItem('env', ENV); } catch {}
  updateEnvUI();
}

function updateEnvUI() {
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
  UI.envDev?.addEventListener('click', () => setEnv('dev'));
  UI.envProd?.addEventListener('click', () => setEnv('prod'));
});

/* --- Persist API key --- */
(function initKey() {
  const saved = localStorage.getItem('openai_api_key');
  if (saved) UI.apiKey.value = saved;
  UI.saveKeyBtn?.addEventListener('click', () => {
    localStorage.setItem('openai_api_key', UI.apiKey.value.trim());
    const prev = UI.saveKeyBtn.textContent;
    UI.saveKeyBtn.textContent = 'Saved';
    setTimeout(() => (UI.saveKeyBtn.textContent = prev), 900);
  });
})();

/* --- Boot from URL ?title=... --- */
document.addEventListener('DOMContentLoaded', async () => {
  const qTitle = getInitialTitleFromQuery();
  if (qTitle) {
    UI.wikiInput.value = qTitle;
    await loadByInput();
  }
});

/* --- Events --- */
UI.loadBtn?.addEventListener('click', () => loadByInput());
UI.randomBtn?.addEventListener('click', () => randomArticle());
UI.runBtn?.addEventListener('click', () => runPrompt());
UI.copyWiki?.addEventListener('click', async () => {
  await copyText(STATE.wikitext);
  showToast(UI.llmStatus, 'Copied!');
});
UI.copyLLM?.addEventListener('click', async () => {
  await copyText(UI.llmOutput.textContent);
  showToast(UI.llmStatus, 'Copied!');
});
UI.wikiInput?.addEventListener('keydown', e => { if (e.key === 'Enter') loadByInput(); });

/* --- Wikipedia flows --- */
async function randomArticle() {
  UI.randomBtn?.classList.add('spin');
  try {
    const title = await getRandomArticleTitle();
    UI.wikiInput.value = title;
    await loadByInput();
  } catch (e) {
    setStatus(UI.pageStatus, `<span style="color:var(--err)">Random error:</span> ${e.message}`);
  } finally {
    setTimeout(() => UI.randomBtn?.classList.remove('spin'), 500);
  }
}

async function loadByInput() {
  const title = parseInputToTitle(UI.wikiInput.value);
  if (!title) {
    setStatus(UI.pageStatus, 'Please enter a Wikipedia URL or title.');
    return;
  }

  setBusy(UI.loadBtn, true, spinnerTpl);
  setStatus(UI.pageStatus, 'Loading wikitext…');
  UI.wikitext.textContent = '';
  UI.pageLink.classList.add('hidden');

  try {
    const result = await fetchWikitextByTitle(title);

    const redirectTarget = extractRedirectTarget(result.wikitext);
    if (redirectTarget) {
      setStatus(UI.pageStatus, `Following redirect to ${escapeHtml(redirectTarget)}…`);
      const finalResult = await fetchWikitextByTitle(redirectTarget);
      applyPage(finalResult, true);
    } else {
      applyPage(result, false);
    }
    UI.pageLink.classList.remove('hidden');
  } catch (e) {
    setStatus(UI.pageStatus, `<span style="color:var(--err)">Error:</span> ${escapeHtml(e.message)}`);
    STATE.title = STATE.url = STATE.wikitext = null;
    if (UI.articleTitle) UI.articleTitle.textContent = 'Page';
    setQueryParam('title', '', 'replace');
  } finally {
    setBusy(UI.loadBtn, false, spinnerTpl);
  }
}

function applyPage({ title, url, wikitext }, viaRedirect) {
  STATE.title = title;
  STATE.url = url;
  STATE.wikitext = wikitext;

  UI.wikitext.textContent = wikitext || '(Empty wikitext)';
  setStatus(
    UI.pageStatus,
    viaRedirect
      ? `<span style="color:var(--ok)">Loaded (via redirect):</span> ${escapeHtml(title)}`
      : `<span style="color:var(--ok)">Loaded.</span>`
  );
  UI.pageLink.href = url;
  if (UI.articleTitle) UI.articleTitle.textContent = title;
  setQueryParam('title', title, 'replace');
}


/* --- OpenAI run --- */
async function runPrompt() {
  const key = UI.apiKey.value.trim();
  if (!key) { showToast(UI.llmStatus, 'Add your API key', true); return; }
  if (!STATE.wikitext) { showToast(UI.llmStatus, 'Load a Wikipedia page first', true); return; }

  UI.llmOutput.textContent = '';
  if (UI.toolConsole) UI.toolConsole.innerHTML = '';

  setBusy(UI.runBtn, true, spinnerTpl);

  await runResponses(
    { apiKey: key, wikitext: STATE.wikitext, devMode: isDev() },
    {
      onText: (deltaOrFull) => {
        // If streaming: this is delta; if non-streaming: final text.
        UI.llmOutput.textContent += deltaOrFull;
      },
      onStatus: (msg) => { UI.llmStatus.textContent = msg; },
      onSearch: (searchString) => {
        appendToolLinks(searchString);
      },
      onError: (errMsg) => {
        UI.llmOutput.textContent = errMsg;
        showToast(UI.llmStatus, 'Error from OpenAI.', true);
      },
    }
  );

  setBusy(UI.runBtn, false, spinnerTpl);
}

const appendToolLinks = (searchString) => {
  UI.toolConsole.innerHTML += `<div>${searchString}</div>`
}