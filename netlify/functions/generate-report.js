const fs = require("fs");
const path = require("path");

function jsonResp(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}

function readJsonIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function listDatasetManifests() {
  const datasetsDir = path.join(process.cwd(), "datasets");
  const entries = fs.readdirSync(datasetsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const manifests = [];
  for (const id of entries) {
    const mp = path.join(datasetsDir, id, "manifest.json");
    const m = readJsonIfExists(mp);
    if (m && m.id) manifests.push(m);
  }
  return manifests;
}

function pickDataset(text, manifests) {
  const t = (text || "").toLowerCase();
  let best = null;

  for (const m of manifests) {
    const any = m.match?.any || [];
    let score = 0;
    for (const k of any) {
      if (k && t.includes(String(k).toLowerCase())) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { id: m.id, manifest: m, score };
    }
  }
  return best;
}

function readDatasetFiles(datasetId) {
  const base = path.join(process.cwd(), "datasets", datasetId);
  const schema = readJsonIfExists(path.join(base, "schema.json"));
  const rules = readJsonIfExists(path.join(base, "rules.json"));
  const template = fs.readFileSync(path.join(base, "template.txt"), "utf-8");
  return { schema, rules, template };
}

function safeJsonParse(maybe) {
  if (!maybe) return null;
  try { return JSON.parse(maybe); } catch {}
  const m = maybe.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch {}
  return null;
}

function applyDefaults(schema, obj) {
  const out = { ...(obj || {}) };
  const props = schema?.properties || {};
  for (const [k, v] of Object.entries(props)) {
    if (out[k] === undefined && v && Object.prototype.hasOwnProperty.call(v, "default")) out[k] = v.default;
  }
  return out;
}

// ------------------------
// Duodenal hardening helpers
// ------------------------
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
  const ielIncreased =
    /increased\s+(intraepithelial\s+lymph|iels?)|raise(d)?\s+(intraepithelial\s+lymph|iels?)|high\s+iels?/.test(t);

  const blunting =
    /villous\s+blunt|blunted\s+villi|villous\s+atrophy|partial\s+villous\s+atrophy|subtotal\s+villous\s+atrophy|total\s+villous\s+atrophy|flat\s+mucosa/.test(t);
  const subtotal = /subtotal\s+villous\s+atrophy/.test(t);
  const total = /total\s+villous\s+atrophy|flat\s+mucosa/.test(t);
  const cryptHyper = /crypt\s+hyperplasia/.test(t);

  if (ielIncreased || (hasIEL && /\bincrease(d)?\b/.test(t))) {
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

function stripHallucinatedDuodenalInflammation(rawText, microscopyText) {
  const t = (rawText || "").toLowerCase();
  if (/\bduodenitis\b|\binflammation\b/.test(t)) return microscopyText;

  return (microscopyText || "")
    .replace(/There is (mild|moderate|marked) chronic inflammation[^.]*\.\s*/gi, "")
    .replace(/no significant inflammatory changes[^.]*\.\s*/gi, "");
}

function polishDuodenalMicroscopy(rawText, microscopyText) {
  let mt = String(microscopyText || "").trim();
  const t = (rawText || "").toLowerCase();

  // If empty or ultra-short, build a sensible microscopy sentence from keywords
  const tooShort = mt.length < 25;

  // If it looks like it's echoing the input (starts with "duodenal mucosa ...")
  const looksLikeEcho =
    /^duodenal\s+mucosa\b/i.test(mt) && !/^The sections show duodenal mucosa\b/i.test(mt);

  if (tooShort || looksLikeEcho) {
    const ielUp = /increased\s+(intraepithelial\s+lymph|iels?)|iel[s]?\s+increased/.test(t);
    const blunting = /villous\s+blunt|villous\s+blunting|villous\s+atrophy|blunted\s+villi/.test(t);
    const cryptHyper = /crypt\s+hyperplasia/.test(t);
    const gm = /gastric\s+metaplasia|foveolar\s+metaplasia/.test(t);

    let s = "The sections show duodenal mucosa";

    if (blunting) s += " with villous blunting.";
    else s += " with retained villous architecture.";

    if (ielUp) s += " Intraepithelial lymphocytes are increased.";
    else s += " There is no increase in intraepithelial lymphocytes.";

    if (cryptHyper) s += " Crypt hyperplasia is present.";
    if (gm) s += " There is focal gastric metaplasia.";

    mt = s.trim();
  }

  return mt;
}

function ensureNoDysplasiaSentence(microscopyText) {
  let mt = String(microscopyText || "").trim();

  // Remove any partial/garbled "There is no dysplasia..." fragments (and duplicates)
  mt = mt.replace(/\bThere is no dysplasia\b[^.]*\.?/gi, "").trim();
  mt = mt.replace(/\bThere is no dysplasia or malignancy\.\s*$/i, "").trim();

  if (mt && !mt.endsWith(".")) mt += ".";
  if (mt) mt += " ";
  mt += "There is no dysplasia or malignancy.";

  return mt.trim();
}

// Template renderer (supports {{var}} and {{#if var}}...{{/if}} and {{#if (eq var "X")}})
function renderTemplate(template, data) {
  let out = template;
  const ifRe = /\{\{#if\s+([^}]+?)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;

  function evalCond(cond) {
    cond = String(cond || "").trim();
    const m = cond.match(/^\(eq\s+([a-zA-Z0-9_]+)\s+["']([^"']+)["']\)$/);
    if (m) return String(data[m[1]] ?? "") === m[2];
    const v = data[cond];
    if (v === undefined || v === null) return false;
    if (typeof v === "boolean") return v;
    const s = String(v).trim();
    return s.length > 0 && s !== "0" && s.toLowerCase() !== "false";
  }

  let guard = 0;
  while (guard++ < 80) {
    const next = out.replace(ifRe, (_, cond, body) => (evalCond(cond) ? body : ""));
    if (next === out) break;
    out = next;
  }

  out = out.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = data[key];
    return (v === undefined || v === null) ? "" : String(v);
  });

  return out.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// Generic deterministic parsers used by RCPath-style datasets
function wordToNum(w){
  const m = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
    eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20 };
  return m[w] ?? null;
}

function parseNodes(text) {
  const patterns = [
    /(\d+)\s*(?:\/|of|out of)\s*(\d+)\s*(?:lymph\s*)?nodes?/i,
    /(\d+)\s*(?:positive|involved)\s*(?:lymph\s*)?nodes?\s*(?:out of|of|\/)\s*(\d+)/i,
    /(\d+)\s*(?:\/)\s*(\d+)\s*(?:lymph\s*)?nodes?\s*(?:involved|positive)?/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return { pos: Number(m[1]), total: Number(m[2]) };
  }

  const reWord = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b\s*(?:\/|of|out of)\s*(\d+)\s*(?:lymph\s*)?nodes?/i;
  const mw = text.match(reWord);
  if (mw) {
    const pos = wordToNum(mw[1].toLowerCase());
    const total = Number(mw[2]);
    if (pos !== null && Number.isFinite(total)) return { pos, total };
  }
  return null;
}

function parseCrmDistanceMm(text) {
  const re1 = /\b(?:crm|circumferential(?:\s+resection)?\s+margin)\b[^0-9]{0,30}(\d+(?:\.\d+)?)\s*mm\b/i;
  const m = text.match(re1);
  if (m) return Number(m[1]);
  const re2 = /(\d+(?:\.\d+)?)\s*mm\b[^.]{0,30}\b(?:to|from)\b[^.]{0,20}\bcrm\b/i;
  const m2 = text.match(re2);
  if (m2) return Number(m2[1]);
  if (/\bwithin\s*1\s*mm\b/i.test(text) || /\b<\s*1\s*mm\b/i.test(text)) return 0.5;
  return null;
}

function parseMarginStatus(text, which) {
  const t = (text || "").toLowerCase();
  const key = which.toLowerCase();
  const variants = [`${key} margin`, `${key} resection margin`, key];

  for (const v of variants) {
    const reSeg = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^\\n\\.]{0,140}", "i");
    const seg = (text.match(reSeg) || [""])[0].toLowerCase();
    if (!seg) continue;
    if (seg.includes("involved") || seg.includes("positive")) return "Involved";
    if (seg.includes("clear") || seg.includes("uninvolved") || seg.includes("negative") || seg.includes("free")) return "Normal";
  }
  if (t.includes(`${key} margin involved`) || t.includes(`${key} margin positive`)) return "Involved";
  if (t.includes(`${key} margin clear`) || t.includes(`${key} margin uninvolved`) || t.includes(`${key} margin negative`) || t.includes(`${key} margin free`)) return "Normal";
  return null;
}

function computePTFromText(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("beyond muscularis propria") || t.includes("through the wall") || t.includes("through wall") ||
      t.includes("beyond the wall") || t.includes("through muscularis propria") || t.includes("adventitia")) return "T3";
  if (t.includes("within the wall") || t.includes("into the wall") || t.includes("muscularis propria")) return "T2";
  return "TX";
}

