const fs = require("fs");
const path = require("path");

function readJsonIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

exports.handler = async () => {
  const datasetsDir = path.join(process.cwd(), "datasets");
  const entries = fs.readdirSync(datasetsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const manifests = [];
  for (const id of entries) {
    const mp = path.join(datasetsDir, id, "manifest.json");
    const m = readJsonIfExists(mp);
    manifests.push({
      folder: id,
      manifest_found: fs.existsSync(mp),
      manifest_parsed: !!m,
      manifest_id: m?.id || null,
      match_any: m?.match?.any || null,
      mode: m?.pipeline?.mode || null
    });
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: process.cwd(), manifests }, null, 2)
  };
};
