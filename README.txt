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
- Open **Model test console**, select a directly named model, and generate the same case with each option. The browser keeps the latest 25 results locally with latency, provider-reported token usage, estimated cost and success/failure.
- The frontend dropdown is populated dynamically from `/.netlify/functions/list-models`. It groups maintained, priced recommendations ahead of other accessible models, and hides dated snapshots when a stable alias is available.
- Server-side model validation + default lives in `netlify/functions/generate-report.js` (`DEFAULT_MODEL` and `modelIsUsableForGeneration()`). Non-text model families are excluded and newer reasoning models use their compatible Chat Completions parameters.
- Pricing constants live in `netlify/functions/generate-report.js` and `netlify/functions/list-models.js` (`MODEL_PRICING_PER_MILLION`); update both from the OpenAI pricing page when rates change. An accessible model without a verified rate remains selectable but displays `price unknown` and reports no estimated cost.
- Estimated cost formula is:
  (input_tokens / 1_000_000 * input_price_per_million) + (output_tokens / 1_000_000 * output_price_per_million)
- Model discovery/filtering is server-side in `netlify/functions/list-models.js` (OpenAI `/v1/models` + include/exclude rules + cache).
- To adjust which model families appear, edit `modelIsUsable()` and `FRIENDLY_LABELS` in `netlify/functions/list-models.js` and the matching server validation in `generate-report.js`.
- Model-list visibility indicates that the API key can see a model, not a guarantee that every endpoint or parameter supports it. Cost is a token-rate estimate, not an invoice; cached input, Batch API, fine-tuning, tools and service tiers may be priced differently.
- For an upgrade decision, run the same representative cases with **Best value**, **Lowest cost**, and **Highest accuracy**, review the clinical fields for accuracy, and compare the recorded latency and cost. Do not treat an unpriced model as cheaper: the Models API does not provide pricing, so its rate must be verified and added before making a cost comparison.
- The console checkmark records API success only. Use the manual accuracy rating after reviewing each generated report; the console also shows each known cost as a multiple of the cheapest priced run in the current table.

Colorectal local resection cancer proforma
==========================================
- Use explicit colorectal-site wording together with a local-procedure trigger.
- Examples: `Colorectal local resection. Adenocarcinoma.`, `Rectal local excision containing adenocarcinoma.`, `Colon polypectomy containing carcinoma.`, or `Colorectal EMR/ESD/TEM/TAMIS containing adenocarcinoma.`
- Recognised local-procedure triggers are: local resection, local excision, polypectomy, EMR, ESD, TEM and TAMIS.
- `Colorectal adenocarcinoma` without one of those local-procedure triggers continues to use the full colorectal resection proforma.

Pathology reference search
==========================
- Reference questions use `gpt-4.1-mini` by default; set `REFERENCE_MODEL` to override it.
- Trusted mode performs a dedicated Pathology Outlines page lookup before composing the answer, then limits returned citations to Pathology Outlines, RCPath, WHO and IARC domains.
- The dedicated lookup makes the relevant Pathology Outlines page prominent and typically means two web-search calls instead of one.
- Pathology Outlines does not always expose a citable page to the web-search provider. When that happens, the result includes a clearly labelled Pathology Outlines-only site-search link for further morphology detail and images; it is navigation, not evidence claimed to support the generated answer.
- Each response records token counts; the answer status displays its web-search call count and estimated cost when pricing is known.
- The estimate uses the model token prices in `netlify/functions/ask-reference.js` and a default web-search tool price of $10 per 1,000 calls.
- Set `REFERENCE_WEB_SEARCH_COST_PER_1000` if the current price on your OpenAI account differs. Pricing is deliberately configurable because provider prices can change.
