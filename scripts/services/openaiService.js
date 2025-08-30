// openaiService.js
// OpenAI Responses API helpers with streaming SSE and cost calculations.
// ─────────────────────────────────────────────────────────────────────────────

import { safeJson } from '../utils.js';

const OPENAI_URL = 'https://api.openai.com/v1/responses';

// Stored prompt IDs (leave as-is; swap in your own if desired)
const PROMPT = { id: 'pmpt_68a9fbeee5e08197bad62ab3b3af571b00b77a91997c08b9' };
const DEV_PROMPT = { id: 'pmpt_68ab3c7109188194b8e24cfa8522e6f8035e7ed800a5fffb' };

// Simple pricing table (USD per 1M tokens) by model family
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

function formatUsd(n) { return `$${n.toFixed(2)}`; }

/**
 * Compute an estimated cost string from a Responses API JSON object.
 * Uses usage.input_tokens/output_tokens and input_tokens_details.cached_tokens when present.
 */
function calculateCost(resp, devMode) {
  try {
    const u = resp?.usage ?? {};
    const input = Number(u.input_tokens ?? u.prompt_tokens ?? 0);
    const cached = Number(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);
    const output = Number(u.output_tokens ?? u.completion_tokens ?? 0);

    const family = PRICING[detectModelFamily(resp, devMode)];
    if (!family) return '';

    const nonCached = Math.max(0, input - cached);
    const total = (
      nonCached * family.input +
      cached    * family.cached +
      output    * family.output
    ) / 1_000_000;

    return devMode
      ? `${formatUsd(total)} • in:${input} (cached:${cached}) out:${output}`
      : formatUsd(total);
  } catch {
    return '';
  }
}

/**
 * Stream SSE from the Responses API and emit text/search callbacks.
 * Returns the final response JSON when complete.
 */
async function streamResponsesSSE(res, { onText, onSearch }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let final = null;

  const flushFrame = (frame) => {
    let event = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const dataStr = dataLines.join('\n');
    if (!dataStr) return;

    let payload; try { payload = JSON.parse(dataStr); } catch { return; }

    console.log(event, payload)

    // Text deltas
    if (event === 'response.output_text.delta' && typeof payload.delta === 'string') {
      onText(payload.delta);
    }

    // Web search calls
    if (payload.type === "response.output_item.done" && payload?.item?.type === "web_search_call") {
      const query = payload?.item?.action?.query;
      
      if (query) onSearch(query);
    }

    // Final JSON
    if (event === 'response.completed' && payload?.response) {
      final = payload.response;
    }

    // Surface errors
    if (event === 'response.error') {
      const msg = payload?.error?.message || 'OpenAI streaming error';
      throw new Error(msg);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      flushFrame(frame);
    }
  }

  return final;
}


export async function runResponses({ apiKey, wikitext, devMode = false }, hooks) {
  const { onText, onStatus, onSearch, onError } = hooks;

  if (!apiKey)  { onError('Add your API key'); return; }
  if (!wikitext) { onError('Load a Wikipedia page first'); return; }

  const body = { prompt: { ...(devMode ? DEV_PROMPT : PROMPT) }, input: wikitext, stream: true };

  onText('');               // clear output area
  onStatus('Calling OpenAI…');

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await safeJson(res);
      throw new Error(err?.error?.message || `OpenAI error (${res.status})`);
    }

    const ctype = res.headers.get('content-type') || '';

    // Streaming SSE path
    if (ctype.includes('text/event-stream')) {
      const finalJson = await streamResponsesSSE(res, {
        onText,
        onSearch,
      });

      console.log(finalJson);     

      const cost = finalJson ? calculateCost(finalJson, devMode) : '';
      onStatus(cost ? `Done. Cost: ${cost}` : 'Done.');
      return;
    }
  } catch (e) {
    onStatus('Error from OpenAI.');
    onError(e.message);
  }
}