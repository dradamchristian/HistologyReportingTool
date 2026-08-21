const assert = require("node:assert/strict");
const { _test } = require("./netlify/functions/ask-reference");

assert.deepEqual(_test.TRUSTED_DOMAINS, ["pathologyoutlines.com", "rcpath.org", "who.int", "publications.iarc.fr"]);
assert.match(_test.buildInstructions("trusted"), /search Pathology Outlines first/i);
assert.match(_test.buildInstructions("broader"), /peer-reviewed literature/i);
assert.equal(_test.hostnameIsTrusted("https://www.pathologyoutlines.com/topic/example.html"), true);
assert.equal(_test.hostnameIsTrusted("https://pathologyoutlines.com.evil.example/topic"), false);
assert.equal(_test.hostnameIsTrusted("not a URL"), false);
assert.match(_test.trustedSearchInput("A question"), /site:pathologyoutlines\.com/);
assert.match(_test.trustedSearchInput("A question"), /First search Pathology Outlines/i);
assert.deepEqual(_test.pathologyOutlinesSearchResource("enchondroma morphology"), {
  title: "Search Pathology Outlines for this topic (morphology and images)",
  url: "https://www.google.com/search?q=site%3Apathologyoutlines.com%20enchondroma%20morphology",
  preferred: true,
  navigation_only: true,
});
const sample = { usage: { input_tokens: 5000, output_tokens: 250, total_tokens: 5250 }, output: [{ type: "web_search_call" }, { content: [{ text: "Supported answer", annotations: [{ type: "url_citation", url: "https://www.rcpath.org/example", title: "RCPath example" }, { type: "url_citation", url: "https://www.rcpath.org/example", title: "duplicate" }] }] }] };
assert.equal(_test.extractAnswer(sample), "Supported answer");
assert.deepEqual(_test.extractSources(sample), [{ title: "RCPath example", url: "https://www.rcpath.org/example" }]);
assert.deepEqual(_test.referenceMetrics(sample, "gpt-4.1-mini"), { model: "gpt-4.1-mini", input_tokens: 5000, output_tokens: 250, total_tokens: 5250, web_search_calls: 1, estimated_cost_usd: 0.0124, cost_is_estimate: true });
assert.deepEqual(_test.referenceMetrics([sample, sample], "gpt-4.1-mini"), { model: "gpt-4.1-mini", input_tokens: 10000, output_tokens: 500, total_tokens: 10500, web_search_calls: 2, estimated_cost_usd: 0.0248, cost_is_estimate: true });
console.log("reference helper tests passed");

(async () => {
  const { handler } = require("./netlify/functions/ask-reference");
  assert.equal((await handler({ httpMethod: "GET" })).statusCode, 405);
  assert.equal((await handler({ httpMethod: "POST", body: "{" })).statusCode, 400);
  assert.equal((await handler({ httpMethod: "POST", body: "{}" })).statusCode, 400);

  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  const requestPayloads = [];
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    requestPayloads.push(payload);
    const responseSample = requestPayloads.length === 1
      ? { ...sample, output: [{ type: "web_search_call" }, { content: [{ text: "Relevant page", annotations: [{ type: "url_citation", url: "https://www.pathologyoutlines.com/topic/bonetumorchondroma.html", title: "Chondroma" }] }] }] }
      : sample;
    return { ok: true, status: 200, json: async () => responseSample };
  };
  try {
    const response = await handler({ httpMethod: "POST", body: JSON.stringify({ question: "A morphology question", scope: "trusted" }) });
    assert.equal(response.statusCode, 200);
    assert.equal(requestPayloads.length, 2);
    assert.match(requestPayloads[0].input, /site:pathologyoutlines\.com/);
    assert.equal(requestPayloads[1].tools[0].filters, undefined);
    assert.match(requestPayloads[1].input, /site:rcpath\.org/);
    assert.match(requestPayloads[1].input, /bonetumorchondroma/);
    const responseBody = JSON.parse(response.body);
    assert.equal(responseBody.sources.length, 2);
    assert.equal(responseBody.sources[0].preferred, true);
    assert.equal(responseBody.metrics.estimated_cost_usd, 0.0248);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
  console.log("reference endpoint tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
