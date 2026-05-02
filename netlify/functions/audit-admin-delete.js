const { getPool, json } = require('./_audit-db');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  try {
    const b = JSON.parse(event.body || '{}');
    if (!b.id) return json(400, { ok: false, error: 'id is required' });
    const editedBy = String(b.edited_by || '').trim();
    if (!editedBy) return json(400, { ok: false, error: 'edited_by is required' });

    const db = getPool();
    const deleted = await db.query(
      'delete from audit.case_audit where id = $1 returning id',
      [b.id]
    );

    if (!deleted.rows[0]) return json(404, { ok: false, error: 'Case not found' });
    return json(200, { ok: true, deleted_id: deleted.rows[0].id });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
