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
const defaults = _test.applyDefaults(schema, {});
const report = _test.renderTemplate(template, defaults);

assert.match(report, /Tumour Type: Adenocarcinoma/);
assert.match(report, /Local Invasion: pT1 \(submucosa\)/);
assert.match(report, /Number of lymph nodes: None/);
assert.match(report, /Deepest level of venous invasion: None/);
assert.match(report, /Pathological Staging: pT1 NX/);
assert.match(report, /Peripheral margins:\s*\n/);
assert.match(report, /Deep margin:\s*\n/);
assert.match(report, /Tumour Block:\s*\n/);

const blankModelOutput = Object.fromEntries(Object.keys(schema.properties).map((key) => [key, ""]));
const blankThenDefaulted = _test.applyDefaultsIncludingBlanks(schema, blankModelOutput);
assert.equal(blankThenDefaulted.tumour_type, "Adenocarcinoma");
assert.equal(blankThenDefaulted.peripheral_margin, "");

console.log("report dataset tests passed");
