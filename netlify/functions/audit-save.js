const crypto = require('crypto');

const ALLOWED_DATASETS = new Set([
  'oesophagus_resection_rcpath_v3_microscopy',
  'gastrectomy_resection_rcpath_v1_microscopy',
  'colorectal_resection_rcpath_v1',
  'gist_resection_rcpath_v1',
  'hepatocellular_carcinoma_proforma_v1',
  'colorectal_liver_metastasis_proforma_v1',
]);

const { getPool, json } = require('./_audit-db');

const isMissingRelation = (err) => err?.code === '42P01' || String(err?.message || '').toLowerCase().includes('does not exist');
const isUniqueViolation = (err) => err?.code === '23505';

function cleanString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toBool(value) {
  const s = cleanString(value).toLowerCase();
  if (!s) return null;
  if (['yes', 'y', 'true', 'present', 'positive', 'involved', 'extramural', 'intramural'].includes(s)) return true;
  if (['no', 'n', 'false', 'not identified', 'negative', 'none', 'not involved', 'clear', 'uninvolved', 'free'].includes(s)) return false;
  if (/\b(involved|positive|present|carcinoma|extramural|intramural)\b/.test(s) && !/\b(not involved|negative|uninvolved|no carcinoma|clear|free|none)\b/.test(s)) return true;
  if (/\b(not involved|negative|uninvolved|no carcinoma|clear|free)\b/.test(s)) return false;
  return null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSpecimen(input) {
  return cleanString(input).replace(/\s+/g, '').toUpperCase();
}

function hashSpecimen(specimenNumber) {
  const secret = process.env.AUDIT_HASH_SECRET;
  if (!secret) throw new Error('AUDIT_HASH_SECRET not set');
  return crypto.createHmac('sha256', secret).update(specimenNumber).digest('hex');
}

function mapAuditFields(datasetId, extracted = {}) {
  const out = {
    tumour_site: null,
    tumour_type: extracted.tumour_type || null,
    differentiation: extracted.differentiation || extracted.differentiation_worst_area || extracted.tumour_grade_differentiation || null,
    pt_stage: extracted.pT || extracted.stage_pT || extracted.local_invasion_pT || extracted.tnm_pT || null,
    pn_stage: extracted.pN || extracted.stage_pN || extracted.tnm_pN || null,
    pm_stage: extracted.pM || extracted.stage_pM || extracted.tnm_pM || null,
    nodes_examined: extracted.nodes_examined ?? extracted.lymph_nodes_examined ?? extracted.lymph_nodes_present ?? null,
    nodes_positive: extracted.nodes_positive ?? extracted.lymph_nodes_with_metastases ?? extracted.lymph_nodes_positive ?? null,
    crm_involved: null,
    crm_distance_mm: extracted.distance_to_crm_mm ?? extracted.distance_to_resection_margin_mm ?? null,
    margin_longitudinal_involved: extracted.longitudinal_margin_involved ?? extracted.proximal_margin ?? extracted.proximal_margin_status,
    margin_distal_involved: extracted.distal_margin_involved ?? extracted.distal_margin ?? extracted.distal_margin_status,
    lvi_present: extracted.lymphatic_invasion_level ?? extracted.lvsi ?? extracted.lvi ?? extracted.microscopic_vascular_invasion_identified,
    pni_present: extracted.perineural_invasion_level ?? extracted.pni,
    emvi_present: extracted.venous_invasion_level ?? extracted.macroscopic_vascular_invasion_confirmed,
    venous_invasion_level: extracted.venous_invasion_level || null,
    lymphatic_invasion_level: extracted.lymphatic_invasion_level || null,
    perineural_invasion_level: extracted.perineural_invasion_level || null,
    neoadjuvant_given: extracted.neoadjuvant_therapy_history ?? extracted.neoadjuvant_therapy_given,
    tumour_block: extracted.tumour_block || null,
  };

  out.tumour_site = extracted.site_of_tumour || extracted.tumour_site || extracted.site || extracted.anatomical_site || null;

  const crmRaw = extracted.circumferential_margin_status
    ?? extracted.circumferential_margin_involved
    ?? extracted.tumour_cells_present_at_excision_margin
    ?? extracted.tumour_cells_present_at_resection_margin;
  out.crm_involved = toBool(crmRaw);
  if (out.crm_involved === null && out.crm_distance_mm !== null) out.crm_involved = false;

  out.margin_longitudinal_involved = toBool(out.margin_longitudinal_involved);
  out.margin_distal_involved = toBool(out.margin_distal_involved);

  out.lvi_present = toBool(out.lvi_present);
  out.pni_present = toBool(out.pni_present);
  out.emvi_present = toBool(out.emvi_present);
  out.neoadjuvant_given = toBool(out.neoadjuvant_given);

  out.nodes_examined = toNumber(out.nodes_examined);
  out.nodes_positive = toNumber(out.nodes_positive);
  out.crm_distance_mm = toNumber(out.crm_distance_mm);

  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const datasetId = cleanString(body.dataset_id);
    const consultantName = cleanString(body.consultant_name);
    const reportText = cleanString(body.report_text);
    const specimenNumber = normalizeSpecimen(body.specimen_number);
    const extracted = body.extracted && typeof body.extracted === 'object' ? body.extracted : {};
    const generationMetrics = body.generation_metrics && typeof body.generation_metrics === "object" ? body.generation_metrics : {};

    if (!ALLOWED_DATASETS.has(datasetId)) {
      return json(400, { ok: false, error: 'Dataset not eligible for audit save' });
    }
    if (!consultantName) {
      return json(400, { ok: false, error: 'consultant_name is required' });
    }
    if (!specimenNumber) {
      return json(400, { ok: false, error: 'specimen_number is required' });
    }

    const specimenHash = hashSpecimen(specimenNumber);
    const mapped = mapAuditFields(datasetId, extracted);

    const db = getPool();
    const exists = await db.query('select 1 from audit.case_audit where specimen_hash = $1 limit 1', [specimenHash]);
    if (exists.rowCount > 0) {
      return json(409, { ok: false, error: 'Specimen number already exists in the audit system.' });
    }

    const sql = `
      insert into audit.case_audit (
        specimen_hash, consultant_name, dataset_id, report_text, raw_extracted_json,
        tumour_site, tumour_type, differentiation,
        pt_stage, pn_stage, pm_stage,
        nodes_examined, nodes_positive,
        crm_involved, crm_distance_mm,
        margin_longitudinal_involved, margin_distal_involved,
        lvi_present, pni_present, emvi_present,
        venous_invasion_level, lymphatic_invasion_level, perineural_invasion_level,
        neoadjuvant_given, tumour_block
      )
      values (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10, $11,
        $12, $13,
        $14, $15,
        $16, $17,
        $18, $19, $20,
        $21, $22, $23,
        $24, $25
      )
      returning id, created_at
    `;

    const params = [
      specimenHash,
      consultantName,
      datasetId,
      reportText || null,
      JSON.stringify(extracted),
      mapped.tumour_site,
      mapped.tumour_type,
      mapped.differentiation,
      mapped.pt_stage,
      mapped.pn_stage,
      mapped.pm_stage,
      mapped.nodes_examined,
      mapped.nodes_positive,
      mapped.crm_involved,
      mapped.crm_distance_mm,
      mapped.margin_longitudinal_involved,
      mapped.margin_distal_involved,
      mapped.lvi_present,
      mapped.pni_present,
      mapped.emvi_present,
      mapped.venous_invasion_level,
      mapped.lymphatic_invasion_level,
      mapped.perineural_invasion_level,
      mapped.neoadjuvant_given,
      mapped.tumour_block,
    ];

    const result = await db.query(sql, params);
    const row = result.rows[0] || {};

    try {
      await db.query(`
        insert into audit.report_generation_audit (
          dataset_id, template_key, model, duration_ms, input_tokens, output_tokens, total_tokens, estimated_cost_usd, success, error_message, metadata
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [
        datasetId,
        datasetId,
        generationMetrics.model || null,
        Number.isFinite(Number(generationMetrics.duration_ms)) ? Number(generationMetrics.duration_ms) : null,
        Number.isFinite(Number(generationMetrics.input_tokens)) ? Number(generationMetrics.input_tokens) : null,
        Number.isFinite(Number(generationMetrics.output_tokens)) ? Number(generationMetrics.output_tokens) : null,
        Number.isFinite(Number(generationMetrics.total_tokens)) ? Number(generationMetrics.total_tokens) : null,
        Number.isFinite(Number(generationMetrics.estimated_cost_usd)) ? Number(generationMetrics.estimated_cost_usd) : null,
        true,
        null,
        JSON.stringify({ benchmark_mode: Boolean(generationMetrics.benchmark_mode) })
      ]);
    } catch (err) {
      if (isMissingRelation(err)) {
        console.warn('[audit-save] Optional benchmark logging skipped:', err.message || String(err));
      } else {
        console.warn('[audit-save] Benchmark logging failed:', err.message || String(err));
      }
    }


    return json(200, { ok: true, id: row.id || null, created_at: row.created_at || null });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return json(409, { ok: false, error: 'Specimen number already exists in the audit system.' });
    }
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
