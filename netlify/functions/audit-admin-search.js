const { getPool, json } = require('./_audit-db');
const crypto = require('crypto');

function normalizeSpecimen(input) {
  return String(input || '').trim().replace(/\s+/g, '').toUpperCase();
}

function hashSpecimen(specimenNumber) {
  const secret = process.env.AUDIT_HASH_SECRET;
  if (!secret) throw new Error('AUDIT_HASH_SECRET not set');
  return crypto.createHmac('sha256', secret).update(specimenNumber).digest('hex');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });
  try {
    const q = event.queryStringParameters || {};
    const where = [];
    const vals = [];
    const add = (sql, value) => { vals.push(value); where.push(sql.replace('?', `$${vals.length}`)); };

    if (q.dataset_id) add('dataset_id = ?', q.dataset_id.trim());
    if (q.consultant_name) add('consultant_name ILIKE ?', `%${q.consultant_name.trim()}%`);
    if (q.from_date) add('created_at::date >= ?', q.from_date);
    if (q.to_date) add('created_at::date <= ?', q.to_date);
    if (q.specimen_number) {
      const specimenNumber = normalizeSpecimen(q.specimen_number);
      if (specimenNumber) add('specimen_hash = ?', hashSpecimen(specimenNumber));
    }

    const sql = `
      select id, created_at, consultant_name, dataset_id, tumour_site, tumour_type, differentiation,
             pt_stage, pn_stage, pm_stage, nodes_examined, nodes_positive, crm_involved, crm_distance_mm,
             margin_longitudinal_involved, margin_distal_involved, lvi_present, pni_present, emvi_present,
             neoadjuvant_given, tumour_block
      from audit.case_audit
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by created_at desc
      limit 500
    `;
    const result = await getPool().query(sql, vals);
    return json(200, { ok: true, rows: result.rows });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
