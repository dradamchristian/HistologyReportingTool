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
    const consultants = await db.query('select name from audit.consultant_directory order by name');
    const distinct = await db.query(`
      select
        array_remove(array_agg(distinct tumour_site), null) as tumour_site,
        array_remove(array_agg(distinct tumour_type), null) as tumour_type,
        array_remove(array_agg(distinct differentiation), null) as differentiation,
        array_remove(array_agg(distinct pt_stage), null) as pt_stage,
        array_remove(array_agg(distinct pn_stage), null) as pn_stage,
        array_remove(array_agg(distinct pm_stage), null) as pm_stage,
        array_remove(array_agg(distinct tumour_block), null) as tumour_block
      from audit.case_audit
    `);
    return json(200, {
      ok: true,
      consultants: consultants.rows.map((r) => r.name),
      specimen_types: Object.keys(SPECIMEN_TYPES).map((dataset_id) => ({ dataset_id, label: SPECIMEN_TYPES[dataset_id] })),
      distinct: distinct.rows[0] || {},
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
