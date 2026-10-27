const assert = require('node:assert/strict');
const guide = require('./assets/colorectal-local-guide');
const { _test } = require('./netlify/functions/generate-report');
const manifests = _test.listDatasetManifests();
for (const site of ['colorectal', 'colon', 'rectal', 'rectum', 'sigmoid']) {
  for (const procedure of ['ESD', 'EMR', 'TEM', 'TAMIS', 'polypectomy', 'local excision', 'local resection']) {
    const text = `${site} ${procedure}`;
    assert.equal(guide.matches(text), true, text);
    assert.equal(_test.pickDataset(text, manifests).id, 'colorectal_local_resection_cancer_v1', text);
  }
}
for (const text of ['', 'ESD', 'Oesophageal ESD', 'Gastric EMR', 'Colorectal adenocarcinoma', 'Rectal biopsy', 'Rectal ESDs']) {
  assert.equal(guide.matches(text), false, text);
}
const caveats = _test.buildCaveats({}, 'colorectal_local_resection_cancer_v1');
for (const note of guide.notes) assert.ok(caveats.includes(note));
assert.ok(!_test.buildCaveats({}, 'colorectal_resection_rcpath_v1').includes(guide.notes[0]));
console.log('Colorectal guide trigger, routing and caveat tests passed');
