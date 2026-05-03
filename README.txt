README – Deploy the v2 regression test page (CSP-safe)
======================================================

Why v2?
- Some Netlify sites send a Content-Security-Policy that blocks inline scripts.
- v2 uses an external JS file (tests.js), so it works without 'unsafe-inline'.

Deploy:
1) Copy these three files into your published folder (same place as index.html), or into /tests/
   - tests.html
   - tests.js
   - testcases.json
2) Commit + push, let Netlify deploy.
3) Visit:
   https://adorable-stardust-c53cd3.netlify.app/tests.html

Notes:
- Default function path is /.netlify/functions/generate-report
- Payload is { "text": "<input>" }
- If you store the files under /tests/ instead of root, keep tests.html referencing ./tests.js and ./testcases.json (it already does).

Benchmarking models for report generation
========================================
- Frontend model dropdown is populated dynamically in `assets/app.js` from `/.netlify/functions/list-models`, with fallback to `gpt-4o-mini`.
- Server-side model validation + default lives in `netlify/functions/generate-report.js` (`ALLOWED_MODELS`, `DEFAULT_MODEL`, and `modelIsUsableForGeneration()`).
- Pricing constants live in `netlify/functions/generate-report.js` (`MODEL_PRICING_PER_MILLION`) and are editable per 1M tokens.
- Estimated cost formula is:
  (input_tokens / 1_000_000 * input_price_per_million) + (output_tokens / 1_000_000 * output_price_per_million)
- Model discovery/filtering is server-side in `netlify/functions/list-models.js` (OpenAI `/v1/models` + include/exclude rules + cache).
- To adjust which models appear, edit `modelIsUsable()` and `FRIENDLY_LABELS` in `netlify/functions/list-models.js`.
