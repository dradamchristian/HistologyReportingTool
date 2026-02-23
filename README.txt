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
