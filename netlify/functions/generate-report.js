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


// ------------------------
// LGI biopsy shorthand (deterministic, no LLM)
// Trigger: prefix "LGI:" then specimen lines like "A - TI n" or "B - cae ad cryp gran".
// Supports shorthand tokens AND full words.
// ------------------------

const LGI_SITE_ALIASES = [
  ["terminal ileum", "TI"], ["ti", "TI"], ["ileum", "TI"],
  ["caecum", "cae"], ["cecum", "cae"], ["cae", "cae"],
  ["ascending", "asc"], ["asc", "asc"], ["right colon", "asc"],
  ["transverse", "tra"], ["tra", "tra"],
  ["descending", "des"], ["des", "des"], ["left colon", "des"],
  ["sigmoid", "sig"], ["sig", "sig"],
  ["rectum", "rec"], ["rectal", "rec"], ["rec", "rec"],
];

function normLGISite(raw) {
  const s = String(raw || "").trim().toLowerCase();
  for (const [k, v] of LGI_SITE_ALIASES) {
    if (s === k) return v;
    if (s.startsWith(k + " ")) return v;
  }
  const first = s.split(/\s+/)[0];
  for (const [k, v] of LGI_SITE_ALIASES) if (first === k) return v;
  return "";
}

function lgiSiteLabel(site) {
  const m = { TI:"Terminal ileum", cae:"Caecum", asc:"Ascending colon", tra:"Transverse colon", des:"Descending colon", sig:"Sigmoid colon", rec:"Rectum" };
  return m[site] || site || "Site not stated";
}

function lgiMucosaLabel(site) {
  if (site === "TI") return "Small bowel mucosa";
  return "Large bowel mucosa";
}

function parsePolypDescriptor(tail) {
  const t = String(tail || "").toLowerCase();

  const sizeM = t.match(/\b(\d+(?:\.\d+)?)\s*(mm|cm)\b/);
  let sizeMm = null;
  if (sizeM) {
    const val = Number(sizeM[1]);
    if (Number.isFinite(val)) sizeMm = (sizeM[2] === "cm") ? (val * 10) : val;
  }

  const typeMap = [
    ["tubulovillous adenoma", "TVA"],
    ["tubulo-villous adenoma", "TVA"],
    ["tubular adenoma", "TA"],
    ["villous adenoma", "V"],
    ["traditional serrated adenoma", "TSA"],
    ["sessile serrated lesion", "SSL"],
    ["sessile serrated", "SSL"],
    ["hyperplastic polyp", "HP"],
  ];

  let polypType = null;
  for (const [phrase, code] of typeMap) if (t.includes(phrase)) polypType = code;

  if (!polypType) {
    if (/\bta\b/.test(t)) polypType = "TA";
    else if (/\btva\b/.test(t)) polypType = "TVA";
    else if (/\bv\b/.test(t) && !/\biv\b/.test(t)) polypType = "V";
    else if (/\bhp\b/.test(t)) polypType = "HP";
    else if (/\bssl\b/.test(t)) polypType = "SSL";
    else if (/\btsa\b/.test(t)) polypType = "TSA";
  }

  if (!polypType) return null;

  const excised = /\be\b/.test(t) || t.includes("appears excised") || t.includes("appears completely excised");
  const notGuaranteed = /\bne\b/.test(t) || t.includes("excision cannot be guaranteed") || t.includes("cannot guarantee excision") || t.includes("cannot be guaranteed");

  const hgd = /\bhgd\b/.test(t) || t.includes("high grade dysplasia") || t.includes("high-grade dysplasia");
  const dys = /\bdys\b/.test(t) || t.includes("dysplasia");
  const invasive = /\binv\b/.test(t) || t.includes("invasive") || t.includes("adenocarcinoma");

  return { sizeMm, polypType, excised, notGuaranteed, hgd, dys, invasive };
}

