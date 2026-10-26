const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _test } = require("./netlify/functions/generate-report");

const manifests = _test.listDatasetManifests();
assert.equal(
  _test.pickDataset("Colorectal local resection. Adenocarcinoma.", manifests).id,
  "colorectal_local_resection_cancer_v1"
);
assert.equal(
  _test.pickDataset("Colorectal adenocarcinoma.", manifests).id,
  "colorectal_resection_rcpath_v1"
);
for (const prompt of [
  "Rectal local excision containing adenocarcinoma.",
  "Colon polypectomy containing carcinoma.",
  "Colorectal EMR containing adenocarcinoma.",
  "Rectal ESD containing adenocarcinoma.",
  "Rectal TEM containing adenocarcinoma.",
  "Rectal TAMIS containing adenocarcinoma.",
]) {
  assert.equal(
    _test.pickDataset(prompt, manifests).id,
    "colorectal_local_resection_cancer_v1",
    `Expected local resection dataset for: ${prompt}`
  );
}

for (const trigger of ["colorectal emr", "colorectal esd", "colorectal tamis", "rectal emr", "rectal esd", "rectal tamis"]) {
  assert.ok(
    manifests.find((manifest) => manifest.id === "colorectal_local_resection_cancer_v1").match.any.includes(trigger),
    `Expected the local resection manifest to advertise: ${trigger}`
  );
}

const datasetPath = path.join(__dirname, "datasets", "colorectal_local_resection_cancer_v1");
const schema = JSON.parse(fs.readFileSync(path.join(datasetPath, "schema.json"), "utf8"));
const template = fs.readFileSync(path.join(datasetPath, "template.txt"), "utf8");
const requiredProformaFields = [
  "maximum_tumour_diameter_mm", "tumour_type", "other_tumour_type", "differentiation_worst_area",
  "local_invasion", "maximum_invasive_depth_mm", "invasive_tumour_width_mm", "haggitt_level",
  "kikuchi_level", "nodes_examined", "nodes_positive", "tumour_deposits", "venous_invasion_level",
  "lymphatic_invasion_level", "perineural_invasion_level", "tumour_bud_count", "tumour_budding_grade",
  "preoperative_therapy_response", "background_adenoma", "peripheral_margin_involvement",
  "deep_margin_involvement", "carcinoma_to_deep_margin_mm", "resection_status", "tnm_prefix",
  "pT", "pN", "pM", "block_index", "representative_molecular_blocks",
];
assert.deepEqual(Object.keys(schema.properties), requiredProformaFields);
assert.deepEqual(schema.properties.local_invasion.enum, [
  "No carcinoma identified (pT0)", "Submucosa (pT1)",
  "Muscularis propria (pT2)", "Beyond muscularis propria (pT3)",
]);
assert.deepEqual(schema.properties.differentiation_worst_area.enum, ["Well/moderate", "Poor", "Not applicable"]);
assert.deepEqual(schema.properties.resection_status.enum, ["R0", "R1", "R2", "Not assessable"]);
assert.equal(schema.properties.preoperative_therapy_response.enum.length, 5);

const report = _test.renderTemplate(template, {
  maximum_tumour_diameter_mm: "12 mm", tumour_type: "Adenocarcinoma",
  other_tumour_type: "", differentiation_worst_area: "Well/moderate",
  local_invasion: "Submucosa (pT1)", maximum_invasive_depth_mm: "2 mm",
  invasive_tumour_width_mm: "6 mm", haggitt_level: "Not applicable", kikuchi_level: "sm1",
  nodes_examined: "0", nodes_positive: "0", tumour_deposits: "0", venous_invasion_level: "None",
  lymphatic_invasion_level: "None", perineural_invasion_level: "None", tumour_bud_count: "3",
  tumour_budding_grade: "Bd1 (<5 buds)", preoperative_therapy_response: "Not applicable",
  background_adenoma: "Yes", peripheral_margin_involvement: "No", deep_margin_involvement: "No",
  carcinoma_to_deep_margin_mm: "2 mm", resection_status: "R0", tnm_prefix: "No prefix",
  pT: "T1", pN: "NX", pM: "MX", block_index: "A=lesion", representative_molecular_blocks: "A1",
});
assert.match(report, /Maximum tumour diameter: 12 mm/);
assert.match(report, /Number of involved lymph nodes: 0/);
assert.match(report, /Number of buds identified: 3/);
assert.match(report, /Preoperative therapy response \(tumour regression score\): Not applicable/);
assert.match(report, /Peripheral margin: No/);
assert.match(report, /Resection status: R0/);
assert.match(report, /TNM \(8th edition\):[\s\S]*pT: T1[\s\S]*pN: NX[\s\S]*pM: MX/);
assert.match(report, /Block index: A=lesion/);
assert.match(report, /Representative molecular block\(s\): A1/);

const localExcisionStage = { nodes_examined: "0", nodes_positive: "0", pN: "N0" };
_test.finalizeStaging(schema, localExcisionStage);
assert.equal(localExcisionStage.pN, "NX", "A local excision with no nodes examined must remain pNX");

console.log("report dataset tests passed");
