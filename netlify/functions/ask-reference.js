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

function referenceMetrics(responses, model) {
  const raws = Array.isArray(responses) ? responses : [responses];
  const sumUsage = (key) => raws.reduce((sum, raw) => sum + (Number(raw?.usage?.[key]) || 0), 0);
  const inputTokens = sumUsage("input_tokens");
  const outputTokens = sumUsage("output_tokens");
  const totalTokens = sumUsage("total_tokens");
  const webSearchCalls = raws.reduce((sum, raw) => sum + (Array.isArray(raw?.output) ? raw.output : []).filter((item) => item?.type === "web_search_call").length, 0);
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

async function callResponses(apiKey, payload) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(raw?.error?.message || "Reference search request failed");
    error.statusCode = response.status;
    throw error;
  }
  return raw;
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
    const responses = [];
    let pathologyOutlinesSources = [];
    if (scope === "trusted") {
      const pathologyOutlinesLookup = await callResponses(apiKey, {
        model,
        instructions: "Find the most relevant Pathology Outlines entity/topic page for this pathology question. Search only pathologyoutlines.com. Return a very short description with cited links. Do not substitute WHO, journals or other sites. If there is no relevant page, say so.",
        input: `${question}\n\nSearch: site:pathologyoutlines.com`,
        tools: [webSearch],
        max_output_tokens: 180,
      });
      responses.push(pathologyOutlinesLookup);
      pathologyOutlinesSources = extractSources(pathologyOutlinesLookup)
        .filter((source) => source.url && new URL(source.url).hostname.toLowerCase().endsWith("pathologyoutlines.com"))
        .map((source) => ({ ...source, preferred: true }));
    }
    const pathologyContext = pathologyOutlinesSources.length
      ? `\n\nA dedicated Pathology Outlines lookup found these relevant pages. Use them when relevant and include them in the supporting discussion:\n${pathologyOutlinesSources.map((source) => `- ${source.title}: ${source.url}`).join("\n")}`
      : "";
    const raw = await callResponses(apiKey, { model, instructions: buildInstructions(scope), input: input + pathologyContext, tools: [webSearch], max_output_tokens: 500 });
    responses.push(raw);
    const answer = extractAnswer(raw);
    const allSources = extractSources(raw);
    const combinedSources = [...pathologyOutlinesSources, ...allSources].filter((source, index, items) => items.findIndex((candidate) => candidate.url === source.url) === index);
    const sources = scope === "trusted" ? combinedSources.filter((source) => hostnameIsTrusted(source.url)) : combinedSources;
    if (!answer) return json(502, { error: "The reference service returned no answer" });
    if (scope === "trusted" && (sources.length === 0 || sources.length !== combinedSources.length)) {
      return json(502, { error: "No answer could be verified exclusively against the trusted source list. Try rephrasing the question or use the broader evidence search." });
    }
    return json(200, { answer, sources, scope, metrics: referenceMetrics(responses, model) });
  } catch (err) {
    return json(err.statusCode || 500, { error: err.message || String(err) });
  }
};

exports._test = { TRUSTED_DOMAINS, extractAnswer, extractSources, hostnameIsTrusted, trustedSearchInput, referenceMetrics, buildInstructions };
