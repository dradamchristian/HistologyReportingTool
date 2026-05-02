const { getPool, json } = require('./_audit-db');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  try {
    const b = JSON.parse(event.body || '{}');
    if (!b.id) return json(400, { ok: false, error: 'id is required' });
    const editedBy = String(b.edited_by || '').trim();
    if (!editedBy) return json(400, { ok: false, error: 'edited_by is required' });

    const db = getPool();
    await db.query('begin');

    const before = await db.query('select * from audit.case_audit where id = $1 for update', [b.id]);
    if (!before.rows[0]) {
      await db.query('rollback');
      return json(404, { ok: false, error: 'Case not found' });
    }

    await db.query('delete from audit.case_audit where id = $1', [b.id]);
    await db.query(
      `insert into audit.case_audit_edits (case_audit_id, edited_by, edit_reason, before_json, after_json)
       values ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [b.id, editedBy, (b.edit_reason || '').trim() || 'Case deleted from audit admin', JSON.stringify(before.rows[0]), JSON.stringify({ deleted: true })]
    );

    await db.query('commit');
    return json(200, { ok: true, deleted_id: b.id });
  } catch (err) {
    try { await getPool().query('rollback'); } catch (_) {}
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
