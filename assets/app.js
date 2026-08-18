const $ = (id) => document.getElementById(id);

let rec = null;
let finalText = "";
let dictating = false;
let lastGenerated = { dataset_id: "", extracted: {}, report_text: "", metrics: {}, staging_check: null };
const MODEL_MODES = [
  { id: "auto_recommended", label: "Auto recommended" },
  { id: "cheap_standard", label: "Cheap / Standard" },
  { id: "fast_higher_accuracy", label: "Fast / Higher accuracy" },
];
const DEFAULT_MODEL_MODE = "auto_recommended";

const AUDIT_DATASETS = new Set([
  "oesophagus_resection_rcpath_v3_microscopy",
  "gastrectomy_resection_rcpath_v1_microscopy",
  "colorectal_resection_rcpath_v1",
  "gist_resection_rcpath_v1",
  "hepatocellular_carcinoma_proforma_v1",
  "colorectal_liver_metastasis_proforma_v1",
]);

const INLINE_COMPLETIONS = [
  { trigger: "oes", completion: "oesophageal" },
  { trigger: "squ", completion: "squamous" },
  { trigger: "ade", completion: "adenocarcinoma" },
  { trigger: "through", completion: "through the wall" },
  { trigger: "mand", completion: "Mandard regression grade " },
  { trigger: "cole", completion: "colectomy" },
  { trigger: "gas", completion: "gastrectomy" },
];
const SPECIMEN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
let activeCompletion = null;