function parseLGIShorthand(rawText) {
  const raw = String(rawText || "");
  const body = raw.replace(/^\s*lgi\s*:\s*/i, "").trim();

  const lines = body
    .replace(/\r/g, "\n")
    .split(/\n|;/)
    .map(s => s.trim())
    .filter(Boolean);

  const parts = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z])\s*-\s*(.+)$/);
    if (!m) continue;
    const letter = m[1];
    const rest = m[2].trim();
    const siteNorm = normLGISite(rest);

    let tail = rest;
    if (siteNorm) {
      const low = rest.toLowerCase();
      for (const [k, v] of LGI_SITE_ALIASES) {
        if (v === siteNorm && low.startsWith(k + " ")) { tail = rest.slice(k.length).trim(); break; }
        if (v === siteNorm && low === k) { tail = ""; break; }
      }
      if (tail === rest) tail = rest.split(/\s+/).slice(1).join(" ").trim();
    } else {
      tail = rest.split(/\s+/).slice(1).join(" ").trim();
    }

    const tailL = tail.toLowerCase();

    const flags = {
      normal: /\bn\b/.test(tailL) || tailL.includes("normal") || tailL.includes("within normal limits") || tailL.includes("no significant abnormality"),
      cryptitis: /\bcryp\b/.test(tailL) || tailL.includes("cryptitis"),
      abscess: /\babsc\b/.test(tailL) || tailL.includes("crypt abscess"),
      archDist: /\bad\b/.test(tailL) || tailL.includes("architectural distortion"),
      basalPlasma: /\bbp\b/.test(tailL) || tailL.includes("basal plasmacytosis"),
      granulomas: /\bgran\b/.test(tailL) || tailL.includes("granuloma"),
      ischemia: /\bisch\b/.test(tailL) || tailL.includes("ischaem") || tailL.includes("ischem") || tailL.includes("withered crypt") || tailL.includes("hyalin"),
      cmv: /\bcmv\b/.test(tailL) || tailL.includes("cytomegalovirus") || tailL.includes("inclusion") || tailL.includes("owl eye") || tailL.includes("owl-eye"),
      drug: /\bdrug\b/.test(tailL) || tailL.includes("nsaid") || tailL.includes("mycophenolate") || tailL.includes("checkpoint") || tailL.includes("ipilimumab") || tailL.includes("nivolumab") || tailL.includes("drug effect") || tailL.includes("drug-induced"),
      eos: /\beos\b/.test(tailL) || tailL.includes("eosinophil"),
    };

    const polyp = parsePolypDescriptor(tail);

    parts.push({ letter, site: siteNorm || "", tail, flags, polyp });
  }
  return parts;
}

function renderLGIPart(part) {
  const siteLabel = lgiSiteLabel(part.site);
  const muc = lgiMucosaLabel(part.site);
  const bits = [];
  if (part.polyp) {
    const p = part.polyp;
    const sizeTxt = (p.sizeMm != null) ? `${p.sizeMm} mm ` : "";
    const typeTxt = ({TA:"tubular adenoma",TVA:"tubulovillous adenoma",V:"villous adenoma",HP:"hyperplastic polyp",SSL:"sessile serrated lesion",TSA:"traditional serrated adenoma"})[p.polypType] || "polyp";
    let s = `${muc} contains a ${sizeTxt}${typeTxt}`.replace(/\s+/g," ").trim();
    if (p.excised) s += " which appears excised.";
    else if (p.notGuaranteed) s += ". Excision cannot be guaranteed.";
    else s += ".";
    const isSerrated = ["HP","SSL","TSA"].includes(p.polypType);
    if (p.invasive) s += " Invasive malignancy is identified.";
    else {
      if (!isSerrated) {
        if (p.hgd) s += " High-grade dysplasia is present.";
        else s += " There is no high-grade dysplasia or invasive malignancy.";
      } else {
        if (p.dys) s += " Dysplasia is present.";
        else s += " No dysplasia is identified.";
        s += " No invasive malignancy is identified.";
      }
    }
    bits.push(s);
  }

  const f = part.flags;
  const anyOther = f.cryptitis||f.abscess||f.archDist||f.basalPlasma||f.granulomas||f.ischemia||f.cmv||f.drug||f.eos;

  if (!part.polyp || anyOther) {
    if (f.normal && !anyOther && !part.polyp) {
      bits.push(`${muc} is within normal limits. ${part.site === "TI" ? "No active ileitis is seen." : "No active colitis is seen."}`);
    } else if (anyOther) {
      const infl = [];
      if (f.archDist) infl.push("architectural distortion");
      if (f.basalPlasma) infl.push("basal plasmacytosis");
      if (f.cryptitis) infl.push("focal cryptitis");
      if (f.abscess) infl.push("crypt abscesses");
      if (f.granulomas) infl.push("granulomas");
      let s = `${muc} shows`;
      if (infl.length) s += " " + infl.join(" with ") + ".";
      else s += " features as described.";
      if (f.ischemia) s += " There are features in keeping with ischaemic-type injury (e.g. withered crypts).";
      if (f.drug) s += " A drug-related injury pattern is a consideration (correlate with medications).";
      if (f.eos) s += " Eosinophils are increased.";
      if (f.cmv) s += " CMV is identified / suspected (correlate with immunohistochemistry as appropriate).";
      s += " There is no dysplasia or malignancy.";
      bits.push(s);
    } else if (!part.polyp) {
      bits.push(`${muc}: description incomplete (no recognised shorthand tokens).`);
    }
  }

  return `${part.letter} (${siteLabel}): ${bits.join(" ")}`.replace(/\s+/g," ").trim();
}

