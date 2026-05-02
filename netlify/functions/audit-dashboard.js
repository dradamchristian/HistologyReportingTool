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
    if (q.site_query) add('coalesce(tumour_site,\'\') ILIKE ?', `%${q.site_query.trim()}%`);
    const where = w.length ? `where ${w.join(' and ')}` : '';

    const db = getPool();
    const totals = await db.query(`select count(*)::int as case_count, round(avg(nodes_examined)::numeric,1) as mean_nodes, percentile_cont(0.5) within group (order by nodes_examined) as median_nodes, count(*) filter (where nodes_examined >= 12)::int as ge12_cases, count(*) filter (where coalesce(crm_involved,false)=true or coalesce(margin_longitudinal_involved,false)=true or coalesce(margin_distal_involved,false)=true)::int as r1_cases, count(*) filter (where coalesce(lvi_present,false)=true)::int as lvi_cases, count(*) filter (where coalesce(pni_present,false)=true)::int as pni_cases, count(*) filter (where coalesce(emvi_present,false)=true)::int as emvi_cases, count(*) filter (where coalesce(margin_distal_involved,false)=true)::int as distal_margin_involved_cases, count(*) filter (where coalesce(margin_longitudinal_involved,false)=true)::int as proximal_margin_involved_cases, count(*) filter (where pt_stage ilike 'pT3%' or pt_stage ilike 'pT4%')::int as pt3_or_higher_cases from audit.case_audit ${where}` , vals);
    const byConsultant = await db.query(`select consultant_name, count(*)::int as cases, round(avg(nodes_examined)::numeric,1) as mean_nodes from audit.case_audit ${where} group by consultant_name order by cases desc`, vals);
    const bySite = await db.query(`select coalesce(tumour_site,'Unknown') as site, count(*)::int as cases from audit.case_audit ${where} group by coalesce(tumour_site,'Unknown') order by cases desc`, vals);
    const monthly = await db.query(`select to_char(date_trunc('month', created_at), 'Mon') as month_label, date_trunc('month', created_at) as month_date, round(avg(nodes_examined)::numeric,1) as mean_nodes, percentile_cont(0.5) within group (order by nodes_examined) as median_nodes from audit.case_audit ${where} group by month_date order by month_date`, vals);
    const cases = await db.query(`select id, created_at::date as case_date, consultant_name, tumour_site, pt_stage, pn_stage, nodes_examined, nodes_positive, crm_distance_mm, crm_involved, margin_distal_involved, margin_longitudinal_involved, lvi_present, pni_present, emvi_present from audit.case_audit ${where} order by created_at desc limit 200`, vals);

    return json(200, { ok: true, totals: totals.rows[0] || {}, by_consultant: byConsultant.rows, by_site: bySite.rows, monthly: monthly.rows, cases: cases.rows });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
