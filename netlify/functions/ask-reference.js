const TRUSTED_DOMAINS = [
  "pathologyoutlines.com",
  "rcpath.org",
  "who.int",
  "publications.iarc.fr",
];

const MAX_QUESTION_LENGTH = 1200;
const MODEL_PRICING_PER_MILLION = {
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
};
const DEFAULT_WEB_SEARCH_COST_PER_1000 = 10;

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

function hostnameIsTrusted(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return TRUSTED_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function trustedSearchInput(question) {
  const sites = TRUSTED_DOMAINS.map((domain) => `site:${domain}`).join(" OR ");
  return `${question}\n\nFirst search Pathology Outlines for the most relevant entity/topic page, then search the other approved sources as needed. Search only these domains: ${sites}`;
}

function referenceMetrics(raw, model) {
  const usage = raw?.usage || {};
  const inputTokens = Number(usage.input_tokens);
  const outputTokens = Number(usage.output_tokens);
  const totalTokens = Number(usage.total_tokens);
  const webSearchCalls = (Array.isArray(raw?.output) ? raw.output : []).filter((item) => item?.type === "web_search_call").length;
  const pricing = MODEL_PRICING_PER_MILLION[model];
  const searchRate = Number(process.env.REFERENCE_WEB_SEARCH_COST_PER_1000 || DEFAULT_WEB_SEARCH_COST_PER_1000);
  const tokenCost = pricing && Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
    ? (inputTokens / 1_000_000 * pricing.input) + (outputTokens / 1_000_000 * pricing.output)
    : null;
  const searchCost = Number.isFinite(searchRate) ? webSearchCalls / 1000 * searchRate : null;
  const estimatedCost = tokenCost != null && searchCost != null ? tokenCost + searchCost : null;
  return {
    model,
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : null,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : null,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : null,
    web_search_calls: webSearchCalls,
    estimated_cost_usd: estimatedCost == null ? null : Number(estimatedCost.toFixed(6)),
    cost_is_estimate: true,
  };
}

function buildInstructions(scope) {
  const sourceRule = scope === "trusted"
    ? "Use only results from the configured trusted pathology domains. For simple morphology, differential diagnosis and tumour-entity questions, search Pathology Outlines first and cite the most relevant entity/topic page prominently when it contains relevant information, so the user can follow the link to its illustrations. Supplement it with RCPath or WHO/IARC when they add classification or reporting authority. Do not cite an irrelevant Pathology Outlines page merely to satisfy this preference."
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
  // gpt-4.1-mini web search does not support the tool's `filters` parameter.
  // Constrain discovery in the query/prompt, then enforce the allowlist again on
  // the returned citations before any trusted-mode answer reaches the client.
  const input = scope === "trusted" ? trustedSearchInput(question) : question;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, instructions: buildInstructions(scope), input, tools: [webSearch], max_output_tokens: 500 }),
    });
    const raw = await response.json().catch(() => ({}));
    if (!response.ok) return json(response.status, { error: raw?.error?.message || "Reference search request failed" });
    const answer = extractAnswer(raw);
    const allSources = extractSources(raw);
    const sources = scope === "trusted" ? allSources.filter((source) => hostnameIsTrusted(source.url)) : allSources;
    if (!answer) return json(502, { error: "The reference service returned no answer" });
    if (scope === "trusted" && (sources.length === 0 || sources.length !== allSources.length)) {
      return json(502, { error: "No answer could be verified exclusively against the trusted source list. Try rephrasing the question or use the broader evidence search." });
    }
    return json(200, { answer, sources, scope, metrics: referenceMetrics(raw, model) });
  } catch (err) {
    return json(500, { error: err.message || String(err) });
  }
};

exports._test = { TRUSTED_DOMAINS, extractAnswer, extractSources, hostnameIsTrusted, trustedSearchInput, referenceMetrics, buildInstructions };
