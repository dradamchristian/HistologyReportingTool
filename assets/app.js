const $ = (id) => document.getElementById(id);

let rec = null;
let finalText = "";
let dictating = false;
let lastGenerated = { dataset_id: "", extracted: {}, report_text: "", metrics: {} };
const MODEL_FALLBACK = [{ id: "gpt-4o-mini", label: "Fast (4o mini)" }];
const DEFAULT_MODEL = "gpt-4o-mini";

const AUDIT_DATASETS = new Set([
  "oesophagus_resection_rcpath_v3_microscopy",
  "gastrectomy_resection_rcpath_v1_microscopy",
  "colorectal_resection_rcpath_v1",
  "gist_resection_rcpath_v1",
  "hepatocellular_carcinoma_proforma_v1",
  "colorectal_liver_metastasis_proforma_v1",
]);

function setStatus(msg, isError=false){
  $("status").textContent = msg || "";
  $("status").style.color = isError ? "var(--bad)" : "var(--muted)";
}
function setMicPill(){ $("micState").textContent = dictating ? "Mic: listening" : "Mic: idle"; }

async function initModelSelector() {
  const sel = $("modelSelect");
  const hint = $("modelHint");
  if (!sel) return;

  let models = MODEL_FALLBACK.slice();
  try {
    const res = await fetch("/.netlify/functions/list-models");
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok && Array.isArray(data.models) && data.models.length) {
      models = data.models.filter((m) => m && m.id).map((m) => ({ id: m.id, label: m.label || m.id }));
    } else if (hint) {
      hint.textContent = "Could not load live model list. Using default model.";
    }
  } catch (_) {
    if (hint) hint.textContent = "Could not load live model list. Using default model.";
  }

  sel.innerHTML = models.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");

  const available = new Set(models.map((m) => m.id));
  const stored = localStorage.getItem("reportModel");
  let chosen = DEFAULT_MODEL;
  if (stored && available.has(stored)) chosen = stored;
  else if (stored && !available.has(stored) && hint) {
    hint.textContent = `Previously selected model ${stored} is unavailable; using ${DEFAULT_MODEL}.`;
  } else if (!available.has(DEFAULT_MODEL) && models[0]) {
    chosen = models[0].id;
  }

  if (!available.has(chosen) && models[0]) chosen = models[0].id;
  sel.value = chosen;
  localStorage.setItem("reportModel", chosen);
  sel.addEventListener("change", () => localStorage.setItem("reportModel", sel.value));
}

function renderMetricsLine(metrics, isError=false, message="") {
  const el = $("metricsLine");
  if (!el) return;
  if (!metrics || !metrics.model) { el.textContent = ""; return; }
  const secs = metrics.duration_ms != null ? `${(metrics.duration_ms/1000).toFixed(1)}s` : "n/a";
  const cost = metrics.estimated_cost_usd != null ? `est. $${Number(metrics.estimated_cost_usd).toFixed(3)}` : "est. n/a";
  const base = `${metrics.benchmark_mode ? "[Benchmark] " : ""}${metrics.model} in ${secs} · ${metrics.input_tokens ?? "?"} input tokens · ${metrics.output_tokens ?? "?"} output tokens · ${cost}`;
  el.textContent = isError ? `${base} · ${message}` : `Generated with ${base}`;
}

function setAuditHint(msg, isError=false){
  const el = $("auditHint");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = isError ? "var(--bad)" : "var(--muted)";
}

async function loadConsultantOptions(force=false){
  const sel = $('auditConsultantName');
  if (!sel) return;
  if (!force && sel.options.length > 1) return;

  const setOptions = (names=[]) => {
    const unique = Array.from(new Set((names || []).map((x) => String(x || '').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b));
    sel.innerHTML = "<option value=''>Consultant name (required)</option>" + unique.map((c)=>`<option value="${c}">${c}</option>`).join('');
  };

  try {
    const res = await fetch('/.netlify/functions/audit-filter-options');
    const data = await res.json();
    if (res.ok && data.ok && Array.isArray(data.consultants)) {
      setOptions(data.consultants);
      if (data.consultants.length) return;
    }

    const res2 = await fetch('/.netlify/functions/audit-consultant-directory');
    const data2 = await res2.json();
    if (res2.ok && data2.ok) setOptions((data2.consultants || []).map((c) => c.name));
  } catch (_) {
    setAuditHint('Could not load consultant list. Try reloading page.', true);
  }
}

function updateAuditPanel(datasetId){
  const panel = $("auditPanel");
  if (!panel) return;
  if (AUDIT_DATASETS.has(datasetId || "")) {
    panel.style.display = "block";
    setAuditHint("Audit-enabled dataset detected.");
    loadConsultantOptions(true);
  } else {
    panel.style.display = "none";
    setAuditHint("");
  }
}

function startDictation(){
  finalText = "";
  if (!("webkitSpeechRecognition" in window)) {
    setStatus("Speech recognition not available in this browser.", true);
    return;
  }
  rec = new webkitSpeechRecognition();
  rec.lang = "en-GB";
  rec.continuous = true;
  rec.interimResults = true;

  rec.onstart = () => { dictating = true; setMicPill(); setStatus("Listening…"); };
  rec.onend = () => { dictating = false; setMicPill(); setStatus("Dictation stopped."); };
  rec.onerror = (e) => { dictating = false; setMicPill(); setStatus(`Dictation error: ${e.error || "unknown"}`, true); };

  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const txt = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += txt.trim() + " ";
      else interim += txt;
    }
    $("inputText").value = (finalText + interim).trimStart();
  };

  rec.start();
}