function buildLGIConclusion(parts) {
  const any = (fn) => parts.some(p => fn(p));
  const anyChronic = any(p => p.flags.archDist || p.flags.basalPlasma);
  const anyActive = any(p => p.flags.cryptitis || p.flags.abscess);
  const anyGran = any(p => p.flags.granulomas);
  const anyTI = any(p => p.site === "TI");
  const anyCMV = any(p => p.flags.cmv);
  const anyIsch = any(p => p.flags.ischemia);
  const anyDrug = any(p => p.flags.drug);
  const anyPolyp = any(p => !!p.polyp);

  if (anyIsch && !anyChronic && !anyGran) {
    return "Features are in keeping with ischaemic-type injury. Correlate with endoscopic and clinical findings.";
  }

  if (anyChronic || anyGran) {
    let s = "Features support chronic colitis (in keeping with inflammatory bowel disease in the appropriate clinical/endoscopic context).";
    if (anyGran || (anyTI && anyChronic)) s += " The presence of granulomas and/or ileal involvement favours Crohn disease, if clinically appropriate.";
    if (anyCMV) s += " CMV is identified / suspected; correlate with immunohistochemistry and clinical status (e.g. immunosuppression).";
    if (anyDrug) s += " A drug-related contribution is possible; correlate with medication history.";
    return s;
  }

  if (anyActive) {
    let s = "Features show active colitis without definite chronicity. Consider infection, drug-related injury, or early inflammatory bowel disease; correlate clinically.";
    if (anyCMV) s += " CMV is identified / suspected; correlate with immunohistochemistry as appropriate.";
    return s;
  }

  if (anyPolyp) return "Polyp(s)/adenoma(s) as described. Background mucosa is otherwise unremarkable.";

  return "No histological evidence of colitis. No features of microscopic colitis are identified.";
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

    } else if (manifest.pipeline?.mode === "lgi_shorthand_v1") {
      const parts = parseLGIShorthand(rawText);
      if (!parts.length) return jsonResp(400, { error: "LGI shorthand not recognised. Use e.g. LGI: A - TI n; B - cae ad cryp gran" });
      const renderedParts = parts.map(renderLGIPart).join("\n\n");
      const conclusion = buildLGIConclusion(parts);
      extracted = applyDefaults(schema, { parts_text: renderedParts, conclusion_text: conclusion });

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

      const crmNum = Number(extracted.distance_to_crm_mm);
      if (Number.isFinite(crmNum)) {
        if (crmNum < 1) extracted.circumferential_margin_status = "Involved: carcinoma within 1 mm of CRM.";
        else extracted.circumferential_margin_status = "Not involved: carcinoma more than 1 mm from CRM.";
      }

      // Staging + phrases (oesoph etc.)
      extracted.pT = computePTFromText(rawText);
      extracted.depth_phrase = depthPhraseFromPT(extracted.pT);
      extracted.pN = computePNFromRules(rules, extracted.nodes_positive);
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
