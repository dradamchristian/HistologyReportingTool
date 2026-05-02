const { getPool, json } = require('./_audit-db');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  try {
    const b = JSON.parse(event.body || '{}');
    const fromName = (b.from_name || '').trim();
    const toName = (b.to_name || '').trim();
    const editedBy = (b.edited_by || '').trim();
    if (!fromName || !toName || !editedBy) return json(400, { ok: false, error: 'from_name, to_name, edited_by required' });

    const db = getPool();
    await db.query('begin');
    const rows = await db.query('select id, consultant_name from audit.case_audit where consultant_name = $1', [fromName]);
    await db.query('update audit.case_audit set consultant_name = $1 where consultant_name = $2', [toName, fromName]);
    for (const r of rows.rows) {
      await db.query(`insert into audit.case_audit_edits (case_audit_id, edited_by, edit_reason, before_json, after_json) values ($1,$2,$3,$4::jsonb,$5::jsonb)`,
        [r.id, editedBy, `Consultant normalization: ${fromName} -> ${toName}`, JSON.stringify({ consultant_name: fromName }), JSON.stringify({ consultant_name: toName })]);
    }
    await db.query('commit');
    return json(200, { ok: true, updated_count: rows.rowCount });
  } catch (err) {
    try { await getPool().query('rollback'); } catch (_) {}
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