function stopDictation(){ if (rec) rec.stop(); }

async function generate(){
  const text = $("inputText").value.trim();
  if (!text){ setStatus("Type or dictate something first.", true); return; }
  setStatus("Generating…");
  $("caveatsBox").style.display = "none";
  $("caveatsList").innerHTML = "";
  $("output").textContent = "";

  try{
    const res = await fetch("/.netlify/functions/generate-report", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ text, model: $("modelSelect")?.value || DEFAULT_MODEL, benchmark_mode: Boolean($("benchmarkMode")?.checked) })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.metrics = data.metrics || {}; throw e; }
    $("output").textContent = data.report_text || data.report || JSON.stringify(data, null, 2);
    lastGenerated = {
      dataset_id: data.dataset_id || "",
      extracted: data.extracted || {},
      report_text: data.report_text || data.report || "",
      metrics: data.metrics || {},
    };
    updateAuditPanel(lastGenerated.dataset_id);
    if (Array.isArray(data.caveats) && data.caveats.length){
      $("caveatsBox").style.display = "block";
      $("caveatsList").innerHTML = data.caveats.map(c => `<li>${c}</li>`).join("");
    }
    renderMetricsLine(data.metrics || {});
    setStatus("Done.");
  }catch(err){
    const m = err?.metrics || {};
    renderMetricsLine(m, true, `Error: ${err.message || err}`);
    setStatus(`Error: ${err.message || err}`, true);
  }
}

async function copyOut(){
  const raw = $("output").textContent || "";
  if (!raw.trim()){ setStatus("Nothing to copy yet.", true); return; }

  // Plain text: CRLF for better compatibility with Outlook/LIMS fields.
  const plain = raw.replace(/\r?\n/g, "\r\n");

  // HTML fallback used by rich-text paste targets.
  const escHtml = (s) => String(s).replace(/[&<>"]/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"
  }[ch]));

  // Keep line boundaries using one block element per line.
  // Empty lines become <div><br></div> so paragraph breaks survive paste.
  const htmlBlocks = raw
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.length ? `<div>${escHtml(line)}</div>` : "<div><br></div>")
    .join("");

  const html = `<div>${htmlBlocks}</div>`;

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html":  new Blob([html],  { type: "text/html"  }),
      })
    ]);
    setStatus("Copied to clipboard (format-preserving).");
    return;
  } catch (err) {
    // Fallback to plain text CRLF.
    try {
      await navigator.clipboard.writeText(plain);
      setStatus("Copied to clipboard (plain text).");
      return;
    } catch {
      setStatus("Copy failed - select output and copy manually.", true);
    }
  }
}

async function saveAuditOnly(){
  const datasetId = lastGenerated.dataset_id || "";
  if (!AUDIT_DATASETS.has(datasetId)) {
    return { ok: false, skipped: true, reason: "Dataset not eligible for audit." };
  }

  const specimen_number = ($("auditSpecimenNumber")?.value || "").trim();
  const consultant_name = ($("auditConsultantName")?.value || "").trim();
  if (!specimen_number) return { ok: false, reason: "Specimen number required for audit save." };
  if (!consultant_name) return { ok: false, reason: "Consultant name required for audit save." };

  const payload = {
    dataset_id: datasetId,
    specimen_number,
    consultant_name,
    report_text: lastGenerated.report_text || $("output").textContent || "",
    extracted: lastGenerated.extracted || {},
    generation_metrics: lastGenerated.metrics || {},
  };

  const res = await fetch("/.netlify/functions/audit-save", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Audit save failed (${res.status})`);
  return { ok: true, id: data.id || null };
}

async function copyAndSaveAudit(){
  await copyOut();
  try {
    const out = await saveAuditOnly();
    if (out.skipped) {
      setStatus("Copied. Audit skipped (non-cancer dataset).");
      return;
    }
    setStatus("Copied + audit saved.");
    setAuditHint(out.id ? `Saved audit row: ${out.id}` : "Audit saved.");
    $("auditSpecimenNumber").value = "";
  } catch (err) {
    setStatus(`Copied, but audit save failed: ${err.message || err}`, true);
    setAuditHint(`Audit save failed: ${err.message || err}`, true);
  }
}
$("btnDictate").addEventListener("click", () => { dictating ? stopDictation() : startDictation(); });
$("btnGenerate").addEventListener("click", generate);
$("btnClear").addEventListener("click", () => { stopDictation(); finalText=""; $("inputText").value=""; $("output").textContent=""; $("caveatsBox").style.display="none"; setStatus(""); lastGenerated = { dataset_id: "", extracted: {}, report_text: "" }; updateAuditPanel(""); if ($("auditSpecimenNumber")) $("auditSpecimenNumber").value=""; if ($("auditConsultantName")) $("auditConsultantName").value=""; });
$("btnCopy").addEventListener("click", copyOut);
if ($("btnCopySaveAudit")) $("btnCopySaveAudit").addEventListener("click", copyAndSaveAudit);
initModelSelector();
setMicPill();

const yearEl = $("currentYear");
if (yearEl) yearEl.textContent = new Date().getFullYear();
