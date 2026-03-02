const ENGINE_VERSION = "accumulators-fixed5d-debug-LGI-v9";
const fs = require("fs");
const path = require("path");


function setFirstExisting(extracted, schema, keys, value) {
  const props = schema?.properties || {};
  for (const k of keys) {
    if (props[k]) { extracted[k] = value; return k; }
  }
  return null;
}

function mapToEnum(schema, field, desired) {
  const enums = schema?.properties?.[field]?.enum || null;
  if (!enums) return desired;
  if (enums.includes(desired)) return desired;

  const d = String(desired || "").toLowerCase();
  const pick = (cands) => cands.find(x => enums.includes(x));

  if (d === "involved") return pick(["Carcinoma","Involved","Yes","Positive","Present"]) || desired;
  if (d === "normal") return pick(["Normal","Not involved","No","Negative","Uninvolved","Clear"]) || desired;
  return desired;
}


/** ============================
 *  Accumulators (pT + nodes)
 *  ============================
 *  - Multiple pT mentions anywhere in dictation -> take WORST stage.
 *  - Multiple node tallies -> sum examined + positive (only when 'node(s)' is mentioned nearby).
 *  - Optional explicit overrides:
 *      - "final pT3" / "overall pT3"
 *      - "final nodes 1/8" / "overall nodes 1 of 8"
 */

const PT_RANK = new Map([
  ["TX", 0],
  ["T0", 1],
  ["Tis", 2],
  ["T1", 3], ["T1a", 4], ["T1b", 5],
  ["T2", 6],
  ["T3", 7],
  ["T4a", 8],
  ["T4b", 9],
]);

function normalizePTToken(tok) {
  if (!tok) return null;
  let t = String(tok).trim();
  t = t.replace(/^(?:yp|y|p)\s*/i, ""); // strip prefixes
  if (/^TIS$/i.test(t)) return "Tis";
  if (/^TX$/i.test(t)) return "TX";
  if (/^T0$/i.test(t)) return "T0";
  const m = t.match(/^(T\d)([ab])?$/i);
  if (m) return m[1].toUpperCase() + (m[2] ? m[2].toLowerCase() : "");
  const m4 = t.match(/^T4([ab])$/i);
  if (m4) return "T4" + m4[1].toLowerCase();
  return t;
}

function worstPT(tokens) {
  let best = "TX";
  let bestRank = PT_RANK.get(best) || 0;
  for (const tok of (tokens || [])) {
    const n = normalizePTToken(tok);
    const r = PT_RANK.get(n);
    if (r != null && r > bestRank) { best = n; bestRank = r; }
  }
  return best;
}

function extractPTCandidates(rawText) {
  const text = rawText || "";
  const finals = text.match(/\b(?:final|overall)\s+(?:y?\s*p?)?T(?:is|[0-4](?:a|b)?)\b/ig);
  if (finals && finals.length) {
    const last = finals[finals.length - 1];
    const mm = last.match(/T(?:is|[0-4](?:a|b)?)/i);
    return { candidates: [mm ? mm[0] : "TX"], isFinal: true };
  }
  const out = [];
  const rx = /\b(?:y?p)?T(?:is|[0-4](?:a|b)?)\b/ig;
  let m;
  while ((m = rx.exec(text)) !== null) out.push(m[0]);
  return { candidates: out, isFinal: false };
}

function extractNodeTallies(rawText) {
  const text = rawText || "";
  const lower = text.toLowerCase();

  // explicit override: "final nodes 1/8" / "overall nodes 1 of 8"
  const fm = lower.match(/\b(?:final|overall)\s+nodes?\s*(\d+)\s*(?:\/|of)\s*(\d+)\b/);
  if (fm) return { examined: parseInt(fm[2], 10), positive: parseInt(fm[1], 10), isFinal: true };

  let examined = 0;
  let positive = 0;

  // Split into small clauses to prevent double-counting within a phrase like "1/2 nodes"
  const clauses = text
    .replace(/\r/g, "\n")
    .replace(/[;]+/g, ".")
    .replace(/[,\n]+/g, ".")
    .split(".")
    .map(s => s.trim())
    .filter(Boolean);

  for (const clause of clauses) {
    const c = clause.toLowerCase();
    if (!c.includes("node")) continue;

    // Prefer fraction-style: "1/2 nodes", "1 of 2 nodes", "nodes 1/2", "nodes 1 of 2"
    let m = clause.match(/(\d+)\s*(?:\/|of)\s*(\d+)\s*nodes?\b/i) ||
            clause.match(/\bnodes?\b[^\d]{0,10}(\d+)\s*(?:\/|of)\s*(\d+)\b/i);
    if (m) {
      positive += parseInt(m[1], 10);
      examined += parseInt(m[2], 10);
      continue; // don't also count the "2 nodes" part again
    }

    // "3/12 involved" with node context in the same clause
    m = clause.match(/(\d+)\s*\/\s*(\d+)\s*(?:involved|positive)\b/i);
    if (m) {
      positive += parseInt(m[1], 10);
      examined += parseInt(m[2], 10);
      continue;
    }

    // "nodes 4 involved 1" / "4 nodes involved 1"
    m = clause.match(/\bnodes?\b[^\d]{0,10}(\d+)[^\d]{0,20}(?:involved|positive)\s*(\d+)\b/i) ||
        clause.match(/(\d+)\s*nodes?\b[^\d]{0,20}(?:involved|positive)\s*(\d+)\b/i);
    if (m) {
      examined += parseInt(m[1], 10);
      positive += parseInt(m[2], 10);
      continue;
    }

    // "nodes 4 negative" / "4 nodes negative"
    m = clause.match(/\bnodes?\b[^\d]{0,10}(\d+)\s*(?:all\s+)?(?:negative|clear|uninvolved)\b/i) ||
        clause.match(/(\d+)\s*nodes?\s*(?:all\s+)?(?:negative|clear|uninvolved)\b/i);
    if (m) {
      examined += parseInt(m[1], 10);
      continue;
    }

    // As a last resort: "2 nodes" / "nodes 2" => examined-only
    m = clause.match(/\bnodes?\b[^\d]{0,10}(\d+)\b/i) ||
        clause.match(/(\d+)\s*nodes?\b/i);
    if (m) {
      examined += parseInt(m[1], 10);
      continue;
    }
  }

  if (examined === 0 && positive === 0) return { examined: null, positive: null, isFinal: false };
  return { examined, positive, isFinal: false };
}


