import test from "node:test";
import assert from "node:assert/strict";
import { createGatewayFetch, extractWebAnswerResult, loadWebAnswerTools } from "./web-answer.mjs";
import { parseGeneratorFlags, resolveGeneratorModels } from "./question-generator-config.mjs";

const url = "https://trial-abc.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp";
const credentials = { accessKeyId: "TESTACCESSKEY", secretAccessKey: "test-only-not-a-real-secret", sessionToken: "test-token" };
const result = {
  isError: false,
  structuredContent: { answer: [
    { text: "Standby provides failover.", citations: [{ url: "https://docs.aws.amazon.com/rds" }] },
    { text: "Read replicas provide read scaling.", citations: [{ url: "https://aws.amazon.com/rds/" }] },
  ] },
  _meta: { latencyMs: 12 },
};

test("generator model roles keep grounding independent and support explicit CLI/profile overrides", () => {
  const defaults = resolveGeneratorModels({ env: { VOICE_MODEL_ID: "us.amazon.nova-pro-v1:0" } });
  assert.equal(defaults.factChecker, "zai.glm-5");
  assert.equal(defaults.localizer, "qwen.qwen3-next-80b-a3b");
  assert.equal(defaults.critic, "deepseek.v3.2");
  assert.equal(defaults.grader, "us.amazon.nova-2-lite-v1:0");
  const nova = resolveGeneratorModels({ modelProfile: "nova", env: {} });
  assert.equal(nova.factChecker, "us.amazon.nova-2-lite-v1:0");
  assert.equal(nova.localizer, "us.amazon.nova-2-lite-v1:0");
  const options = parseGeneratorFlags(["--model-profile=chinese", "--critic-model=moonshotai.kimi-k2.5"]);
  const models = resolveGeneratorModels({ ...options, env: {} });
  assert.equal(models.factChecker, "zai.glm-5");
  assert.equal(models.localizer, "qwen.qwen3-next-80b-a3b");
  assert.equal(models.critic, "moonshotai.kimi-k2.5");
  assert.equal(models.grader, "us.amazon.nova-2-lite-v1:0");
  const legacy = resolveGeneratorModels({ modelId: "zai.glm-5", env: {} });
  assert.equal(legacy.miner, "zai.glm-5");
  assert.equal(legacy.grounding, "us.amazon.nova-2-lite-v1:0");
  assert.equal(resolveGeneratorModels({ env: { QUESTION_MODEL_ID: "zai.glm-5" } }).critic, "zai.glm-5");
  assert.throws(() => resolveGeneratorModels({ models: { grounding: "zai.glm-5" }, env: {} }), /Nova/);
  assert.throws(() => parseGeneratorFlags(["--critic-model="]), /requires a value/);
  assert.throws(() => resolveGeneratorModels({ modelProfile: "typo", env: {} }), /modelProfile/);
});

test("Gateway fetch signs each request including rotating session credentials and blocks redirects", async () => {
  const sent = [];
  let lookups = 0;
  const gatewayFetch = createGatewayFetch({
    url, credentials: async () => ({ ...credentials, sessionToken: `token-${++lookups}` }),
    fetch: async (input, init) => { sent.push({ input, init }); return new Response("{}"); },
  });
  await gatewayFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"id":1}' });
  await gatewayFetch(new Request(url, { method: "POST", body: '{"id":2}' }));
  assert.match(sent[0].init.headers.authorization, /us-east-1\/bedrock-agentcore\/aws4_request/);
  assert.equal(sent[0].init.headers["x-amz-security-token"], "token-1");
  assert.equal(sent[1].init.headers["x-amz-security-token"], "token-2");
  assert.equal(sent[0].init.body, '{"id":1}');
  assert.equal(sent[0].init.redirect, "error");
  await assert.rejects(() => gatewayFetch("https://example.com/mcp"), /configured endpoint/);
  assert.throws(() => createGatewayFetch({ url: "http://localhost/mcp", credentials }), /HTTPS/);
});

