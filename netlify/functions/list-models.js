const { json } = require('./_audit-db');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });
  const adminToken = process.env.ADMIN_API_TOKEN;
  if (!adminToken || event.headers['x-admin-token'] !== adminToken) {
    return json(403, { ok: false, error: 'Forbidden' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json(500, { ok: false, error: 'OPENAI_API_KEY not set.' });

  try {
    const resp = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const raw = await resp.json().catch(() => ({}));
    if (!resp.ok) return json(resp.status, { ok: false, error: raw?.error?.message || 'OpenAI models request failed' });

    const models = Array.isArray(raw?.data) ? raw.data.map(m => m.id).sort() : [];
    return json(200, { ok: true, models });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
