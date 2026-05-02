const $ = (id) => document.getElementById(id);

let rec = null;
let finalText = "";
let dictating = false;
let lastGenerated = { dataset_id: "", extracted: {}, report_text: "" };

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
function setAuditHint(msg, isError=false){
  const el = $("auditHint");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = isError ? "var(--bad)" : "var(--muted)";
}
function updateAuditPanel(datasetId){
  const panel = $("auditPanel");
  if (!panel) return;
  if (AUDIT_DATASETS.has(datasetId || "")) {
    panel.style.display = "block";
    setAuditHint("Audit-enabled dataset detected.");
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
      body: JSON.stringify({ text })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    $("output").textContent = data.report_text || data.report || JSON.stringify(data, null, 2);
    lastGenerated = {
      dataset_id: data.dataset_id || "",
      extracted: data.extracted || {},
      report_text: data.report_text || data.report || "",
    };
    updateAuditPanel(lastGenerated.dataset_id);
    if (Array.isArray(data.caveats) && data.caveats.length){
      $("caveatsBox").style.display = "block";
      $("caveatsList").innerHTML = data.caveats.map(c => `<li>${c}</li>`).join("");
    }
    setStatus("Done.");
  }catch(err){
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
setMicPill();

const yearEl = $("currentYear");
if (yearEl) yearEl.textContent = new Date().getFullYear();
