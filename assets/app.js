const $ = (id) => document.getElementById(id);

let rec = null;
let finalText = "";
let dictating = false;

function setStatus(msg, isError=false){
  $("status").textContent = msg || "";
  $("status").style.color = isError ? "var(--bad)" : "var(--muted)";
}
function setMicPill(){ $("micState").textContent = dictating ? "Mic: listening" : "Mic: idle"; }

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

  // Plain text (Windows newlines)
  const plain = raw.replace(/\r?\n/g, "\r\n");

  // RTF: use \par for line breaks (very Windows-control friendly)
  const escRtf = (s) =>
    String(s)
      .replace(/\\/g, "\\\\")
      .replace(/{/g, "\\{")
      .replace(/}/g, "\\}")
      .replace(/\r?\n/g, "\\par\n");

  const rtf =
    "{\\rtf1\\ansi\\deff0\n" +
    "{\\fonttbl{\\f0\\fnil\\fcharset0 Consolas;}}\n" +
    "\\f0\\fs20\n" +
    escRtf(raw) +
    "\n}";

  // Try to write BOTH formats (preferred)
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/rtf":   new Blob([rtf],   { type: "text/rtf" }),
      })
    ]);
    setStatus("Copied to clipboard (LIMS-friendly).");
    return;
  } catch (err) {
    // Fallback: plain text only
    try {
      await navigator.clipboard.writeText(plain);
      setStatus("Copied (plain text).");
      return;
    } catch {
      setStatus("Copy failed — select output and copy manually.", true);
    }
  }
}
$("btnDictate").addEventListener("click", () => { dictating ? stopDictation() : startDictation(); });
$("btnGenerate").addEventListener("click", generate);
$("btnClear").addEventListener("click", () => { stopDictation(); finalText=""; $("inputText").value=""; $("output").textContent=""; $("caveatsBox").style.display="none"; setStatus(""); });
$("btnCopy").addEventListener("click", copyOut);
setMicPill();