function applyAccumulators(rawText, schema, extracted) {
  const props = schema?.properties || {};

  // ---- pT accumulator ----
  const ptInfo = extractPTCandidates(rawText);
  if (ptInfo.candidates.length) {
    const worst = worstPT(ptInfo.candidates);
    extracted.__acc_pt = true;

    if (props.local_invasion_pT) extracted.local_invasion_pT = "p" + worst;
    if (props.stage_pT) extracted.stage_pT = worst;
    if (props.pT) extracted.pT = worst;
  }

  // ---- Nodes accumulator ----
  const nodeInfo = extractNodeTallies(rawText);
  if (nodeInfo.examined != null) {
    extracted.__acc_nodes = true;

    // Common field names across datasets
    if (props.nodes_examined) extracted.nodes_examined = nodeInfo.examined;
    if (props.nodes_positive) extracted.nodes_positive = nodeInfo.positive;

    if (props.nodes_total) extracted.nodes_total = nodeInfo.examined;
    if (props.nodes_involved) extracted.nodes_involved = nodeInfo.positive;

    if (props.total_examined) extracted.total_examined = nodeInfo.examined;
    if (props.number_positive) extracted.number_positive = nodeInfo.positive;

    // Heuristic fallback: set the first schema field that looks like totals / positives
    const keys = Object.keys(props);

    const examinedKey = keys.find(k => {
      const s = k.toLowerCase();
      if (!(s.includes("node") || s.includes("nodes"))) return false;
      if (s.includes("positive") || s.includes("involved")) return false;
      return s.includes("exam") || s.includes("total") || s.includes("present") || s.includes("retriev") || s.includes("count");
    });

    const positiveKey = keys.find(k => {
      const s = k.toLowerCase();
      if (!(s.includes("node") || s.includes("nodes"))) return false;
      return s.includes("positive") || s.includes("involved");
    });

    if (examinedKey && extracted[examinedKey] == null) extracted[examinedKey] = nodeInfo.examined;
    if (positiveKey && extracted[positiveKey] == null) extracted[positiveKey] = nodeInfo.positive;
  }
}


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
  const raw = String(text || "");
  const t = raw.toLowerCase();

  // Hard routing for shorthand biopsy modes
  if (/^\s*lgi\s*:/i.test(raw)) {
    const hit = manifests.find(mm => mm.id === "lgi_biopsy_shorthand_v1");
    if (hit) return { id: hit.id, manifest: hit, score: 999 };
  }
  if (/^\s*ugi\s*:/i.test(raw)) {
    const hit = manifests.find(mm => mm.id === "ugi_biopsy_shorthand_v1");
    if (hit) return { id: hit.id, manifest: hit, score: 999 };
  }

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

  const tooShort = mt.length < 25;
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

  mt = mt.replace(/\bThere is no dysplasia\b[^.]*\.?/gi, "").trim();
  mt = mt.replace(/\bThere is no dysplasia or malignancy\.\s*$/i, "").trim();

  if (mt && !mt.endsWith(".")) mt += ".";
  if (mt) mt += " ";
  mt += "There is no dysplasia or malignancy.";

  return mt.trim();
}

