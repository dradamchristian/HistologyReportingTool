const { getPool, json } = require('./_audit-db');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });
  try {
    const q = event.queryStringParameters || {};
    const vals = [];
    const w = [];
    const add = (sql, value) => { vals.push(value); w.push(sql.replace('?', `$${vals.length}`)); };
    if (q.dataset_id) add('dataset_id = ?', q.dataset_id.trim());
    if (q.consultant_name) add('consultant_name ILIKE ?', `%${q.consultant_name.trim()}%`);
    if (q.from_date) add('created_at::date >= ?', q.from_date);
    if (q.to_date) add('created_at::date <= ?', q.to_date);
    const where = w.length ? `where ${w.join(' and ')}` : '';

    const totals = await getPool().query(`select count(*)::int as total_cases, count(*) filter (where crm_involved = true)::int as crm_positive from audit.case_audit ${where}`, vals);
    const byDataset = await getPool().query(`select dataset_id, count(*)::int as total, count(*) filter (where crm_involved = true)::int as crm_positive, round(avg(nodes_examined)::numeric,2) as avg_nodes_examined, round(avg(nodes_positive)::numeric,2) as avg_nodes_positive from audit.case_audit ${where} group by dataset_id order by total desc`, vals);
    const byConsultant = await getPool().query(`select consultant_name, count(*)::int as total, count(*) filter (where crm_involved = true)::int as crm_positive, round(avg(nodes_examined)::numeric,2) as avg_nodes_examined, round(avg(nodes_positive)::numeric,2) as avg_nodes_positive from audit.case_audit ${where} group by consultant_name order by total desc`, vals);

    return json(200, { ok: true, totals: totals.rows[0], by_dataset: byDataset.rows, by_consultant: byConsultant.rows });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
