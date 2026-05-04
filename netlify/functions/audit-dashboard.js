const { getPool, json } = require('./_audit-db');

const isMissingRelation = (err) => {
  const code = err?.code;
  const message = String(err?.message || '').toLowerCase();
  return code === '42P01' || message.includes('does not exist') || message.includes('undefined table');
};

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
    const benchVals = [];
    const benchW = [];
    const addBench = (sql, value) => { benchVals.push(value); benchW.push(sql.replace('?', `$${benchVals.length}`)); };
    if (q.model) addBench('actual_model = ?', q.model.trim());
    if (q.template_key) addBench('requested_mode = ?', q.template_key.trim());
    if (q.from_date) addBench('created_at::date >= ?', q.from_date);
    if (q.to_date) addBench('created_at::date <= ?', q.to_date);
    const where = w.length ? `where ${w.join(' and ')}` : '';

    const db = getPool();
    const totals = await db.query(`select count(*)::int as case_count, round(avg(nodes_examined)::numeric,1) as mean_nodes, percentile_cont(0.5) within group (order by nodes_examined) as median_nodes, count(*) filter (where nodes_examined >= 12)::int as ge12_cases, count(*) filter (where coalesce(crm_involved,false)=true or coalesce(margin_longitudinal_involved,false)=true or coalesce(margin_distal_involved,false)=true)::int as r1_cases, count(*) filter (where coalesce(lvi_present,false)=true)::int as lvi_cases, count(*) filter (where coalesce(pni_present,false)=true)::int as pni_cases, count(*) filter (where coalesce(emvi_present,false)=true)::int as emvi_cases, count(*) filter (where coalesce(margin_distal_involved,false)=true)::int as distal_margin_involved_cases, count(*) filter (where coalesce(margin_longitudinal_involved,false)=true)::int as proximal_margin_involved_cases, count(*) filter (where pt_stage ~* '^p?T[34]')::int as pt3_or_higher_cases from audit.case_audit ${where}` , vals);
    const byConsultant = await db.query(`select consultant_name, count(*)::int as cases, round(avg(nodes_examined)::numeric,1) as mean_nodes from audit.case_audit ${where} group by consultant_name order by cases desc`, vals);
    const bySite = await db.query(`select coalesce(tumour_site,'Unknown') as site, count(*)::int as cases from audit.case_audit ${where} group by coalesce(tumour_site,'Unknown') order by cases desc`, vals);
    const monthly = await db.query(`select to_char(date_trunc('month', created_at), 'Mon') as month_label, date_trunc('month', created_at) as month_date, round(avg(nodes_examined)::numeric,1) as mean_nodes, percentile_cont(0.5) within group (order by nodes_examined) as median_nodes from audit.case_audit ${where} group by month_date order by month_date`, vals);
    const cases = await db.query(`select id, created_at::date as case_date, consultant_name, tumour_site, pt_stage, pn_stage, pm_stage, nodes_examined, nodes_positive, crm_distance_mm, crm_involved, margin_distal_involved, margin_longitudinal_involved, lvi_present, pni_present, emvi_present, venous_invasion_level, lymphatic_invasion_level, perineural_invasion_level from audit.case_audit ${where} order by created_at desc limit 200`, vals);

    const stageBreakdown = await db.query(`
      with base as (
        select
          upper(regexp_replace(coalesce(pt_stage,''), '^p', '', 'i')) as t_stage,
          upper(regexp_replace(coalesce(pn_stage,''), '^p', '', 'i')) as n_stage,
          upper(regexp_replace(coalesce(pm_stage,''), '^p', '', 'i')) as m_stage
        from audit.case_audit ${where}
      )
      select
        count(*) filter (where t_stage='T1')::int as t1_cases,
        count(*) filter (where t_stage='T2')::int as t2_cases,
        count(*) filter (where t_stage='T3')::int as t3_cases,
        count(*) filter (where t_stage='T4')::int as t4_cases,
        count(*) filter (where n_stage='N0')::int as n0_cases,
        count(*) filter (where n_stage='N1' or n_stage like 'N1%')::int as n1_cases,
        count(*) filter (where n_stage='N2' or n_stage like 'N2%')::int as n2_cases,
        count(*) filter (where m_stage='M0')::int as m0_cases,
        count(*) filter (where m_stage='M1')::int as m1_cases
      from base
    `, vals);
    const benchWhere = benchW.length ? `where ${benchW.join(" and ")}` : "";
    let usageConfigured = true;
    let usageNotice = null;
    let benchmarkRows = [];
    let usageStatsRow = {};
    let usageByModelRows = [];
    let usageRows = [];

    try {
      const benchmark = await db.query(`select actual_model as model, count(*)::int as total_generations, round(avg(duration_ms)::numeric,1) as avg_duration_ms, round(avg(estimated_cost_usd)::numeric,6) as avg_estimated_cost_usd, count(*) filter (where success=true)::int as success_count, count(*) filter (where success=false)::int as error_count, round(avg(input_tokens)::numeric,1) as avg_input_tokens, round(avg(output_tokens)::numeric,1) as avg_output_tokens from audit.generation_usage ${benchWhere} group by model order by avg_duration_ms nulls last`, benchVals);
      const usageStats = await db.query(`
        select
          count(*) filter (where created_at::date = current_date)::int as reports_today,
          coalesce(sum(estimated_cost_usd) filter (where created_at::date = current_date),0)::numeric(12,6) as estimated_cost_today,
          coalesce(sum(estimated_cost_usd) filter (where date_trunc('month', created_at)=date_trunc('month', now())),0)::numeric(12,6) as estimated_cost_month,
          round(avg(duration_ms)::numeric,1) as avg_generation_time_overall
        from audit.generation_usage`);
      const usageByModel = await db.query(`
        select actual_model as model, count(*)::int as usage_count, round(avg(duration_ms)::numeric,1) as avg_duration_ms,
        round(100.0 * avg(case when success then 0 else 1 end),2) as error_rate_pct
        from audit.generation_usage group by actual_model order by usage_count desc`);
      const usageRowsQuery = await db.query(`select created_at, dataset, requested_mode, actual_model, duration_ms, input_tokens, output_tokens, total_tokens, estimated_cost_usd, success, error_message, deploy_context from audit.generation_usage order by created_at desc limit 5000`);
      benchmarkRows = benchmark.rows;
      usageStatsRow = usageStats.rows[0] || {};
      usageByModelRows = usageByModel.rows;
      usageRows = usageRowsQuery.rows;
    } catch (err) {
      if (!isMissingRelation(err)) throw err;
      usageConfigured = false;
      usageNotice = 'Usage/cost metrics not configured yet';
      console.warn('[audit-dashboard] Optional usage metrics query skipped:', err.message || String(err));
    }

    return json(200, { ok: true, totals: totals.rows[0] || {}, stage_breakdown: stageBreakdown.rows[0] || {}, by_consultant: byConsultant.rows, by_site: bySite.rows, monthly: monthly.rows, cases: cases.rows, benchmark: benchmarkRows, usage_stats: usageStatsRow, usage_by_model: usageByModelRows, usage_rows: usageRows, usage_metrics_configured: usageConfigured, usage_metrics_notice: usageNotice });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
