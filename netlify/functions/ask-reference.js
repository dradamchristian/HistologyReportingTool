const TRUSTED_DOMAINS = [
  "pathologyoutlines.com",
  "rcpath.org",
  "who.int",
  "publications.iarc.fr",
];

const MAX_QUESTION_LENGTH = 1200;

function json(statusCode, payload) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

function extractAnswer(raw) {
  if (typeof raw?.output_text === "string") return raw.output_text.trim();
  const parts = [];
  for (const item of (Array.isArray(raw?.output) ? raw.output : [])) {
    for (const content of (Array.isArray(item?.content) ? item.content : [])) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function extractSources(raw) {
  const seen = new Set();
  const sources = [];
  for (const item of (Array.isArray(raw?.output) ? raw.output : [])) {
    for (const content of (Array.isArray(item?.content) ? item.content : [])) {
      for (const annotation of (Array.isArray(content?.annotations) ? content.annotations : [])) {
        const citation = annotation?.url_citation || annotation;
        const url = citation?.url;
        if (typeof url !== "string" || !/^https:\/\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        sources.push({ title: citation.title || new URL(url).hostname, url });
      }
    }
  }
  return sources.slice(0, 6);
}

function buildInstructions(scope) {
  const sourceRule = scope === "trusted"
    ? "Use only results from the configured trusted pathology domains."
    : "Prefer primary guidance, recognised professional bodies, peer-reviewed literature and major academic medical sources. Avoid forums, commercial marketing and unsourced summaries.";
  return `You are a pathology reference assistant for qualified clinicians. ${sourceRule}
Answer only from web sources retrieved for this request; do not rely on unsupported memory. Give a concise answer (normally under 180 words), focused on morphology, differential diagnosis, terminology or reporting guidance. Distinguish mandatory guidance from review-level suggestions and mention important source disagreement or edition dependence. Never invent a citation. If the evidence is inadequate, say so plainly. Do not diagnose a patient or claim that a brief description is definitive. Do not repeat personal identifiers. Use plain text with brief bullets where helpful.`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid JSON body" }); }

  const question = String(body.question || "").trim();
  const scope = body.scope === "broader" ? "broader" : "trusted";
  if (!question) return json(400, { error: "Question is required" });
  if (question.length > MAX_QUESTION_LENGTH) return json(400, { error: `Question must be ${MAX_QUESTION_LENGTH} characters or fewer` });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json(500, { error: "OPENAI_API_KEY not set." });
  const model = process.env.REFERENCE_MODEL || "gpt-4.1-mini";
  const webSearch = { type: "web_search", search_context_size: "medium" };
  if (scope === "trusted") webSearch.filters = { allowed_domains: TRUSTED_DOMAINS };

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, instructions: buildInstructions(scope), input: question, tools: [webSearch], max_output_tokens: 500 }),
    });
    const raw = await response.json().catch(() => ({}));
    if (!response.ok) return json(response.status, { error: raw?.error?.message || "Reference search request failed" });
    const answer = extractAnswer(raw);
    const sources = extractSources(raw);
    if (!answer) return json(502, { error: "The reference service returned no answer" });
    return json(200, { answer, sources, scope });
  } catch (err) {
    return json(500, { error: err.message || String(err) });
  }
};

exports._test = { TRUSTED_DOMAINS, extractAnswer, extractSources, buildInstructions };
