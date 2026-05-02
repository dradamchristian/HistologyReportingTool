const { getPool, json } = require('./_audit-db');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  try {
    const b = JSON.parse(event.body || '{}');
    if (!b.id) return json(400, { ok: false, error: 'id is required' });
    const editedBy = (b.edited_by || '').trim();
    if (!editedBy) return json(400, { ok: false, error: 'edited_by is required' });

    const allowed = ['consultant_name','dataset_id','tumour_site','tumour_type','differentiation','pt_stage','pn_stage','pm_stage','nodes_examined','nodes_positive','crm_involved','crm_distance_mm'];
    const patch = b.patch && typeof b.patch === 'object' ? b.patch : {};
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!keys.length) return json(400, { ok: false, error: 'No editable fields supplied' });

    const db = getPool();
    await db.query('begin');
    const before = await db.query('select * from audit.case_audit where id = $1 for update', [b.id]);
    if (!before.rows[0]) {
      await db.query('rollback');
      return json(404, { ok: false, error: 'Case not found' });
    }

    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const params = [b.id, ...keys.map((k) => patch[k])];
    const updated = await db.query(`update audit.case_audit set ${sets.join(', ')} where id = $1 returning *`, params);
    await db.query(
      `insert into audit.case_audit_edits (case_audit_id, edited_by, edit_reason, before_json, after_json)
       values ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [b.id, editedBy, (b.edit_reason || '').trim() || null, JSON.stringify(before.rows[0]), JSON.stringify(updated.rows[0])]
    );
    await db.query('commit');
    return json(200, { ok: true, row: updated.rows[0] });
  } catch (err) {
    try { await getPool().query('rollback'); } catch (_) {}
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
