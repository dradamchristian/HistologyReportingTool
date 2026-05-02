const crypto = require('crypto');
const { getPool, json } = require('./_audit-db');

const ALLOWED_DATASETS = new Set([
  'oesophagus_resection_rcpath_v3_microscopy',
  'gastrectomy_resection_rcpath_v1_microscopy',
  'colorectal_resection_rcpath_v1',
  'gist_resection_rcpath_v1',
  'hepatocellular_carcinoma_proforma_v1',
  'colorectal_liver_metastasis_proforma_v1',
]);

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeSpecimen(input) {
  return clean(input).replace(/\s+/g, '').toUpperCase();
}

function hashSpecimen(specimenNumber) {
  const secret = process.env.AUDIT_HASH_SECRET;
  if (!secret) throw new Error('AUDIT_HASH_SECRET not set');
  return crypto.createHmac('sha256', secret).update(specimenNumber).digest('hex');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  try {
    const b = JSON.parse(event.body || '{}');
    const editedBy = clean(b.edited_by);
    const specimen = normalizeSpecimen(b.specimen_number);
    const dataset = clean(b.dataset_id);
    const consultant = clean(b.consultant_name);
    if (!editedBy) return json(400, { ok: false, error: 'edited_by is required' });
    if (!specimen) return json(400, { ok: false, error: 'specimen_number is required' });
    if (!consultant) return json(400, { ok: false, error: 'consultant_name is required' });
    if (!ALLOWED_DATASETS.has(dataset)) return json(400, { ok: false, error: 'dataset_id not allowed' });

    const fields = ['tumour_site','tumour_type','differentiation','pt_stage','pn_stage','pm_stage','nodes_examined','nodes_positive','crm_involved','crm_distance_mm','margin_longitudinal_involved','margin_distal_involved','lvi_present','pni_present','emvi_present','neoadjuvant_given','tumour_block'];
    const boolFields = new Set(['crm_involved','margin_longitudinal_involved','margin_distal_involved','lvi_present','pni_present','emvi_present','neoadjuvant_given']);
    const numFields = new Set(['nodes_examined','nodes_positive','crm_distance_mm']);
    const record = {};
    for (const f of fields) {
      const raw = b[f];
      if (raw === '' || raw === null || raw === undefined) {
        record[f] = null;
      } else if (boolFields.has(f)) {
        record[f] = raw === true || raw === 'true';
      } else if (numFields.has(f)) {
        const n = Number(raw);
        record[f] = Number.isFinite(n) ? n : null;
      } else {
        record[f] = clean(raw) || null;
      }
    }

    const db = getPool();
    await db.query('begin');
    const inserted = await db.query(
      `insert into audit.case_audit (
        specimen_hash, consultant_name, dataset_id, report_text, raw_extracted_json,
        tumour_site, tumour_type, differentiation, pt_stage, pn_stage, pm_stage,
        nodes_examined, nodes_positive, crm_involved, crm_distance_mm,
        margin_longitudinal_involved, margin_distal_involved, lvi_present, pni_present, emvi_present,
        neoadjuvant_given, tumour_block
      ) values (
        $1,$2,$3,$4,$5,
        $6,$7,$8,$9,$10,$11,
        $12,$13,$14,$15,
        $16,$17,$18,$19,$20,
        $21,$22
      ) returning *`,
      [
        hashSpecimen(specimen), consultant, dataset, clean(b.report_text) || null, JSON.stringify({ manual_entry: true }),
        record.tumour_site, record.tumour_type, record.differentiation, record.pt_stage, record.pn_stage, record.pm_stage,
        record.nodes_examined, record.nodes_positive, record.crm_involved, record.crm_distance_mm,
        record.margin_longitudinal_involved, record.margin_distal_involved, record.lvi_present, record.pni_present, record.emvi_present,
        record.neoadjuvant_given, record.tumour_block,
      ]
    );
    const row = inserted.rows[0];
    await db.query(
      `insert into audit.case_audit_edits (case_audit_id, edited_by, edit_reason, before_json, after_json)
       values ($1,$2,$3,$4::jsonb,$5::jsonb)`,
      [row.id, editedBy, clean(b.edit_reason) || 'Manual case add', JSON.stringify({}), JSON.stringify(row)]
    );
    await db.query('commit');
    return json(200, { ok: true, row });
  } catch (err) {
    try { await getPool().query('rollback'); } catch (_) {}
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
