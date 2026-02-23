(() => {
  const $ = (id) => document.getElementById(id);

  let cases = [];
  let stopRequested = false;

  function setRunState(msg) { $("runState").textContent = msg; }
  function resetUI() {
    $("results").innerHTML = "";
    $("kpi").textContent = "0 passed • 0 failed • 0 warnings";
  }
  function normalizeUrl(base, path) {
    base = (base || "").trim().replace(/\/+$/,"");
    path = (path || "").trim();
    if (!path.startsWith("/")) path = "/" + path;
    return base + path;
  }
  async function readFileAsJson(file) {
    const text = await file.text();
    return JSON.parse(text);
  }
  async function fetchDefaultCases() {
    try {
      const res = await fetch("./testcases.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      return Array.isArray(json.cases) ? json.cases : (Array.isArray(json) ? json : []);
    } catch (e) {
      console.warn("Could not fetch ./testcases.json:", e);
      return [];
    }
  }

  function evaluateChecks(text, checks) {
    const t = (text || "").toLowerCase();
    const missing = [];
    for (const raw of (checks || [])) {
      const s = String(raw);
      if (s.startsWith("! ")) {
        const needle = s.slice(2).toLowerCase();
        if (needle && t.includes(needle)) missing.push(raw); // treat as failure: forbidden string present
      } else {
        const needle = s.toLowerCase();
        if (needle && !t.includes(needle)) missing.push(raw);
      }
    }
    return missing;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" })[m]);
  }

  function renderCaseShell(c) {
    const el = document.createElement("div");
    el.className = "case";
    el.innerHTML = `
      <h3>
        <span>${c.id}</span>
        <span class="pill">${c.EXPECTED_DATASET}</span>
        <span class="status warn" id="status-${c.id}">PENDING</span>
      </h3>
      <div class="small">Checks: ${(c.EXPECTED_CHECKS || []).length}</div>
      <details><summary>Show input</summary><pre>${escapeHtml(c.INPUT || "")}</pre></details>
      <details><summary>Show output</summary><pre id="out-${c.id}">(not run)</pre></details>
      <details><summary>Missing/failed checks</summary><pre id="miss-${c.id}">(not run)</pre></details>
    `;
    return el;
  }

  function updateKpi(passed, failed, warn) {
    $("kpi").textContent = `${passed} passed • ${failed} failed • ${warn} warnings`;
  }

  async function callFunction(url, input) {
    const body = JSON.stringify({ text: input });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    const json = await res.json();
    return { status: res.status, json };
  }

  async function run() {
    stopRequested = false;
    $("runBtn").disabled = true;
    $("stopBtn").disabled = false;

    resetUI();

    if (!cases.length) {
      cases = await fetchDefaultCases();
      if (!cases.length) {
        alert("No test cases loaded. Upload testcases.json or place one next to tests.html.");
        setRunState("No cases");
        $("runBtn").disabled = false;
        $("stopBtn").disabled = true;
        return;
      }
    }

    const fnUrl = normalizeUrl($("baseUrl").value, $("fnPath").value);

    const results = $("results");
    for (const c of cases) results.appendChild(renderCaseShell(c));

    let passed=0, failed=0, warn=0;
    updateKpi(passed, failed, warn);
    setRunState("Running…");

    for (const c of cases) {
      if (stopRequested) break;

      const sid = c.id;
      const statusEl = $("status-"+sid);
      statusEl.textContent = "RUNNING";
      statusEl.className = "status warn";

      try {
        const resp = await callFunction(fnUrl, c.INPUT);
        const report = resp?.json?.report_text || resp?.json?.report || resp?.json?.text || JSON.stringify(resp.json, null, 2);

        $("out-"+sid).textContent = report;

        const missing = evaluateChecks(report, c.EXPECTED_CHECKS || []);
        $("miss-"+sid).textContent = missing.length ? missing.join("\n") : "(none)";

        const ok = missing.length === 0;
        if (!ok) {
          failed += 1;
          statusEl.textContent = "FAIL";
          statusEl.className = "status bad";
        } else {
          passed += 1;
          statusEl.textContent = "PASS";
          statusEl.className = "status good";
        }

        // Optional dataset warning (soft)
        const datasetId = (resp?.json?.dataset_id || "").toLowerCase();
        const expected = String(c.EXPECTED_DATASET || "").toLowerCase();
        if (datasetId && expected && !datasetId.includes(expected)) {
          warn += 1;
          statusEl.textContent = ok ? "PASS (dataset?)" : "FAIL (dataset?)";
          statusEl.className = "status warn";
        }

      } catch (e) {
        failed += 1;
        statusEl.textContent = "ERROR";
        statusEl.className = "status bad";
        $("out-"+sid).textContent = String(e);
        $("miss-"+sid).textContent = "(error)";
        console.error(e);
      }

      updateKpi(passed, failed, warn);
    }

    setRunState(stopRequested ? "Stopped" : "Done");
    $("runBtn").disabled = false;
    $("stopBtn").disabled = true;
  }

  async function init() {
    cases = await fetchDefaultCases();
    setRunState(cases.length ? `Ready (${cases.length} cases)` : "Ready (no cases loaded)");

    $("runBtn").addEventListener("click", run);
    $("stopBtn").addEventListener("click", () => { stopRequested = true; setRunState("Stopping…"); });
    $("resetBtn").addEventListener("click", resetUI);

    $("file").addEventListener("change", async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        const json = await readFileAsJson(file);
        cases = Array.isArray(json.cases) ? json.cases : (Array.isArray(json) ? json : []);
        setRunState(`Loaded ${cases.length} cases`);
      } catch (e) {
        alert("Failed to load JSON: " + e.message);
      }
    });
  }

  init();
})();