test("Web Answer consumes every block and rejects errors, uncited or non-AWS answers", () => {
  const parsed = extractWebAnswerResult(result);
  assert.equal(parsed.answer.length, 2);
  assert.equal(parsed.citations.length, 2);
  assert.equal(parsed.latencyMs, 12);
  assert.throws(() => extractWebAnswerResult({ ...result, isError: true }), /could not/);
  assert.throws(() => extractWebAnswerResult({ structuredContent: { answer: [{ text: "Unverified" }] } }), /citations/);
  assert.throws(() => extractWebAnswerResult({
    structuredContent: { answer: [{ text: "Spoofed", citations: [{ url: "https://aws.amazon.com.example.com/" }] }] },
  }), /official AWS/);
});

test("Web Answer loader discovers by suffix, filters requests, propagates timeout and disconnects", async () => {
  let disconnected = false;
  const calls = [];
  const remoteTool = { name: "official-aws___WebAnswer" };
  const session = await loadWebAnswerTools({
    url, credentials, timeoutMs: 42,
    clientFactory: () => ({
      connect: async () => {},
      listTools: async () => [{ name: "x_amz_bedrock_agentcore_search" }, remoteTool],
      callTool: async (...args) => { calls.push(args); return result; },
      disconnect: async () => { disconnected = true; },
    }),
  });
  const stream = session.tools[0].stream({
    toolUse: { toolUseId: "answer", name: "aws_web_answer", input: { query: "RDS standby vs read replica" } },
  });
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  assert.equal(calls[0][0], remoteTool);
  assert.deepEqual(calls[0][1].filters.domainFilter.include, ["docs.aws.amazon.com", "aws.amazon.com"]);
  assert.equal(calls[0][2].timeoutMs, 42);
  await session.disconnect();
  assert.equal(disconnected, true);
});

test("discovery failure closes the MCP client instead of silently falling back", async () => {
  let disconnected = false;
  await assert.rejects(() => loadWebAnswerTools({
    url, credentials,
    clientFactory: () => ({
      connect: async () => {},
      listTools: async () => [{ name: "search-only" }],
      disconnect: async () => { disconnected = true; },
    }),
  }), /exactly one/);
  assert.equal(disconnected, true);
});

test("real Strands MCP transport negotiates, lists, signs and invokes Web Answer over mocked HTTP", async () => {
  const methods = [];
  const session = await loadWebAnswerTools({
    url, credentials, timeoutMs: 2000,
    fetch: async (input, init) => {
      assert.equal(input, url);
      assert.match(init.headers.authorization, /bedrock-agentcore\/aws4_request/);
      if (init.method === "GET") return new Response("", { status: 405 });
      const request = JSON.parse(init.body);
      methods.push(request.method);
      if (request.id === undefined) return new Response(null, { status: 202 });
      const data = request.method === "initialize" ? {
        protocolVersion: "2025-03-26", capabilities: { tools: {} },
        serverInfo: { name: "mock-gateway", version: "1" },
      } : request.method === "tools/list" ? {
        tools: [{
          name: "official-aws___WebAnswer", description: "Cited AWS evidence",
          inputSchema: { type: "object", properties: { query: { type: "string" }, filters: { type: "object" } }, required: ["query"] },
        }],
      } : result;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: data }),
        { headers: { "content-type": "application/json" } });
    },
  });
  try {
    const stream = session.tools[0].stream({
      toolUse: { toolUseId: "real-mcp", name: "aws_web_answer", input: { query: "RDS high availability" } },
    });
    let step = await stream.next();
    while (!step.done) step = await stream.next();
    assert.equal(step.value.status, "success");
    assert.match(JSON.stringify(step.value), /Read replicas provide read scaling/);
    assert.ok(methods.includes("initialize"));
    assert.ok(methods.includes("tools/list"));
    assert.ok(methods.includes("tools/call"));
  } finally {
    await session.disconnect();
  }
});