function depthPhraseFromPT(pT) {
  if (pT === "T3") return "Invasion beyond muscularis propria.";
  if (pT === "T2") return "Invasion into muscularis propria.";
  return "Depth of invasion cannot be assessed from the description.";
}

function computePNFromRules(rules, nodesPositive) {
  const mapping = rules?.pn_mapping_by_positive_nodes || [];
  const n = Number(nodesPositive || 0);
  for (const band of mapping) if (n >= band.min && n <= band.max) return band.set;
  return "NX";
}

function computeRStatusFromRules(rules, record) {
  const triggers = rules?.r_status_rules?.R1_if_any || [];
  for (const tr of triggers) {
    const val = String(record[tr.field] ?? "");
    if (tr.equals && val === tr.equals) return "R1";
    if (tr.contains && val.includes(tr.contains)) return "R1";
  }
  return "R0";
}

function mandardDescriptor(rules, trg) {
  if (!trg) return "";
  return rules?.mandard_descriptors?.[String(trg)] || "";
}

function buildCaveats(extracted, datasetId) {
  const c = [];
  c.push(`Dataset selected: ${datasetId}.`);
  c.push("Defaults applied for unmentioned fields (per dataset schema).");
  if (extracted.pT) c.push(`pT set as ${extracted.pT}.`);
  if (extracted.pN) c.push(`pN set as ${extracted.pN} from nodes positive (${extracted.nodes_positive}).`);
  if (extracted.y_prefix) c.push("y-prefix added because a tumour regression grade implies neoadjuvant therapy.");
  return c;
}