// ------------------------
// GIST helpers
// ------------------------
function firstNumber(x) {
  const s = String(x ?? "").replace(",", ".");
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

function parseGistSiteFromText(rawText) {
  const t = String(rawText || "").toLowerCase();

  // stomach / gastric / gastrectomy (covers "gastrectomy", "gastric", "gastr-")
  if (/\b(stomach|gastric|gastrectomy|gastrect|gastr)\b/.test(t)) return "stomach";

  // duodenum
  if (/\bduoden(al|um)?\b/.test(t)) return "duodenum";

  // jejunum / ileum / small bowel
  if (/\b(jejun(al|um)?|ile(al|um)?|jejunoileal|jejunal|ileal|small\s*bowel|\bsb\b)\b/.test(t)) return "jejunum/ileum";

  // rectum / rectal
  if (/\b(rectum|rectal)\b/.test(t)) return "rectum";

  return "";
}

function gistSiteToAfipBucket(siteOfTumour) {
  const s = String(siteOfTumour || "").toLowerCase();
  if (s.includes("stomach") || s.includes("gastric")) return "gastric";
  if (s.includes("duoden")) return "duodenum";
  if (s.includes("jejun") || s.includes("ile") || s.includes("small bowel")) return "jej_ile";
  if (s.includes("rect")) return "rectum";
  return "";
}

function defaultGistSpecimenType(siteOfTumour) {
  const s = String(siteOfTumour || "").toLowerCase();
  if (s.includes("rect")) return "Anterior resection";
  if (s.includes("stomach")) return "Gastrectomy";
  if (s.includes("duoden")) return "Duodenal resection";
  if (s.includes("jejun") || s.includes("ile") || s.includes("small bowel")) return "Small bowel resection";
  return "";
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

  return out
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
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


function computeColorectalLocalPTFromText(text) {
  const t = (text || "").toLowerCase();

  // T4b: direct invasion of other organs/structures
  if (/(invad|invasion).{0,40}(other organ|adjacent organ|bladder|uterus|vagina|prostate|seminal vesicle|small bowel|abdominal wall)/i.test(t)) return "T4b";

  // T4a: peritoneal surface/serosa
  if (/(serosa|serosal|peritoneal surface|visceral peritoneum|penetrates peritoneum)/i.test(t)) return "T4a";

  // T3: beyond muscularis propria (extramural)
  if (/(beyond muscularis propria|through the wall|transmural|extramural|pericolic fat|perirectal fat)/i.test(t)) return "T3";

  // T2: muscularis propria
  if (/muscularis propria/i.test(t)) return "T2";

  // T1: submucosa
  if (/submucosa/i.test(t)) return "T1";

  // fallback
  return null;
}

function parseBeyondMPDistanceMm(text) {
  const t = String(text || "");
  // Look for an explicit association with beyond muscularis / extramural depth
  const re = /(beyond\s+muscularis\s+propria|beyond\s+mp|extramural\s+(depth|spread)|distance\s+beyond\s+muscularis)[^\d]{0,40}(\d+(?:\.\d+)?)\s*mm/i;
  const m = t.match(re);
  if (!m) return null;
  return m[3]; // return as string to match colorectal schema
}

function parseCrmDistanceMmColorectal(text) {
  const t = String(text || "");
  const m = t.match(/\bcrm\b[^\d]{0,40}(\d+(?:\.\d+)?)\s*mm/i);
  if (!m) return null;
  return m[1]; // as string
}
function computePTFromText(text) {
  const t = (text || "").toLowerCase();

  // Oesophagus-specific advanced invasion triggers (TNM 9 style)
  // T4a: pleura / pericardium / diaphragm
  if (t.includes("pleura") || t.includes("pericard") || t.includes("diaphragm")) return "T4a";

  // T4b: invasion of adjacent structures (common dictation cues)
  if (t.includes("aorta") || t.includes("trachea") || t.includes("bronch") || t.includes("vertebr") || t.includes("heart")) return "T4b";

  // Generic: through the wall / beyond muscularis propria etc.
  if (t.includes("beyond muscularis propria") || t.includes("through the wall") || t.includes("through wall") ||
      t.includes("beyond the wall") || t.includes("through muscularis propria") || t.includes("adventitia")) return "T3";

  if (t.includes("within the wall") || t.includes("into the wall") || t.includes("muscularis propria")) return "T2";

  return "TX";
}


function depthPhraseFromPT(pT) {
  if (pT === "T4b") return "Tumour invades adjacent structures.";
  if (pT === "T4a") return "Tumour invades pleura/pericardium/diaphragm.";
  if (pT === "T3") return "Invasion beyond muscularis propria.";
  if (pT === "T2") return "Invasion into muscularis propria.";
  return "Depth of invasion cannot be assessed from the description.";
}

function computePNFromRules(rules, nodesPositive) {
  const mapping = rules?.pn_mapping_by_positive_nodes || [];
  const n = Number(nodesPositive || 0);
  if (Number.isFinite(n) && n === 0) return "N0";
  for (const band of mapping) if (n >= band.min && n <= band.max) return band.set;
  return "NX";
}

function derivePNFromSchema(schema, nodesPositive) {
  const n = Number(nodesPositive || 0);

  // Prefer schema.properties.pN.enum; fall back to stage_pN enum (used by some datasets like colorectal)
  const enums =
    schema?.properties?.pN?.enum ||
    schema?.properties?.stage_pN?.enum ||
    null;

  if (!Array.isArray(enums)) return null;

  // Colorectal-style enums (N1a/N1b/N1c/N2a/N2b)
  if (enums.some(e => String(e).includes("N1a")) || enums.some(e => String(e).includes("N2a"))) {
    if (n === 0) return "N0";
    if (n === 1) return "N1a";
    if (n >= 2 && n <= 3) return "N1b";
    // N1c is tumour deposits without node mets; we can't infer reliably from node counts alone.
    if (n >= 4 && n <= 6) return "N2a";
    if (n >= 7) return "N2b";
    return "NX";
  }

  // Gastric-style enums (N3a/N3b present)
  if (enums.some(e => String(e).includes("N3a")) || enums.some(e => String(e).includes("N3b"))) {
    if (n === 0) return "N0";
    if (n >= 1 && n <= 2) return "N1";
    if (n >= 3 && n <= 6) return "N2";
    if (n >= 7 && n <= 15) return "N3a";
    if (n >= 16) return "N3b";
    return "NX";
  }

  // Oesophagus-style enums (N0/N1/N2/N3 only)
  if (enums.includes("N0") && enums.includes("N1") && enums.includes("N2") && enums.includes("N3") && !enums.some(e => String(e).includes("N1a"))) {
    if (n === 0) return "N0";
    if (n >= 1 && n <= 2) return "N1";
    if (n >= 3 && n <= 6) return "N2";
    if (n >= 7) return "N3";
    return "NX";
  }

  return null;
}


function finalizeStaging(schema, extracted) {
  const props = schema?.properties || {};
  const nPos =
    (extracted.nodes_positive != null) ? extracted.nodes_positive :
    (extracted.nodes_involved != null) ? extracted.nodes_involved :
    (extracted.number_positive != null) ? extracted.number_positive :
    null;

  if (nPos == null) return;

  const derived = derivePNFromSchema(schema, nPos);
  if (!derived) return;

  if (props.pN) extracted.pN = derived;
  if (props.stage_pN) extracted.stage_pN = derived;

  // Some templates print "pN: {{stage_pN}}" but still want a pN-like value around
  if (!props.pN) extracted.pN = derived;
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
// ------------------------
// LGI biopsy shorthand (deterministic, no LLM)
// Triggered by text starting with "LGI:"
// Format: "LGI: A - <site> <tokens>; B - <site> <tokens>"
// Also supports range shortcut: "LGI: A-D n" (generic normal for A..D)
// ------------------------

const LGI_SITE_ALIASES = new Map([
  ["ti", "Terminal ileum"], ["terminalileum", "Terminal ileum"], ["terminal", "Terminal ileum"], ["ileum", "Terminal ileum"],
  ["cae", "Caecum"], ["cecum", "Caecum"], ["caecum", "Caecum"],
  ["asc", "Ascending colon"], ["ascending", "Ascending colon"],
  ["tra", "Transverse colon"], ["transverse", "Transverse colon"],
  ["des", "Descending"], ["descending", "Descending"],
  ["sig", "Sigmoid"], ["sigmoid", "Sigmoid"],
  ["rec", "Rectum"], ["rectum", "Rectum"], ["rectal", "Rectum"],
  ["colon", "Colon"]
]);

function lgiNormalizeToken(tok) {
  if (!tok) return null;
  let t = String(tok).trim().toLowerCase();
  if (!t) return null;
  t = t.replace(/[()]/g, "");
  // collapse phrases
  t = t.replace(/\s+/g, " ");
  if (["n","normal","wnl","within normal limits","no abnormality"].includes(t)) return "n";

  if (t === "ad" || t === "architectural distortion" || t === "distortion") return "ad";
  if (t === "bp" || t === "basal plasmacytosis") return "bp";

  if (t === "cryp" || t === "cryptitis") return "cryp";
  if (t === "absc" || t === "crypt abscess" || t === "crypt abscesses") return "absc";
  if (t === "gran" || t === "granuloma" || t === "granulomas") return "gran";
  if (t === "cgran" || t === "cryptolytic granuloma" || t === "cryptolytic granulomas" || t === "ruptured crypt granuloma" || t === "ruptured crypt granulomas") return "cgran";
  if (t === "ulc" || t === "ulcer" || t === "ulceration" || t === "ulcerated") return "ulc";
  if (t === "pat" || t === "patch" || t === "patchy") return "pat";
  if (t === "dif" || t === "diff" || t === "diffuse") return "dif";
  if (t === "uc" || t === "ulcerative colitis") return "uc";

  if (t === "isch" || t === "ischaemia" || t === "ischemia" || t === "ischaemic" || t === "ischemic") return "isch";
  if (t === "wither" || t === "withered crypts" || t === "withered") return "wither";

  if (t === "cmv" || t === "cytomegalovirus") return "cmv";
  if (t === "drug" || t === "drug effect" || t === "medication" || t === "medication related") return "drug";
  if (t === "eos" || t === "eosinophils" || t === "eosinophilia") return "eos";

  // polyp types (short + full)
  if (t === "ta" || t === "tubular adenoma") return "TA";
  if (t === "tva" || t === "tubulovillous adenoma") return "TVA";
  if (t === "v" || t === "villous adenoma" || t === "villous") return "V";
  if (t === "hp" || t === "hyperplastic polyp" || t === "hyperplastic") return "HP";
  if (t === "ssl" || t === "sessile serrated lesion" || t === "sessile serrated") return "SSL";
  if (t === "tsa" || t === "traditional serrated adenoma") return "TSA";

  if (t === "e" || t === "excised" || t === "excision complete") return "e";
  if (t === "ne" || t === "not excised" || t === "cannot be guaranteed" || t === "excision cannot be guaranteed") return "ne";

  if (t === "dys" || t === "dysplasia") return "dys";
  if (t === "hg" || t === "high grade") return "HGD";
  if (t === "hgd" || t === "high grade dysplasia") return "HGD";
  if (t === "inv" || t === "invasive" || t === "invasive carcinoma" || t === "malignancy") return "inv";

  // size token: 3mm / 12 mm
  const mm = t.match(/^(\d+(?:\.\d+)?)\s*mm$/);
  if (mm) return mm[1] + "mm";

  return t;
}

function lgiParseSite(siteTok) {
  if (!siteTok) return "Colon";
  const raw = String(siteTok).trim().toLowerCase().replace(/\s+/g, "");
  return LGI_SITE_ALIASES.get(raw) || (siteTok.trim().charAt(0).toUpperCase() + siteTok.trim().slice(1));
}

function lgiSplitSegments(rawText) {
  let body = String(rawText || "");
  body = body.replace(/^\s*lgi\s*:\s*/i, "");
  body = body.replace(/\r/g, "\n");

  // People will separate parts with newlines, semicolons, or commas:
  //   "A - ...; B - ..."  OR  "A - ..., B - ..."  OR each on its own line.
  // Only treat commas as separators when they precede another specimen label.
  body = body.replace(/,\s*(?=[A-Z]\s*-\s*)/g, "; ");

  const parts = body
    .split(/[\n;]+/)
    .map(s => s.trim())
    .filter(Boolean);

  return parts;
}

function lgiExpandRangeShortcut(seg) {
  // e.g. "A-D n" or "A - D n"
  // Only treat as a range if the second label is a *single* letter (so "A - TI n" is NOT misread as A–T)
  const m = seg.match(/^([A-Z])\s*-\s*([A-Z])(?![A-Za-z])\s*(.*)$/);
  if (!m) return null;
  const a = m[1].charCodeAt(0);
  const b = m[2].charCodeAt(0);
  if (b < a) return null;
  const tail = (m[3] || "").trim();
  const tokens = tail ? tail : "n";
  const out = [];
  for (let c=a; c<=b; c++){
    out.push(String.fromCharCode(c) + " - " + tokens);
  }
  return out;
}

function lgiParseLine(line) {
  // Standard: "A - rectum ad cryp cmv" OR shortcut-expanded "A - n"
  const mm = line.match(/^([A-Z])\s*-\s*(.*)$/);
  if (!mm) return null;
  const label = mm[1];
  let rest = (mm[2] || "").trim();
  if (!rest) rest = "n";

  // Tokenize by commas + spaces, but keep phrases "withered crypts"
  rest = rest.replace(/,/g, " ");
  const rawToks = rest.split(/\s+/).filter(Boolean);

  // If first token looks like a site, use it; otherwise default to colon.
  let site = "Colon";
  let startIdx = 0;

  if (rawToks.length) {
    const maybeSite = rawToks[0];
    const normSite = maybeSite.toLowerCase();
    if (LGI_SITE_ALIASES.has(normSite) || LGI_SITE_ALIASES.has(normSite.replace(/\s+/g,"")) || ["ti","ileum","rectum","sigmoid","caecum","cecum","colon"].includes(normSite)) {
      site = lgiParseSite(maybeSite);
      startIdx = 1;
    } else if (rawToks.length >= 2) {
      // handle "terminal ileum"
      const two = (rawToks[0] + " " + rawToks[1]).toLowerCase();
      if (two === "terminal ileum") {
        site = "Terminal ileum";
        startIdx = 2;
      }
    }
  }

  // re-join for phrase matching
  const joined = rawToks.slice(startIdx).join(" ").toLowerCase();
  const phraseTokens = [];
  if (joined.includes("withered crypt")) phraseTokens.push("withered crypts");
  if (joined.includes("cryptolytic granuloma")) phraseTokens.push("cryptolytic granulomas");
  if (joined.includes("ruptured crypt granuloma")) phraseTokens.push("ruptured crypt granulomas");
  if (joined.includes("ulcerative colitis")) phraseTokens.push("ulcerative colitis");
  // split remaining
  const toks = [];
  for (const pt of phraseTokens) {
    // remove phrase from joined by marking; we will also add its normalized token
    toks.push(pt);
  }
  for (const t of rawToks.slice(startIdx)) toks.push(t);

  const norm = toks.map(lgiNormalizeToken).filter(Boolean);

  return { label, site, tokens: norm };
}

function lgiRenderPart(p) {
  const site = p.site;
  const toks = new Set(p.tokens);

  // Polyp object detection
  const size = p.tokens.find(t => /mm$/.test(t) && /^\d/.test(t)) || "";
  const polypType = p.tokens.find(t => ["TA","TVA","V","HP","SSL","TSA"].includes(t)) || "";
  const exc = toks.has("e") ? "e" : toks.has("ne") ? "ne" : "";
  const dys = toks.has("HGD") ? "HGD" : toks.has("dys") ? "dys" : "";
  const inv = toks.has("inv");

  const hasIsch = toks.has("isch") || toks.has("wither");
  const hasCmv = toks.has("cmv");
  const hasDrug = toks.has("drug") || toks.has("eos");
  const hasChronic = toks.has("ad") || toks.has("bp");
  const hasActive = toks.has("cryp") || toks.has("absc");
  const hasGran = toks.has("gran");
  const hasCryptolyticGran = toks.has("cgran");
  const hasUlc = toks.has("ulc");
  const hasUc = toks.has("uc");
  const extent = toks.has("dif") ? "diffuse" : toks.has("pat") ? "patchy" : "";

  // Normal
  if (toks.has("n") && !polypType && !hasIsch && !hasCmv && !hasDrug && !hasChronic && !hasActive && !hasGran) {
    if (site === "Terminal ileum") {
      return `${p.label} (${site}): Small bowel mucosa is within normal limits. No active ileitis is seen.`;
    }
    return `${p.label} (${site}): Colonic mucosa is within normal limits. No active colitis is seen.`;
  }

  // Polyp
  if (polypType) {
    const isAdenoma = ["TA","TVA","V","TSA"].includes(polypType);
    const typePhrase =
      polypType === "TA" ? "tubular adenoma" :
      polypType === "TVA" ? "tubulovillous adenoma" :
      polypType === "V" ? "villous adenoma" :
      polypType === "HP" ? "hyperplastic polyp" :
      polypType === "SSL" ? "sessile serrated lesion" :
      polypType === "TSA" ? "traditional serrated adenoma" :
      "polyp";

    const sizePhrase = size ? `${size.replace("mm"," mm")} ` : "";
    const grade = isAdenoma ? (dys === "HGD" ? "high-grade" : "low-grade") : "";
    const polypDescriptor = `${sizePhrase}${grade ? grade + " " : ""}${typePhrase}`.trim();
    const article = /^[aeiou8]/i.test(polypDescriptor) ? "an" : "a";

    // First sentence
    let s = `${p.label} (${site}): Colonic mucosa contains ${article} ${polypDescriptor}`;
    if (exc === "e") s += " which appears excised.";
    else if (exc === "ne") s += ". Excision cannot be guaranteed.";
    else s += ".";

    // Dysplasia statements
    if (isAdenoma) {
      if (!inv) {
        if (grade === "high-grade") s += " No invasive malignancy is identified.";
        else s += " No high-grade dysplasia is identified. No invasive malignancy is identified.";
      }
      else s += " Invasive malignancy is identified.";
    } else {
      if (dys === "HGD") s += " Dysplasia is identified.";
      else if (dys === "dys") s += " Dysplasia is identified.";
      else s += " No dysplasia is identified.";
      if (!inv) s += " No invasive malignancy is identified.";
      else s += " Invasive malignancy is identified.";
    }

    return s;
  }

  // Inflammatory patterns
  let s = `${p.label} (${site}): `;
  if (hasIsch) {
    s += "Features are in keeping with ischaemic-type mucosal injury";
    if (toks.has("wither")) s += " including withered crypts";
    s += ".";
    if (!hasChronic && !hasGran) s += " No dysplasia or malignancy is identified.";
    return s;
  }

  const bits = [];
  if (extent) bits.push(`${extent} chronic inflammatory change`);
  if (hasChronic) bits.push("architectural distortion");
  if (hasActive) bits.push(toks.has("absc") ? "cryptitis and crypt abscesses" : "cryptitis");
  if (hasUlc) bits.push("ulceration");
  if (hasGran) bits.push("granulomas");
  if (hasCryptolyticGran) bits.push("cryptolytic granulomas");
  if (bits.length) {
    s += "Colonic mucosa shows " + bits.join(" with ") + ".";
  } else {
    s += "Colonic mucosa shows non-specific inflammatory changes.";
  }

  if (hasCryptolyticGran) s += " These are interpreted as crypt injury-related granulomas and are not specific for Crohn disease.";

  if (hasUc) {
    const nancy = hasUlc ? 4 : toks.has("absc") ? 3 : toks.has("cryp") ? 2 : hasChronic ? 1 : 0;
    s += ` In ulcerative colitis context, Nancy index score is ${nancy}.`;
  }

  if (hasCmv) s += " CMV infection is suspected; correlate with immunohistochemistry.";
  if (hasDrug) s += " Features of drug-related injury are considered in the differential diagnosis.";
  s += " There is no dysplasia or malignancy.";
  return s;
}

function lgiBuildConclusion(parts) {
  const allTokens = new Set();
  for (const p of parts) for (const t of p.tokens) allTokens.add(t);

  const hasIsch = allTokens.has("isch") || allTokens.has("wither");
  const hasCmv = allTokens.has("cmv");
  const hasDrug = allTokens.has("drug") || allTokens.has("eos");
  const hasChronic = allTokens.has("ad") || allTokens.has("bp");
  const hasActive = allTokens.has("cryp") || allTokens.has("absc");
  const hasGran = allTokens.has("gran");
  const hasCryptolyticGran = allTokens.has("cgran");
  const hasUlc = allTokens.has("ulc");
  const hasUc = allTokens.has("uc");
  const hasPatchy = allTokens.has("pat");
  const hasDiffuse = allTokens.has("dif");
  const hasPolyp = [...allTokens].some(t => ["TA","TVA","V","HP","SSL","TSA"].includes(t));

  const distribution = hasDiffuse ? "diffuse" : hasPatchy ? "patchy" : "";
  const activity = hasUlc ? "severely active" : allTokens.has("absc") ? "moderately active" : hasActive ? "mildly active" : hasChronic ? "chronic inactive" : "quiescent";
  const nancy = hasUlc ? 4 : allTokens.has("absc") ? 3 : allTokens.has("cryp") ? 2 : hasChronic ? 1 : 0;

  // Priority: ischemia -> CMV -> IBD -> acute -> polyp -> normal
  if (hasIsch && !hasChronic && !hasGran) return "Features are in keeping with ischaemic-type mucosal injury. Correlate clinically/endoscopically.";
  if (hasCmv) {
    if (hasChronic) return "Features are in keeping with chronic colitis with superimposed CMV infection suspected. Correlate clinically and perform CMV immunohistochemistry as appropriate.";
    return "CMV infection is suspected. Correlate clinically and perform CMV immunohistochemistry as appropriate.";
  }
  if (hasUc) {
    const dist = distribution ? `${distribution} ` : "";
    return `Features are in keeping with ${dist}${activity} ulcerative colitis (Nancy index score ${nancy}). Correlate with endoscopic findings and treatment context.`;
  }
  if (hasCryptolyticGran && !hasGran) return "Features are in keeping with colitis with cryptolytic granulomas (crypt injury-related); these do not in themselves indicate Crohn disease. Correlate clinically/endoscopically.";
  if (hasChronic || hasGran) {
    if (hasGran) return "Features are in keeping with chronic colitis; inflammatory bowel disease is favoured (Crohn disease is suggested by non-cryptolytic granulomas). Correlate clinically/endoscopically.";
    return "Features are in keeping with chronic colitis; inflammatory bowel disease is favoured. Correlate clinically/endoscopically.";
  }
  if (hasActive) return "Features are in keeping with active colitis without convincing chronicity. Correlate clinically (infective/drug-related causes may be considered).";
  if (hasPolyp) return "Biopsies show a polyp/adenoma as described. Background mucosa is otherwise unremarkable.";
  return "No histological evidence of colitis. No features of microscopic colitis are identified.";
}

function lgiProcess(rawText) {
  const segs0 = lgiSplitSegments(rawText);
  const segs = [];
  for (const s of segs0) {
    const exp = lgiExpandRangeShortcut(s);
    if (exp) segs.push(...exp);
    else segs.push(s);
  }

  const parts = [];
  for (const s of segs) {
    const p = lgiParseLine(s);
    if (p) parts.push(p);
  }

  // If user used range shortcut without sites, ensure we still render parts
  const partsText = parts
    .map(p => String(lgiRenderPart(p) || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const conclusion = lgiBuildConclusion(parts);

  return { parts_text: partsText, conclusion_text: conclusion };
}

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
    // Hard override: if the user explicitly starts with "LGI:", do NOT let keyword scoring pick colorectal cancer etc.
    let picked = null;
    if (/^\s*lgi\s*:/i.test(rawText)) {
      const m = manifests.find(x => x.id === "lgi_biopsy_shorthand_v1" || x.id === "lgi_shorthand_v1" || x.id === "lgi_biopsies_v1");
      if (m) picked = { id: m.id, manifest: m, score: 999 };
    }
    if (!picked) picked = pickDataset(rawText, manifests);
    if (!picked) return jsonResp(400, { error: "Could not confidently select a dataset. Please include site/specimen." });


    const datasetId = picked.id;
    const manifest = picked.manifest;
    const { schema, rules, template } = readDatasetFiles(datasetId);

    let extracted = {};

    if (manifest.pipeline?.mode === "lgi_shorthand_v1") {
      extracted = applyDefaults(schema, {});
      const out = lgiProcess(rawText);
      extracted.parts_text = out.parts_text;
      extracted.conclusion_text = out.conclusion_text;

    } else if (manifest.pipeline?.mode === "keyword_short_report") {
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

      // Apply accumulators: multiple pT mentions + multiple node tallies
      applyAccumulators(rawText, schema, extracted);

      // --------------------------
      // GIST deterministic staging + AFIP + site/specimen hardening
      // --------------------------
      if (datasetId === "gist_resection_rcpath_v1") {
        // force site if blank
        const parsedSite = parseGistSiteFromText(rawText);
        if (!String(extracted.site_of_tumour || "").trim() && parsedSite) {
          extracted.site_of_tumour = parsedSite; // matches schema examples
        }

        // specimen default if blank
        if (!String(extracted.specimen_type || "").trim()) {
          const defSpec = defaultGistSpecimenType(extracted.site_of_tumour);
          if (defSpec) extracted.specimen_type = defSpec;
        }

        // parse size (cm)
        let size = firstNumber(extracted.maximum_tumour_dimension_cm);
        const sizeRaw = String(extracted.maximum_tumour_dimension_cm ?? "").toLowerCase();
        if (Number.isFinite(size) && /\bmm\b/.test(sizeRaw)) size = size / 10;

        // parse mitoses / 5mm2
        const mit = firstNumber(extracted.mitotic_count_per_5mm2);

        // TNM pT from size only
        if (Number.isFinite(size) && size > 0) {
          if (size <= 2) extracted.tnm_pT = "T1";
          else if (size <= 5) extracted.tnm_pT = "T2";
          else if (size <= 10) extracted.tnm_pT = "T3";
          else extracted.tnm_pT = "T4";
        } else {
          extracted.tnm_pT = "TX";
        }

        // TNM pN from nodes positive
        extracted.tnm_pN = (Number(extracted.lymph_nodes_positive || 0) > 0) ? "N1" : "N0";

        // TNM pM from metastasis flags
        const m1 = (
          String(extracted.peritoneal_metastasis || "").toLowerCase().includes("present") ||
          String(extracted.liver_metastasis || "").toLowerCase().includes("present") ||
          String(extracted.other_metastasis || "").toLowerCase().includes("present")
        );
        extracted.tnm_pM = m1 ? "M1" : "";
        extracted.tnm_pM_display = m1 ? "M1" : "Not applicable";

        // AFIP risk (STRICT)
        const siteBucket = gistSiteToAfipBucket(extracted.site_of_tumour);

        function afip(site, size, mit) {
          if (!site || !Number.isFinite(size) || !Number.isFinite(mit)) return "Not appropriate";
          const le5 = mit <= 5;

          if (le5 && size <= 2) return "None";

          if (le5 && size > 2 && size <= 5) {
            if (site === "gastric") return "Very low";
            if (site === "duodenum") return "Low";
            if (site === "jej_ile") return "Low";
            if (site === "rectum") return "Low";
          }

          if (le5 && size > 5 && size <= 10) {
            if (site === "gastric") return "Low";
            if (site === "jej_ile") return "Moderate";
            return "Not appropriate";
          }

          if (le5 && size > 10) {
            if (site === "gastric") return "Moderate";
            if (site === "duodenum") return "High";
            if (site === "jej_ile") return "High";
            if (site === "rectum") return "High";
          }

          if (!le5 && size <= 2) {
            if (site === "rectum") return "High";
            return "Not appropriate";
          }

          if (!le5 && size > 2 && size <= 5) {
            if (site === "gastric") return "Moderate";
            if (site === "duodenum") return "High";
            if (site === "jej_ile") return "High";
            if (site === "rectum") return "High";
          }

          if (!le5 && size > 5 && size <= 10) {
            if (site === "gastric") return "High";
            if (site === "jej_ile") return "High";
            return "Not appropriate";
          }

          if (!le5 && size > 10) return "High";

          return "Not appropriate";
        }

        extracted.afip_risk_category = afip(siteBucket, size, mit);

        if (extracted.afip_risk_category === "High") {
          extracted.mutational_analysis_requested = "It will follow (requested and reported separately)";
        }
      }

      // --------------------------
      // Colorectal guard: highest node involved defaults to No unless mentioned
      // --------------------------
      if (datasetId === "colorectal_resection_rcpath_v1") {
        const t = rawText.toLowerCase();
        const mentionsHighest = /highest\s+node/i.test(t);

        if (!mentionsHighest) {
          extracted.highest_node_involved = "No";
        } else {
          const windowMatch = t.match(/highest\s+node[^.\n]{0,120}/i)?.[0] || "";
          if (/\b(yes|involved|positive)\b/i.test(windowMatch)) extracted.highest_node_involved = "Yes";
          else if (/\b(no|not involved|negative|uninvolved)\b/i.test(windowMatch)) extracted.highest_node_involved = "No";
          else extracted.highest_node_involved = "No";
        }
      }

      // --------------------------
      // Deterministic overrides from raw text (generic)
      // --------------------------
      const nodeParsed = parseNodes(rawText);
      // Only apply single-match node parsing if accumulators did NOT already find node tallies.
      if (nodeParsed && !extracted.__acc_nodes) {
        extracted.nodes_positive = nodeParsed.pos;
        extracted.nodes_examined = nodeParsed.total;
      }

      const prox = parseMarginStatus(rawText, "proximal");
const dist = parseMarginStatus(rawText, "distal");

// Dataset-aware margin assignment
if (datasetId === "colorectal_resection_rcpath_v1") {
  // Colorectal uses Yes/No flags
  if (prox) extracted.longitudinal_margin_involved = (prox === "Involved") ? "Yes" : "No";
  if (dist) extracted.distal_margin_involved = (dist === "Involved") ? "Yes" : "No";
} else {
  // Oesophagus/gastrectomy style categorical margins
  if (prox) {
    const k = setFirstExisting(extracted, schema, ["proximal_margin","proximal_margin_status"], null);
    if (k) extracted[k] = mapToEnum(schema, k, prox);
  }
  if (dist) {
    const k = setFirstExisting(extracted, schema, ["distal_margin","distal_margin_status"], null);
    if (k) extracted[k] = mapToEnum(schema, k, dist);
  }
}

      // CRM distance
if (datasetId === "colorectal_resection_rcpath_v1") {
  const crmDistStr = parseCrmDistanceMmColorectal(rawText);
  if (crmDistStr !== null) {
    extracted.distance_to_crm_mm = crmDistStr;
    const crmNumCol = Number(crmDistStr);
    if (Number.isFinite(crmNumCol)) {
      extracted.circumferential_margin_involved = (crmNumCol < 1) ? "Yes" : "No";
    }
  }
} else {
  const crmDist = parseCrmDistanceMm(rawText);
  if (crmDist !== null && Number.isFinite(crmDist)) extracted.distance_to_crm_mm = crmDist;
}

      const crmRaw = extracted.distance_to_crm_mm;
      const crmNum = (crmRaw === null || crmRaw === undefined || String(crmRaw).trim() === "") ? NaN : Number(crmRaw);
      if (Number.isFinite(crmNum)) {
        // Use enum-aligned strings (no trailing full stop)
        if (crmNum < 1) extracted.circumferential_margin_status = "Involved: carcinoma within 1 mm of CRM";
        else extracted.circumferential_margin_status = "Not involved: carcinoma more than 1 mm from CRM";
      }

      // Staging + phrases (oesoph/gastric etc.): prefer deterministic cues from the raw text.
      // Only override when we can confidently infer a stage.
      if (datasetId !== "colorectal_resection_rcpath_v1" && datasetId !== "lgi_biopsies_v1") {
        const detPT = computePTFromText(rawText);
        if (detPT && detPT !== "TX") {
          extracted.pT = detPT;
          if (schema?.properties?.stage_pT) extracted.stage_pT = detPT;
        }
      }
      extracted.depth_phrase = depthPhraseFromPT(extracted.pT || "TX");

// Colorectal: derive local invasion pT + stage_pT from colorectal-specific wording
if (datasetId === "colorectal_resection_rcpath_v1") {
  const colT = computeColorectalLocalPTFromText(rawText); // returns e.g. T3
  if (colT) {
    extracted.local_invasion_pT = "p" + colT;
    extracted.stage_pT = colT;
    // Some templates still use {{pT}} for TNM display.
    extracted.pT = colT;
  }

  // Extramural depth beyond muscularis: only applicable for pT3+
  const ptVal = String(extracted.local_invasion_pT || "").toLowerCase();
  if (ptVal && (ptVal.startsWith("pt3") || ptVal.startsWith("pt4"))) {
    const beyond = parseBeyondMPDistanceMm(rawText);
    if (beyond !== null) extracted.max_distance_beyond_muscularis_mm = beyond;
  } else {
    extracted.max_distance_beyond_muscularis_mm = "Not applicable";
  }

  // Stage_pM from distant metastasis flag if present
  const dm = String(extracted.distant_metastasis_confirmed || "").toLowerCase();
  extracted.stage_pM = dm.includes("yes") ? "M1" : "Not applicable";
}
      if (datasetId !== "colorectal_resection_rcpath_v1") {
        extracted.pN = computePNFromRules(rules, extracted.nodes_positive);
      }
extracted.r_status = computeRStatusFromRules(rules, extracted);

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

      const pm1 = String(extracted.pm1_disease || "").toLowerCase();
      extracted.pM = (pm1 === "yes" || pm1 === "m1" || pm1 === "true") ? "M1" : "";
      extracted.pM_display = extracted.pM ? extracted.pM : "Not applicable";

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
    // Re-apply accumulators at the end to override any later single-match parsing
    applyAccumulators(rawText, schema, extracted);
    finalizeStaging(schema, extracted);

    let report_text = renderTemplate(template, extracted)
      .split("\n")
      .filter(line => !forbidden.some(f => line.toLowerCase().includes(f)))
      .join("\n");

    return jsonResp(200, {
      report_text,
      caveats: buildCaveats(extracted, datasetId),
      dataset_id: datasetId,
      engine_version: ENGINE_VERSION,
      debug: {
        nodes_examined: extracted.nodes_examined,
        nodes_positive: extracted.nodes_positive,
        pN: extracted.pN,
        stage_pN: extracted.stage_pN,
        schema_pN_enum: schema?.properties?.pN?.enum || null
      }
    });

  } catch (e) {
    if (String(e && e.name) === "AbortError") return jsonResp(504, { error: "OpenAI request timed out (try again)." });
    return jsonResp(500, { error: e.message || "Server error" });
  }
};
