(() => {
  const $ = (id) => document.getElementById(id);

  let cases = [];
  let stopRequested = false;

  function setRunState(msg) { $("runState").textContent = msg; }
  function resetUI() {
    $("results").innerHTML = "";
    $("kpi").textContent = "0 passed • 0 failed • 0 warnings";
    const b = $("bundle");
    if (b) b.value = "";
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

  function evaluateChecks(text, checks, actualDatasetId, expectedDatasetId) {
    const t = (text || "").toLowerCase();
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trimEnd().toLowerCase());
    const missing = [];
    for (const raw of (checks || [])) {
      const s = String(raw);
      if (s.startsWith("! LINE: ")) {
        const expectedLine = s.slice(8).trimEnd().toLowerCase();
        if (lines.includes(expectedLine)) missing.push(raw);
      } else if (s.startsWith("LINE: ")) {
        const expectedLine = s.slice(6).trimEnd().toLowerCase();
        if (!lines.includes(expectedLine)) missing.push(raw);
      } else if (s.startsWith("! ")) {
        const needle = s.slice(2).toLowerCase();
        if (needle && t.includes(needle)) missing.push(raw); // forbidden string present
      } else {
        const needle = s.toLowerCase();
        if (needle && !t.includes(needle)) missing.push(raw);
      }
    }
    if (expectedDatasetId && actualDatasetId !== expectedDatasetId) {
      missing.push(`Dataset mismatch: expected ${expectedDatasetId}, received ${actualDatasetId || "(none)"}`);
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
        <span class="pill">${c.EXPECTED_DATASET_ID || c.EXPECTED_DATASET}</span>
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

  async function callFunction(url, input, requestedMode="") {
    const body = JSON.stringify({ text: input, ...(requestedMode ? { requested_mode: requestedMode, benchmark_mode: true } : {}) });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    const json = await res.json();
    return { status: res.status, json };
  }

  async function loadBenchmarkModels() {
    const select = $("benchmarkModels");
    try {
      const url = normalizeUrl($("baseUrl").value, "/.netlify/functions/list-models");
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const preferred = new Set(["gpt-4.1-mini", "gpt-5.4-mini", "gpt-5.4"]);
      select.innerHTML = (data.models || []).map((model) => {
        const price = model.pricing_per_million;
        const priceText = price ? `$${price.input}/$${price.output} per 1M` : "price unknown";
        return `<option value="${escapeHtml(model.id)}"${preferred.has(model.id) ? " selected" : ""}>${escapeHtml(model.label)} — ${priceText}</option>`;
      }).join("");
      $("benchmarkState").textContent = `${data.models?.length || 0} models available`;
    } catch (error) {
      $("benchmarkState").textContent = `Model load failed: ${error.message}`;
    }
  }

  async function runModelBenchmark() {
    const models = Array.from($("benchmarkModels").selectedOptions).map((option) => option.value);
    if (!models.length) { alert("Select at least one model."); return; }
    if (!cases.length) cases = await fetchDefaultCases();
    const caseCount = Number($("benchmarkCaseCount").value) || 3;
    const repeats = Number($("benchmarkRepeats").value) || 3;
    const benchmarkCases = cases.slice(0, caseCount);
    const url = normalizeUrl($("baseUrl").value, $("fnPath").value);
    const rows = $("benchmarkResults");
    const button = $("benchmarkBtn");
    button.disabled = true;
    rows.innerHTML = "";

    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      const model = models[modelIndex];
      $("benchmarkState").textContent = `Testing ${model} (${modelIndex + 1}/${models.length})…`;
      let passed = 0, attempts = 0, duration = 0, inputTokens = 0, outputTokens = 0, cost = 0, hasUnknownCost = false;
      for (const testCase of benchmarkCases) {
        for (let repeat = 0; repeat < repeats; repeat += 1) {
          attempts += 1;
          try {
            const resp = await callFunction(url, testCase.INPUT, model);
            const report = resp?.json?.report_text || resp?.json?.report || "";
            const missing = evaluateChecks(report, testCase.EXPECTED_CHECKS || [], resp?.json?.dataset_id || "", testCase.EXPECTED_DATASET_ID || "");
            if (resp.status < 400 && missing.length === 0) passed += 1;
            const metrics = resp?.json?.metrics || {};
            duration += Number(metrics.duration_ms || 0);
            inputTokens += Number(metrics.input_tokens || 0);
            outputTokens += Number(metrics.output_tokens || 0);
            if (metrics.estimated_cost_usd == null) hasUnknownCost = true;
            else cost += Number(metrics.estimated_cost_usd || 0);
          } catch (_) { hasUnknownCost = true; }
        }
      }
      const averageMs = attempts ? duration / attempts : 0;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(model)}</td><td>${passed}/${attempts} (${attempts ? Math.round(passed / attempts * 100) : 0}%)</td><td>${(averageMs / 1000).toFixed(2)}s</td><td>${inputTokens} / ${outputTokens}</td><td>${hasUnknownCost ? "Unknown" : `$${cost.toFixed(6)}`}</td><td>${hasUnknownCost || !attempts ? "Unknown" : `$${(cost / attempts).toFixed(6)}`}</td><td><button class="btn promote-model" type="button" data-model="${escapeHtml(model)}">Set front-page default</button></td>`;
      rows.appendChild(tr);
    }
    $("benchmarkState").textContent = `Done: ${benchmarkCases.length} reports × ${repeats} runs`;
    button.disabled = false;
  }

  function appendToBundle({id, input, report, missing, ok}) {
    const b = $("bundle");
    if (!b) return;

    const includePasses = $("bundlePasses")?.checked;
    if (!includePasses && ok) return;

    const header = `\n\n===== ${id} (${ok ? "PASS" : "FAIL"}) =====\n`;
    const miss = missing?.length ? missing.join("\n") : "(none)";
    b.value = (b.value || "") +
      header +
      "\nINPUT:\n" + input +
      "\n\nMISSING/CHECKS FAILED:\n" + miss +
      "\n\nOUTPUT:\n" + report + "\n";
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

        const missing = evaluateChecks(
          report,
          c.EXPECTED_CHECKS || [],
          resp?.json?.dataset_id || "",
          c.EXPECTED_DATASET_ID || ""
        );
        $("miss-"+sid).textContent = missing.length ? missing.join("\n") : "(none)";

        const ok = missing.length === 0;
        appendToBundle({id:sid, input:c.INPUT||"", report, missing, ok});

        if (!ok) {
          failed += 1;
          statusEl.textContent = "FAIL";
          statusEl.className = "status bad";
        } else {
          passed += 1;
          statusEl.textContent = "PASS";
          statusEl.className = "status good";
        }

        // Legacy cases only have a human-readable EXPECTED_DATASET label. Keep
        // their warning heuristic, but do not second-guess the exact ID check
        // above when EXPECTED_DATASET_ID is supplied.
        const datasetId = (resp?.json?.dataset_id || "").toLowerCase();
        const expected = String(c.EXPECTED_DATASET || "").toLowerCase();
        if (!c.EXPECTED_DATASET_ID && datasetId && expected && !datasetId.includes(expected)) {
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
        appendToBundle({id:sid, input:c.INPUT||"", report:String(e), missing:["(error)"], ok:false});
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
    $("benchmarkBtn").addEventListener("click", runModelBenchmark);
    $("benchmarkResults").addEventListener("click", (event) => {
      const button = event.target.closest(".promote-model");
      if (!button) return;
      const frontPage = new URL($("baseUrl").value);
      frontPage.searchParams.set("model", button.dataset.model);
      window.open(frontPage.toString(), "_blank", "noopener");
      $("benchmarkState").textContent = `Opened the front page to confirm ${button.dataset.model} as its browser default`;
    });
    $("baseUrl").addEventListener("change", loadBenchmarkModels);

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
    await loadBenchmarkModels();
  }

  init();
})();
