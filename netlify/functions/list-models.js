const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = { expiresAt: 0, payload: null };
let didLogRaw = false;

const FRIENDLY_LABELS = {
  'gpt-4o-mini': 'Fast (4o mini)',
  'gpt-4.1-mini': 'Balanced (4.1 mini)',
  'gpt-5.4-mini': 'Balanced (5.4 mini)',
  'gpt-5.4': 'Higher accuracy (5.4)',
  'gpt-5.4-nano': 'Fast/cheapest (5.4 nano)',
};

// Prices are optional metadata, not an allowlist. Compatible new text models
// discovered through the Models API should remain selectable even before a
// price has been added here (their cost will be shown as unavailable).
const MODEL_PRICING_PER_MILLION = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-5.4-nano': { input: 0.05, output: 0.4 },
  'gpt-5.4-mini': { input: 0.3, output: 2.5 },
  'gpt-5.4': { input: 2.0, output: 10.0 },
};

function json(statusCode, payload) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
}

function modelIsUsable(id) {
  const m = String(id || '').toLowerCase();
  if (!(m.startsWith('gpt-') || m.startsWith('chatgpt-') || /^o\d/.test(m))) return false;
  const blocked = ['embed', 'image', 'audio', 'moderation', 'deprecated', 'realtime', 'transcribe', 'tts', 'search', 'codex'];
  if (blocked.some(x => m.includes(x))) return false;
  if (m.includes('vision')) return false;
  return true;
}

function toOut(id) {
  return { id, label: FRIENDLY_LABELS[id] || id, pricing_per_million: MODEL_PRICING_PER_MILLION[id] || null };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });

  if (cache.payload && Date.now() < cache.expiresAt) {
    return json(200, { ok: true, models: cache.payload, cached: true });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json(500, { ok: false, error: 'OPENAI_API_KEY not set.' });

  try {
    const resp = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` }
    });

    const raw = await resp.json().catch(() => ({}));
    if (!resp.ok) return json(resp.status, { ok: false, error: raw?.error?.message || 'OpenAI models request failed' });

    const rawIds = Array.isArray(raw?.data) ? raw.data.map(x => x.id).filter(Boolean) : [];

    if (!didLogRaw && process.env.NODE_ENV !== 'production') {
      console.log('[list-models] raw model ids:', rawIds);
      didLogRaw = true;
    }

    const filtered = rawIds.filter(modelIsUsable).sort();
    const payload = filtered.map(toOut);

    cache = { payload, expiresAt: Date.now() + CACHE_TTL_MS };
    return json(200, { ok: true, models: payload, cached: false });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};

exports._test = { modelIsUsable, toOut };
