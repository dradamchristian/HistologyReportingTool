\
/**
 * Duodenal conclusions patch (v6)
 *
 * Why: the LLM sometimes returns vague conclusions or object values => [object Object].
 * Fix: (1) coerce extracted fields to strings; (2) enforce a deterministic duodenal conclusion
 * based on the raw input text; (3) strip hallucinated inflammation unless explicitly stated.
 *
 * HOW TO USE:
 * - If your project has a single netlify/functions/generate-report.js file, copy the helper
 *   functions below into it and call postprocessOutput() immediately after extraction and
 *   before templating.
 *
 * This patch file is provided as a reference; adapt the "hook" to your generate-report.js.
 */

function toStringValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (typeof v.value === "string") return v.value;
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

function enforceDuodenalConclusion(rawText) {
  const t = (rawText || "").toLowerCase();

  const hasGM = /gastric\s+metaplasia|foveolar\s+metaplasia/.test(t);
  const hasInflamm = /\bduodenitis\b|\binflammation\b/.test(t);

  const hasIEL = /\biel\b|intraepithelial\s+lymph/.test(t);
  const ielIncreased = /increased\s+(intraepithelial\s+lymph|iels?)|raise(d)?\s+(intraepithelial\s+lymph|iels?)|high\s+iels?/.test(t);

  const blunting = /villous\s+blunt|blunted\s+villi|villous\s+atrophy|partial\s+villous\s+atrophy|subtotal\s+villous\s+atrophy|total\s+villous\s+atrophy|flat\s+mucosa/.test(t);
  const subtotal = /subtotal\s+villous\s+atrophy/.test(t);
  const total = /total\s+villous\s+atrophy|flat\s+mucosa/.test(t);
  const cryptHyper = /crypt\s+hyperplasia/.test(t);

  if (ielIncreased || (hasIEL && /increase/.test(t))) {
    if (blunting) {
      let marsh = "Marsh 3a";
      if (subtotal) marsh = "Marsh 3b";
      if (total) marsh = "Marsh 3c";
      return `${marsh} change (villous atrophy/blunting with increased intraepithelial lymphocytes). Features are in keeping with coeliac disease. Correlate with anti-tissue transglutaminase (anti-tTG) antibody and clinical findings.`;
    }
    if (cryptHyper) {
      return `Marsh 2 change (increased intraepithelial lymphocytes with crypt hyperplasia and retained villous architecture). Correlate with anti-tissue transglutaminase (anti-tTG) antibody and clinical context when considering coeliac disease.`;
    }
    return `Marsh 1 change (increased intraepithelial lymphocytes with retained villous architecture). Correlate with anti-tissue transglutaminase (anti-tTG) antibody and clinical context when considering coeliac disease.`;
  }

  if (hasGM || hasInflamm) {
    return `Features are in keeping with chronic (peptic-type) duodenitis. No features of coeliac disease.`;
  }

  return `No features of coeliac disease. Appearances are within normal limits.`;
}

function postprocessOutput(datasetId, rawText, extracted) {
  extracted.microscopy_text = toStringValue(extracted.microscopy_text);
  extracted.conclusion_text = toStringValue(extracted.conclusion_text);

  if (datasetId === "duodenal_biopsy_simple_v1") {
    extracted.conclusion_text = enforceDuodenalConclusion(rawText);

    // Strip hallucinated inflammation sentences unless stated
    const t = (rawText || "").toLowerCase();
    if (!(/\bduodenitis\b|\binflammation\b/.test(t))) {
      extracted.microscopy_text = extracted.microscopy_text
        .replace(/There is (mild|moderate|marked) chronic inflammation[^.]*\.\s*/gi, "")
        .replace(/no significant inflammatory changes[^.]*\.\s*/gi, "");
    }

    // Ensure required ending sentence
    const mt = extracted.microscopy_text.trim();
    if (!/There is no dysplasia or malignancy\.\s*$/i.test(mt)) {
      extracted.microscopy_text = mt.replace(/\s+$/,"");
      if (!extracted.microscopy_text.endsWith(".")) extracted.microscopy_text += ".";
      extracted.microscopy_text += " There is no dysplasia or malignancy.";
    }
  }

  return extracted;
}

export { postprocessOutput };
