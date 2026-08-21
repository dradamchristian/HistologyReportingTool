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
const sample = { usage: { input_tokens: 5000, output_tokens: 250, total_tokens: 5250 }, output: [{ type: "web_search_call" }, { content: [{ text: "Supported answer", annotations: [{ type: "url_citation", url: "https://www.rcpath.org/example", title: "RCPath example" }, { type: "url_citation", url: "https://www.rcpath.org/example", title: "duplicate" }] }] }] };
assert.equal(_test.extractAnswer(sample), "Supported answer");
assert.deepEqual(_test.extractSources(sample), [{ title: "RCPath example", url: "https://www.rcpath.org/example" }]);
assert.deepEqual(_test.referenceMetrics(sample, "gpt-4.1-mini"), { model: "gpt-4.1-mini", input_tokens: 5000, output_tokens: 250, total_tokens: 5250, web_search_calls: 1, estimated_cost_usd: 0.0124, cost_is_estimate: true });
console.log("reference helper tests passed");

(async () => {
  const { handler } = require("./netlify/functions/ask-reference");
  assert.equal((await handler({ httpMethod: "GET" })).statusCode, 405);
  assert.equal((await handler({ httpMethod: "POST", body: "{" })).statusCode, 400);
  assert.equal((await handler({ httpMethod: "POST", body: "{}" })).statusCode, 400);

  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  let requestPayload;
  global.fetch = async (_url, options) => {
    requestPayload = JSON.parse(options.body);
    return { ok: true, json: async () => sample };
  };
  try {
    const response = await handler({ httpMethod: "POST", body: JSON.stringify({ question: "A morphology question", scope: "trusted" }) });
    assert.equal(response.statusCode, 200);
    assert.equal(requestPayload.tools[0].filters, undefined);
    assert.match(requestPayload.input, /site:rcpath\.org/);
    assert.equal(JSON.parse(response.body).sources.length, 1);
    assert.equal(JSON.parse(response.body).metrics.estimated_cost_usd, 0.0124);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
  console.log("reference endpoint tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
