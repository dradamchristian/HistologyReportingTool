const fs = require("fs");
const path = require("path");

function jsonResp(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}

function readDatasetFiles(datasetId) {
  const base = path.join(process.cwd(), "datasets", datasetId);
  const schema = JSON.parse(fs.readFileSync(path.join(base, "schema.json"), "utf-8"));
  const rules = JSON.parse(fs.readFileSync(path.join(base, "rules.json"), "utf-8"));
  const template = fs.readFileSync(path.join(base, "template.txt"), "utf-8");
  return { schema, rules, template };
}

function routeOrRefuse(text) {
  const t = (text || "").toLowerCase();

  // Gallbladder simple canned reports
  const gbHints = ["gallbladder","cholecyst","cholesterolosis","adenomyomat","rokitansky","aschoff"];
  if (gbHints.some(k => t.includes(k))) {
    return { ok: true, datasetId: "gallbladder_simple_v1" };
  }

  // Oesophagus/OGJ resections (current RCPath-style proforma)
  const oesHints = ["oesoph","esoph","ogj","gastro-oes","gastroes","cardia"];
  if (oesHints.some(k => t.includes(k))) {
    return { ok: true, datasetId: "oesophagus_resection_rcpath_v3_microscopy" };
  }

  return { ok: false, error: "Could not confidently select a dataset. Please include site/specimen (e.g. oesophagus/OGJ or gallbladder/cholecystitis)." };
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

function computePN(rules, nodesPositive) {
  const mapping = rules?.pn_mapping_by_positive_nodes || [];
  const n = Number(nodesPositive || 0);
  for (const band of mapping) if (n >= band.min && n <= band.max) return band.set;
  return "NX";
}

function computePT(rules, record) {
  const t = (record._source_text || "").toLowerCase();

  // T3 triggers (authoritative)
  if (
    t.includes("beyond muscularis propria") ||
    t.includes("through the wall") ||
    t.includes("through wall") ||
    t.includes("beyond the wall") ||
    t.includes("through muscularis propria") ||
    t.includes("adventitia")
  ) return "T3";

  // T2 triggers
  if (
    t.includes("within the wall") ||
    t.includes("into the wall") ||
    t.includes("muscularis propria")
  ) return "T2";

  return "TX";
}



function computeRStatus(rules, record) {
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
  while (guard++ < 60) {
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


function parseFirstNumberAfter(pattern, text) {
  const m = text.match(pattern);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function wordToNum(w){
  const m = {
    one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
    eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20
  };
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
  // Prefer explicit "CRM ... 3 mm" / "circumferential ... 0.5 mm" etc
  const re1 = /\b(?:crm|circumferential(?:\s+resection)?\s+margin)\b[^0-9]{0,30}(\d+(?:\.\d+)?)\s*mm\b/i;
  const m = text.match(re1);
  if (m) return Number(m[1]);
  // generic "x mm from CRM"
  const re2 = /(\d+(?:\.\d+)?)\s*mm\b[^.]{0,30}\b(?:to|from)\b[^.]{0,20}\bcrm\b/i;
  const m2 = text.match(re2);
  if (m2) return Number(m2[1]);
  // "<1mm" or "within 1 mm"
  if (/\bwithin\s*1\s*mm\b/i.test(text) || /\b<\s*1\s*mm\b/i.test(text)) return 0.5;
  return null;
}

function parseMarginStatus(text, which) {
  const t = (text || "").toLowerCase();
  const key = which.toLowerCase();

  const variants = [
    `${key} margin`,
    `${key} resection margin`,
    key
  ];

  for (const v of variants) {
    const reSeg = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^\\n\\.]{0,120}", "i");
    const seg = (text.match(reSeg) || [""])[0].toLowerCase();
    if (!seg) continue;
    if (seg.includes("involved") || seg.includes("positive")) return "Involved";
    if (seg.includes("clear") || seg.includes("uninvolved") || seg.includes("negative") || seg.includes("free")) return "Normal";
  }

  if (t.includes(`${key} margin involved`) || t.includes(`${key} margin positive`)) return "Involved";
  if (t.includes(`${key} margin clear`) || t.includes(`${key} margin uninvolved`) || t.includes(`${key} margin negative`) || t.includes(`${key} margin free`)) return "Normal";

  return null;
}


function buildCaveats(extracted) {
  const c = [];
  c.push("Defaults applied for unmentioned fields (per dataset schema).");
  c.push(`pT set as ${extracted.pT}.`);
  c.push(`pN set as ${extracted.pN} from nodes positive (${extracted.nodes_positive}).`);
  if (extracted.has_positive_nodes && String(extracted.positive_node_stations || "").includes("[enter")) {
    c.push("Positive node stations required: please replace placeholder with station(s).");
  }
  if (String(extracted.tumour_regression_grade || "").trim()) {
    c.push("y-prefix added because a tumour regression grade implies neoadjuvant therapy.");
  }
  return c;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return jsonResp(200, { error: "Missing text" });

    const { text } = JSON.parse(event.body || "{}");
    if (!text) return jsonResp(400, { error: "Missing text" });
    const rawText = String(text);
    const routed = routeOrRefuse(text);
    if (!routed.ok) return jsonResp(400, { error: routed.error });

    const { schema, rules, template } = readDatasetFiles(routed.datasetId);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return jsonResp(500, { error: "OPENAI_API_KEY not set." });

    const model = (process.env.OPENAI_MODEL || "gpt-4").trim();

    const props = (schema && schema.properties) ? schema.properties : {};
    const schemaSummary = {};
    for (const [k, v] of Object.entries(props)) {
      schemaSummary[k] = {};
      if (Array.isArray(v.enum)) schemaSummary[k].enum = v.enum;
      if (typeof v.default !== "undefined") schemaSummary[k].default = v.default;
      if (typeof v.description === "string") schemaSummary[k].description = v.description.slice(0, 140);
    }

    const payload = {
      model,
      messages: [
        { role: "system", content: "You are a pathology reporting assistant. Extract fields from free text. Output ONLY JSON. Omit fields not mentioned." },
        {
          role: "user",
          content:
            "Return JSON using these field names. Use enum values where provided. Omit fields not mentioned.\n" +
            "FIELDS:\n" + JSON.stringify(schemaSummary) + "\n\nTEXT:\n" + text
        }
      ],
      temperature: 0.2,
      max_tokens: 700
    };

    const ac = new AbortController();
    const tmr = setTimeout(() => ac.abort(), 8500);

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: ac.signal
    });

    clearTimeout(tmr);

    const raw = await resp.json().catch(() => ({}));
    if (!resp.ok) return jsonResp(resp.status, { error: raw?.error?.message || "OpenAI request failed", raw });

    const content = raw?.choices?.[0]?.message?.content || "";
    const extracted0 = safeJsonParse(content);
    if (!extracted0) return jsonResp(500, { error: "Model did not return valid JSON.", model_output: content });

    const extracted = applyDefaults(schema, extracted0);
    extracted._source_text = text;

// Dataset-specific deterministic rules
if (routed.datasetId === "gallbladder_simple_v1") {
  const lt = rawText.toLowerCase();

  // Diagnosis
  const hasAcute = lt.includes("acute");
  const hasChronic = lt.includes("chronic");
  if (hasAcute && hasChronic) extracted.diagnosis = "Acute on chronic cholecystitis";
  else if (hasAcute) extracted.diagnosis = "Acute cholecystitis";
  else extracted.diagnosis = "Chronic cholecystitis";

  // Chronic inflammation extent
  if (lt.includes("widespread") || lt.includes("diffuse")) extracted.chronic_inflammation_extent = "Widespread";
  else if (lt.includes("patchy")) extracted.chronic_inflammation_extent = "Patchy";
  else if (lt.includes("focal")) extracted.chronic_inflammation_extent = "Focal";

  // Acute inflammation flag
  extracted.acute_inflammation = hasAcute;

  // Cholesterolosis
  if (lt.includes("cholesterolosis")) {
    if (lt.includes("widespread") || lt.includes("diffuse")) extracted.cholesterolosis = "Widespread";
    else if (lt.includes("focal") || lt.includes("patchy")) extracted.cholesterolosis = "Focal";
    else extracted.cholesterolosis = "Focal";
  } else {
    extracted.cholesterolosis = extracted.cholesterolosis || "None";
  }
  extracted.adenomyomatosis = lt.includes("adenomyomatosis") || lt.includes("adenomyomat");

  // Denudation / necrosis
  extracted.denuded_epithelium = lt.includes("denuded");
  extracted.necrosis = lt.includes("necrotic") || lt.includes("necrosis");

  // Default reassurance unless explicitly stated otherwise
  extracted.dysplasia = lt.includes("dysplasia") && !lt.includes("no dysplasia") ? "Yes" : "No";
  extracted.malignancy = (lt.includes("malign") || lt.includes("carcinoma") || lt.includes("cancer")) && !lt.includes("no malignancy") ? "Yes" : "No";

  // Microscopy boilerplate defaults
  if (typeof extracted.wall_thickened !== "boolean") extracted.wall_thickened = true;
  if (typeof extracted.rokitansky_aschoff_sinuses !== "boolean") extracted.rokitansky_aschoff_sinuses = true;
}


// Deterministic overrides from raw text (reduces model variance)
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
if (crmDist !== null && Number.isFinite(crmDist)) {
  extracted.distance_to_crm_mm = crmDist;
}

    // Defaults
    if (!String(extracted.tumour_differentiation || "").trim()) extracted.tumour_differentiation = "Moderate";
    if (!String(extracted.proximal_margin_status || "").trim()) extracted.proximal_margin_status = "Normal";
    if (!String(extracted.distal_margin_status || "").trim()) extracted.distal_margin_status = "Normal";

    // Node logic
    extracted.has_positive_nodes = Number(extracted.nodes_positive || 0) > 0;
    if (extracted.has_positive_nodes && !String(extracted.positive_node_stations || "").trim()) {
      extracted.positive_node_stations = "[enter station(s)]";
    }

    // Staging
    extracted.pT = computePT(rules, extracted);

// Controlled depth phrase (never echo dictation)
if (extracted.pT === "T3") extracted.depth_phrase = "Invasion beyond muscularis propria.";
else if (extracted.pT === "T2") extracted.depth_phrase = "Invasion into muscularis propria.";
else extracted.depth_phrase = "Depth of invasion cannot be assessed from the description.";

    extracted.pN = computePN(rules, extracted.nodes_positive);
    
// CRM enforcement: only "involved" if < 1 mm (RCPath-style rule requested)
const crmNum = Number(extracted.distance_to_crm_mm);
if (Number.isFinite(crmNum)) {
  if (crmNum < 1) {
    extracted.circumferential_margin_status = "Involved: carcinoma within 1 mm of CRM.";
  } else {
    extracted.circumferential_margin_status = "Not involved: carcinoma more than 1 mm from CRM.";
  }
}

extracted.r_status = computeRStatus(rules, extracted);

    // Mandard ⇒ neoadjuvant + y-prefix
    extracted.mandard_descriptor = mandardDescriptor(rules, extracted.tumour_regression_grade);
    if (String(extracted.tumour_regression_grade || "").trim()) {
      extracted.neoadjuvant_therapy = "Yes";
      extracted.neoadjuvant_therapy_history = "Yes";
      extracted.y_prefix = true;
    } else {
      extracted.neoadjuvant_therapy = "No";
      extracted.neoadjuvant_therapy_history = "No";
      extracted.y_prefix = false;

if (!String(extracted.neoadjuvant_therapy_history || "").trim()) {
  extracted.neoadjuvant_therapy_history = String(extracted.neoadjuvant_therapy || "").trim() || "No";
}

    }

    // pM display
    const pm1 = String(extracted.pm1_disease || "").toLowerCase();
    extracted.pM = (pm1 === "yes" || pm1 === "m1" || pm1 === "true") ? "M1" : "";
    extracted.pM_display = extracted.pM ? extracted.pM : "Not applicable";

    let report_text = renderTemplate(template, extracted);

    const forbidden = ["not stated", "derived from", "inferred", "assumed"];
    report_text = report_text
      .split("\n")
      .filter(line => !forbidden.some(f => line.toLowerCase().includes(f)))
      .join("\n");

    return jsonResp(200, { report_text, caveats: buildCaveats(extracted) });

  } catch (e) {
    if (String(e && e.name) === "AbortError") {
      return jsonResp(504, { error: "OpenAI request timed out (try again)." });
    }
    return jsonResp(500, { error: e.message || "Server error" });
  }
};