function getInputTextArea(){ return $("inputText"); }
function getWordBeforeCursor(el){
  const pos = el.selectionStart;
  const left = el.value.slice(0, pos);
  const match = left.match(/([A-Za-z]+)$/);
  if (!match) return null;
  return { word: match[1], start: pos - match[1].length, end: pos };
}
function completionFor(el){
  if (!el || el.selectionStart !== el.selectionEnd) return null;
  const word = getWordBeforeCursor(el);
  if (!word) return null;
  const hit = INLINE_COMPLETIONS.find((x) => x.trigger === word.word.toLowerCase());
  if (!hit || hit.completion.toLowerCase() === word.word.toLowerCase()) return null;
  return { ...hit, ...word };
}
function replaceRange(el, start, end, text){
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
}
function acceptActiveCompletion(){
  const el = getInputTextArea();
  activeCompletion = completionFor(el);
  if (!activeCompletion || !el) return false;
  replaceRange(el, activeCompletion.start, activeCompletion.end, activeCompletion.completion);
  updateInputAssists();
  return true;
}
function isLgiMode(text){ return /^\s*lgi\s*:/i.test(text || ""); }
function maybeSeedLgiFirstPart(el){
  if (!/^\s*lgi\s*:\s*$/i.test(el.value)) return false;
  el.value = el.value.replace(/:\s*$/i, ": A - ");
  el.setSelectionRange(el.value.length, el.value.length);
  return true;
}
function currentSpecimenLetter(line){
  const m = String(line || "").match(/^\s*([A-Z])\s*-\s*/i);
  return m ? m[1].toUpperCase() : null;
}
function nextLgiLetter(text){
  const letters = Array.from(String(text || "").matchAll(/(?:^|[\n;])\s*([A-Z])\s*-/gi)).map((m) => m[1].toUpperCase());
  const last = letters.length ? letters[letters.length - 1] : "A";
  const idx = SPECIMEN_LETTERS.indexOf(last);
  return SPECIMEN_LETTERS[Math.min(idx + 1, SPECIMEN_LETTERS.length - 1)] || "B";
}
function lgiUsesRangeShortcut(text){ return /^\s*lgi\s*:\s*[A-Z]\s*-\s*[A-Z](?![A-Za-z])/i.test(text || ""); }
function maybeInsertNextLgiPart(event){
  const el = getInputTextArea();
  if (!el || event.key !== "Enter" || event.shiftKey || !isLgiMode(el.value) || lgiUsesRangeShortcut(el.value)) return false;
  const pos = el.selectionStart;
  const lineStart = el.value.lastIndexOf("\n", pos - 1) + 1;
  const line = el.value.slice(lineStart, pos);
  if (!currentSpecimenLetter(line) && !/^\s*lgi\s*:/i.test(line)) return false;
  event.preventDefault();
  const next = nextLgiLetter(el.value.slice(0, pos));
  replaceRange(el, pos, el.selectionEnd, `\n${next} - `);
  updateInputAssists();
  return true;
}
function updateInputAssists(){
  const el = getInputTextArea();
  const ghost = $("ghostCompletion");
  const assist = $("inputAssist");
  activeCompletion = completionFor(el);
  if (ghost) {
    ghost.style.display = activeCompletion ? "block" : "none";
    ghost.innerHTML = activeCompletion ? `Tab/→: <strong>${activeCompletion.completion}</strong>` : "";
  }
  if (!assist || !el) return;
  const lgi = isLgiMode(el.value);
  const quickPanel = $("lgiQuickPanel");
  if (quickPanel) quickPanel.classList.toggle("is-active", lgi && !quickPanel.dataset.generated);
  assist.innerHTML = "";
  if (activeCompletion) {
    const span = document.createElement("span");
    span.className = "small";
    span.textContent = `Ghost completion ready: ${activeCompletion.trigger} → ${activeCompletion.completion}`;
    assist.appendChild(span);
  }
  if (lgiUsesRangeShortcut(el.value)) {
    const span = document.createElement("span");
    span.className = "small";
    span.textContent = "Range shortcut detected; specimen auto-advance is paused so A-D remains intact.";
    assist.appendChild(span);
  }
}
function initInputAcceleration(){
  const el = getInputTextArea();
  if (!el) return;
  el.addEventListener("input", () => { const panel = $("lgiQuickPanel"); if (panel) delete panel.dataset.generated; maybeSeedLgiFirstPart(el); updateInputAssists(); });
  el.addEventListener("click", updateInputAssists);
  el.addEventListener("keyup", updateInputAssists);
  el.addEventListener("keydown", (event) => {
    if ((event.key === "Tab" || event.key === "ArrowRight") && acceptActiveCompletion()) event.preventDefault();
    else maybeInsertNextLgiPart(event);
  });
  $("lgiQuickPanel")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-lgi-token]");
    if (!button) return;
    const token = button.dataset.lgiToken;
    const pos = el.selectionStart;
    const needsSpace = pos > 0 && !/\s$/.test(el.value.slice(0, pos));
    replaceRange(el, pos, el.selectionEnd, `${needsSpace ? " " : ""}${token} `);
    el.focus();
    updateInputAssists();
  });
  updateInputAssists();
}


function renderStagingCheck(stagingCheck) {
  const box = $("stagingCheckBox");
  const title = $("stagingCheckTitle");
  const rows = $("stagingCheckRows");
  const notes = $("stagingCheckNotes");
  if (!box || !title || !rows || !notes) return;

  if (!stagingCheck || !Array.isArray(stagingCheck.rows) || !stagingCheck.rows.length) {
    box.style.display = "none";
    title.textContent = "";
    rows.innerHTML = "";
    notes.innerHTML = "";
    return;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"
  }[ch]));

  title.textContent = stagingCheck.title || "TNM staging check";
  rows.innerHTML = stagingCheck.rows.map((row) => `<div class="staging-row"><strong>${esc(row.label || "")}</strong><span>${esc(row.value || "")}</span></div>`).join("");
  notes.innerHTML = Array.isArray(stagingCheck.notes) ? stagingCheck.notes.map((note) => `<li>${esc(note)}</li>`).join("") : "";
  box.style.display = "block";
}

function setStatus(msg, isError=false){
  $("status").textContent = msg || "";
  $("status").style.color = isError ? "var(--bad)" : "var(--muted)";
}
function setMicPill(){ $("micState").textContent = dictating ? "Mic: listening" : "Mic: idle"; }


