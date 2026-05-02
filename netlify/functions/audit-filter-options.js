const { getPool, json } = require('./_audit-db');

const SPECIMEN_TYPES = {
  oesophagus_resection_rcpath_v3_microscopy: 'Oesophagus resection',
  gastrectomy_resection_rcpath_v1_microscopy: 'Gastrectomy resection',
  colorectal_resection_rcpath_v1: 'Colorectal resection',
  gist_resection_rcpath_v1: 'GIST resection',
  hepatocellular_carcinoma_proforma_v1: 'HCC proforma',
  colorectal_liver_metastasis_proforma_v1: 'CRLM proforma',
};

exports.handler = async () => {
  try {
    const db = getPool();
    await db.query(`create table if not exists audit.consultant_directory (name text primary key, created_at timestamptz not null default now())`);
    const consultants = await db.query("select name from audit.consultant_directory union select distinct consultant_name as name from audit.case_audit where consultant_name is not null and trim(consultant_name) <> '' order by name");
    const datasets = await db.query("select distinct dataset_id from audit.case_audit where dataset_id is not null and trim(dataset_id) <> '' order by dataset_id");
    return json(200, {
      ok: true,
      consultants: consultants.rows.map((r) => r.name),
      specimen_types: datasets.rows.map((r) => ({ dataset_id: r.dataset_id, label: SPECIMEN_TYPES[r.dataset_id] || r.dataset_id })),
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