// Pipeline: keyword-based short report (gallbladder)
function applyKeywordShortReport(extracted, rawText) {
  const lt = String(rawText || "").toLowerCase();

  const hasAcute = lt.includes("acute");
  const hasChronic = lt.includes("chronic");

  if (hasAcute && hasChronic) extracted.diagnosis = "Acute on chronic cholecystitis";
  else if (hasAcute) extracted.diagnosis = "Acute cholecystitis";
  else extracted.diagnosis = "Chronic cholecystitis";

  if (lt.includes("widespread") || lt.includes("diffuse")) extracted.chronic_inflammation_extent = "Widespread";
  else if (lt.includes("patchy")) extracted.chronic_inflammation_extent = "Patchy";
  else if (lt.includes("focal")) extracted.chronic_inflammation_extent = "Focal";

  extracted.acute_inflammation = hasAcute;

  if (lt.includes("cholesterolosis")) {
    if (lt.includes("widespread") || lt.includes("diffuse")) extracted.cholesterolosis = "Widespread";
    else if (lt.includes("focal") || lt.includes("patchy")) extracted.cholesterolosis = "Focal";
    else extracted.cholesterolosis = "Focal";
  }

  extracted.adenomyomatosis = lt.includes("adenomyomatosis") || lt.includes("adenomyomat");
  extracted.denuded_epithelium = lt.includes("denuded");
  extracted.necrosis = lt.includes("necrotic") || lt.includes("necrosis");

  extracted.dysplasia = (lt.includes("dysplasia") && !lt.includes("no dysplasia")) ? "Yes" : "No";
  extracted.malignancy = ((lt.includes("malign") || lt.includes("carcinoma") || lt.includes("cancer")) && !lt.includes("no malignancy")) ? "Yes" : "No";
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return jsonResp(200, { error: "Missing text" });

    const { text } = JSON.parse(event.body || "{}");
    if (!text) return jsonResp(400, { error: "Missing text" });

    const rawText = String(text);
    const manifests = listDatasetManifests();
    const picked = pickDataset(rawText, manifests);
    if (!picked) return jsonResp(400, { error: "Could not confidently select a dataset. Please include site/specimen." });

    const datasetId = picked.id;
    const manifest = picked.manifest;
    const { schema, rules, template } = readDatasetFiles(datasetId);

    let extracted = {};

    if (manifest.pipeline?.mode === "keyword_short_report") {
      extracted = applyDefaults(schema, {});
      applyKeywordShortReport(extracted, rawText);

    } else if (manifest.pipeline?.mode === "schema_extract_then_rules") {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return jsonResp(500, { error: "OPENAI_API_KEY not set." });
      const model = (process.env.OPENAI_MODEL || "gpt-4").trim();

      const props = (schema && schema.properties) ? schema.properties : {};
      const schemaSummary = {};
      for (const [k, v] of Object.entries(props)) {
        schemaSummary[k] = {};
        if (Array.isArray(v.enum)) schemaSummary[k].enum = v.enum;
        if (typeof v.default !== "undefined") schemaSummary[k].default = v.default;
        if (typeof v.description === "string") schemaSummary[k].description = v.description.slice(0, 180);
      }

      const payload = {
        model,
        messages: [
          {
            role: "system",
            content: "You are a pathology reporting assistant. Output ONLY JSON. Always include all fields listed (use empty string if genuinely not mentioned)."
          },
          {
            role: "user",
            content:
              "Return JSON using these field names. Use enum values where provided.\nFIELDS:\n" +
              JSON.stringify(schemaSummary) +
              "\n\nTEXT:\n" +
              rawText
          }
        ],
        temperature: 0.2,
        max_tokens: 900
      };

      const ac = new AbortController();
      const tmr = setTimeout(() => ac.abort(), 9000);

      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ac.signal
      });

      clearTimeout(tmr);

      const raw = await resp.json().catch(() => ({}));
      if (!resp.ok) return jsonResp(resp.status, { error: raw?.error?.message || "OpenAI request failed", raw });

      const content = raw?.choices?.[0]?.message?.content || "";
      const extracted0 = safeJsonParse(content);
      if (!extracted0) return jsonResp(500, { error: "Model did not return valid JSON.", model_output: content });

      extracted = applyDefaults(schema, extracted0);

      // Deterministic overrides from raw text
      const nodeParsed = parseNodes(rawText);
      if (nodeParsed) {
        extracted.nodes_positive = nodeParsed.pos;
        extracted.nodes_examined = nodeParsed.total;
      }

      const prox = parseMarginStatus(rawText, "proximal");
      const dist = parseMarginStatus(rawText, "distal");
      if (prox) extracted.proximal_margin_status = prox;
      if (dist) extracted.distal_margin_status = dist;

      const crmDist = parseCrmDistanceMm(rawText);
      if (crmDist !== null && Number.isFinite(crmDist)) extracted.distance_to_crm_mm = crmDist;

      // CRM enforcement <1mm
      const crmNum = Number(extracted.distance_to_crm_mm);
      if (Number.isFinite(crmNum)) {
        if (crmNum < 1) extracted.circumferential_margin_status = "Involved: carcinoma within 1 mm of CRM.";
        else extracted.circumferential_margin_status = "Not involved: carcinoma more than 1 mm from CRM.";
      }

      // Staging + phrases
      extracted.pT = computePTFromText(rawText);
      extracted.depth_phrase = depthPhraseFromPT(extracted.pT);
      extracted.pN = computePNFromRules(rules, extracted.nodes_positive);
      extracted.r_status = computeRStatusFromRules(rules, extracted);

      // Mandard => neoadjuvant + y-prefix
      extracted.mandard_descriptor = mandardDescriptor(rules, extracted.tumour_regression_grade);
      if (String(extracted.tumour_regression_grade || "").trim()) {
        extracted.neoadjuvant_therapy = "Yes";
        extracted.neoadjuvant_therapy_history = "Yes";
        extracted.y_prefix = true;
      } else {
        extracted.neoadjuvant_therapy = "No";
        extracted.neoadjuvant_therapy_history = "No";
        extracted.y_prefix = false;
      }

      // pM display
      const pm1 = String(extracted.pm1_disease || "").toLowerCase();
      extracted.pM = (pm1 === "yes" || pm1 === "m1" || pm1 === "true") ? "M1" : "";
      extracted.pM_display = extracted.pM ? extracted.pM : "Not applicable";

      // Node stations placeholder
      extracted.has_positive_nodes = Number(extracted.nodes_positive || 0) > 0;
      if (extracted.has_positive_nodes && !String(extracted.positive_node_stations || "").trim()) {
        extracted.positive_node_stations = "[enter station(s)]";
      }

      // --------------------------
      // Duodenal deterministic patch
      // --------------------------
      if (datasetId === "duodenal_biopsy_simple_v1") {
        extracted.microscopy_text = toStringValue(extracted.microscopy_text);
        extracted.conclusion_text = toStringValue(extracted.conclusion_text);

        extracted.conclusion_text = enforceDuodenalConclusion(rawText);

        extracted.microscopy_text = stripHallucinatedDuodenalInflammation(rawText, extracted.microscopy_text);
        extracted.microscopy_text = polishDuodenalMicroscopy(rawText, extracted.microscopy_text);
        extracted.microscopy_text = ensureNoDysplasiaSentence(extracted.microscopy_text);
      }

    } else {
      return jsonResp(500, { error: `Unknown pipeline mode in manifest for dataset ${datasetId}.` });
    }

    const forbidden = ["not stated", "derived from", "inferred", "assumed"];
    let report_text = renderTemplate(template, extracted)
      .split("\n")
      .filter(line => !forbidden.some(f => line.toLowerCase().includes(f)))
      .join("\n");

    return jsonResp(200, {
      report_text,
      caveats: buildCaveats(extracted, datasetId),
      dataset_id: datasetId
    });

  } catch (e) {
    if (String(e && e.name) === "AbortError") return jsonResp(504, { error: "OpenAI request timed out (try again)." });
    return jsonResp(500, { error: e.message || "Server error" });
  }
};