function initThemeToggle(){
  const btn = $("btnThemeToggle");
  if (!btn) return;
  const apply = (enabled) => {
    document.body.classList.toggle("lcars-mode", enabled);
    btn.setAttribute("aria-pressed", enabled ? "true" : "false");
    btn.textContent = enabled ? "LCARS mode: on" : "LCARS mode: off";
  };
  const stored = localStorage.getItem("lcarsMode") === "true";
  apply(stored);
  btn.addEventListener("click", () => {
    const next = !document.body.classList.contains("lcars-mode");
    localStorage.setItem("lcarsMode", String(next));
    apply(next);
  });
}

function initModelSelector() {
  const sel = $("modelSelect");
  const hint = $("modelHint");
  if (!sel) return;
  sel.innerHTML = MODEL_MODES.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
  const available = new Set(MODEL_MODES.map((m) => m.id));
  const stored = localStorage.getItem("reportModelMode");
  const chosen = (stored && available.has(stored)) ? stored : DEFAULT_MODEL_MODE;
  sel.value = chosen;
  localStorage.setItem("reportModelMode", chosen);
  sel.addEventListener("change", () => localStorage.setItem("reportModelMode", sel.value));
  if (hint) hint.textContent = "Auto recommended uses GPT-4.1 mini unless complexity rules route to GPT-4.1.";
}

function renderMetricsLine(metrics, isError=false, message="") {
  const el = $("metricsLine");
  if (!el) return;
  if (!metrics || !metrics.model) { el.textContent = ""; return; }
  const secs = metrics.duration_ms != null ? `${(metrics.duration_ms/1000).toFixed(1)}s` : "n/a";
  const cost = metrics.estimated_cost_usd != null ? `est. $${Number(metrics.estimated_cost_usd).toFixed(3)}` : "est. n/a";
  const base = `${metrics.model} in ${secs} · ${metrics.input_tokens ?? "?"} input tokens · ${metrics.output_tokens ?? "?"} output tokens · ${cost}`;
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
    updateInputAssists();
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
  renderStagingCheck(null);

  try{
    const res = await fetch("/.netlify/functions/generate-report", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ text, requested_mode: $("modelSelect")?.value || DEFAULT_MODEL_MODE })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.metrics = data.metrics || {}; throw e; }
    $("output").textContent = data.report_text || data.report || JSON.stringify(data, null, 2);
    lastGenerated = {
      dataset_id: data.dataset_id || "",
      extracted: data.extracted || {},
      report_text: data.report_text || data.report || "",
      metrics: data.metrics || {},
      staging_check: data.staging_check || null,
    };
    renderStagingCheck(lastGenerated.staging_check);
    updateAuditPanel(lastGenerated.dataset_id);
    if (Array.isArray(data.caveats) && data.caveats.length){
      $("caveatsBox").style.display = "block";
      $("caveatsList").innerHTML = data.caveats.map(c => `<li>${c}</li>`).join("");
    }
    renderMetricsLine(data.metrics || {});
    const quickPanel = $("lgiQuickPanel");
    if (quickPanel) { quickPanel.dataset.generated = "true"; quickPanel.classList.remove("is-active"); }
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
$("btnClear").addEventListener("click", () => { stopDictation(); finalText=""; $("inputText").value=""; $("output").textContent=""; $("caveatsBox").style.display="none"; const panel = $("lgiQuickPanel"); if (panel) delete panel.dataset.generated; updateInputAssists(); setStatus(""); lastGenerated = { dataset_id: "", extracted: {}, report_text: "", metrics: {}, staging_check: null }; renderStagingCheck(null); updateAuditPanel(""); if ($("auditSpecimenNumber")) $("auditSpecimenNumber").value=""; if ($("auditConsultantName")) $("auditConsultantName").value=""; });
$("btnCopy").addEventListener("click", copyOut);
if ($("btnCopySaveAudit")) $("btnCopySaveAudit").addEventListener("click", copyAndSaveAudit);
initThemeToggle();
initModelSelector();
initInputAcceleration();
setMicPill();

const yearEl = $("currentYear");
if (yearEl) yearEl.textContent = new Date().getFullYear();
