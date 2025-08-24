// services.js
// Pure "service" functions for Wikipedia + OpenAI. No direct DOM access.

import { safeJson } from './utils.js';

/* ---------- Wikipedia service ---------- */

export function parseInputToTitle(input) {
  input = (input || '').trim();
  if (!input) return null;
  try {
    const u = new URL(input);
    const m = u.pathname.match(/\/wiki\/(.+)/);
    if (m) return decodeURIComponent(m[1]);
    const title = u.searchParams.get('title');
    if (title) return decodeURIComponent(title);
    return input;
  } catch {
    return input; // plain title typed
  }
}

export function extractRedirectTarget(wikitext) {
  if (!wikitext) return null;
  const match = wikitext.match(/^\s*#redirect\s*\[\[([^\]]+)\]\]/i);
  return match ? match[1].trim() : null;
}

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
  const res = await fetch(`${endpoint}?${params.toString()}`);
  if (!res.ok) throw new Error(`Wikipedia request failed (${res.status})`);
  const data = await res.json();

  const page = data?.query?.pages?.[0];
  if (!page || page.missing) throw new Error('Page not found');
  const wikitext = page?.revisions?.[0]?.slots?.main?.content ?? '';
  const fullurl = page?.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`;

  return { title: page.title, url: fullurl, wikitext };
}

export async function getRandomArticleTitle() {
  const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/random/summary');
  if (!res.ok) throw new Error('Failed to get random article');
  const data = await res.json();
  const title = data?.title;
  if (!title) throw new Error('No random title returned');
  return title;
}

/* ---------- OpenAI service ---------- */

const PROMPT = {
  id: 'pmpt_68a9fbeee5e08197bad62ab3b3af571b00b77a91997c08b9',
  version: '10',
};
const DEV_PROMPT = {
  id: 'pmpt_68ab3c7109188194b8e24cfa8522e6f8035e7ed800a5fffb',
  version: '2',
};

// USD per 1M tokens
const PRICING = {
  'gpt-5':      { input: 1.25,  cached: 0.125, output: 10.00 },
  'gpt-5-mini': { input: 0.25,  cached: 0.025, output:  2.00 },
  'gpt-5-nano': { input: 0.05,  cached: 0.005, output:  0.40 },
  'gpt-5-chat': { input: 1.25,  cached: 0.125, output: 10.00 },
};

function detectModelFamily(resp, devMode) {
  const m = (resp?.model || '').toLowerCase();
  if (m.includes('gpt-5-mini')) return 'gpt-5-mini';
  if (m.includes('gpt-5-nano')) return 'gpt-5-nano';
  if (m.includes('gpt-5-chat')) return 'gpt-5-chat';
  if (m.includes('gpt-5')) return 'gpt-5';
  return devMode ? 'gpt-5-mini' : 'gpt-5';
}

function calculateCost(resp, devMode) {
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

    const family = detectModelFamily(resp, devMode);
    const rate = PRICING[family];
    if (!rate) return '';

    const nonCached = Math.max(0, inputTokens - cachedTokens);
    const costInput  = ((nonCached * rate.input)  / 1_000_000) + ((cachedTokens * rate.cached) / 1_000_000);
    const costOutput =  (outputTokens * rate.output) / 1_000_000;
    const total = costInput + costOutput;

    const fmt = v => '$' + v.toFixed(6);
    return devMode
      ? `${fmt(total)} (input ${fmt(costInput)} + output ${fmt(costOutput)}) • ${family} • in:${inputTokens} (cached:${cachedTokens}) out:${outputTokens}`
      : fmt(total);
  } catch {
    return '';
  }
}

function hasToolCall(obj) {
  try {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.type === 'tool_call' || obj.event === 'tool_call') return true;
    if (Array.isArray(obj?.output)) {
      return obj.output.some(x =>
        x?.type === 'tool_call' ||
        (Array.isArray(x?.content) && x.content.some(c => c?.type === 'tool_call'))
      );
    }
    if (obj?.delta && typeof obj.delta === 'object' && (obj.delta.type === 'tool_call' || /tool/i.test(obj.delta.type || ''))) {
      return true;
    }
    return false;
  } catch { return false; }
}

function extractTextFromResponse(resp) {
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

async function handleStreamResponse(res, { onText, onStatus, onTool, onRaw }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finalResponse = null;
  let sawTool = false;

  onStatus?.('Generating…');

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

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

      if (!sawTool && (/tool/i.test(event) || hasToolCall(payload))) {
        sawTool = true;
        onTool?.();
      }
      if (event === 'response.output_text.delta' && typeof payload.delta === 'string') {
        onText?.(payload.delta);
      }
      if (event === 'response.completed' && payload?.response) {
        finalResponse = payload.response;
      }
      if (event === 'response.error') {
        throw new Error(payload?.error?.message || 'Streaming error');
      }
    }
  }

  if (finalResponse) onRaw?.(finalResponse);
  return finalResponse;
}

export async function runResponses({
  apiKey,
  wikitext,
  devMode = false,
}, {
  onText,     // (delta) => void
  onStatus,   // (msg) => void
  onTool,     // () => void
  onDone,     // (costString) => void
  onRaw,      // (finalJson) => void
  onError,    // (errorMessage) => void
} = {}) {
  if (!apiKey) { onError?.('Add your API key'); return; }
  if (!wikitext) { onError?.('Load a Wikipedia page first'); return; }

  const body = {
    prompt: { ...(devMode ? DEV_PROMPT : PROMPT) },
    input: wikitext,
    stream: true,
  };

  onText?.(''); // clear
  onStatus?.('Calling OpenAI…');

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await safeJson(res);
      throw new Error(err?.error?.message || `OpenAI error (${res.status})`);
    }

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      const finalResponse = await handleStreamResponse(res, { onText, onStatus, onTool, onRaw });
      const cost = finalResponse ? calculateCost(finalResponse, devMode) : '';
      onStatus?.(cost ? `Done. Cost: ${cost}` : 'Done.');
      onDone?.(cost);
    } else {
      const data = await res.json();
      const text = extractTextFromResponse(data);
      const cost = calculateCost(data, devMode);
      onText?.(text || '(No text output)');
      onStatus?.(cost ? `Done. Cost: ${cost}` : 'Done.');
      onRaw?.(data);
      onDone?.(cost);
    }
  } catch (e) {
    onStatus?.('Error from OpenAI.');
    onError?.(e.message);
  }
}
