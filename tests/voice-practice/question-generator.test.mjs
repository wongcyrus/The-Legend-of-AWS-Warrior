import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "../../src/VoiceAgent/node_modules/@strands-agents/sdk/dist/src/index.js";
import {
  createNovaWebSearchTool,
  createQuestionGenerator,
  extractNovaGroundingResult,
  runQuestionBatchJob,
} from "../../src/VoicePractice/question-generator.mjs";

const sampleGeneratedQuestion = (serviceId = "rds", id = "multi-az-failover", version = 1, expectedRevision = null) => ({
  id,
  serviceId,
  version,
  status: "approved",
  expectedRevision,
  title: "RDS Multi-AZ High Availability",
  prompts: {
    "en-US": "Your game database runs on Amazon RDS. Why would you enable a Multi-AZ deployment, and how does it differ from a Read Replica?",
    "zh-HK": "你嘅遊戲資料庫喺 Amazon RDS 上面行緊。點解你會啟用 Multi-AZ 部署？佢同 Read Replica 有咩分別？",
    "zh-CN": "你的游戏数据库运行在 Amazon RDS 上。为什么要启用 Multi-AZ 部署？它与只读副本有什么区别？",
  },
  concepts: [
    {
      id: "standby-failover",
      description: "Multi-AZ maintains a synchronous standby replica in another Availability Zone for automatic failover.",
      weight: 60,
    },
    {
      id: "vs-read-replica",
      description: "Multi-AZ standby is for high availability and cannot serve read traffic, whereas Read Replicas scale read queries asynchronously.",
      weight: 40,
    },
  ],
  misconceptions: [
    "RDS Multi-AZ standby instances automatically distribute read-heavy query traffic.",
  ],
  acceptableAnswers: [
    "Multi-AZ keeps a synchronous standby in another AZ for automatic failover, while Read Replicas asynchronously offload read traffic.",
  ],
  referenceAnswer: "Enable RDS Multi-AZ to keep a synchronous standby in a second AZ for automatic failover during outages; use Read Replicas for asynchronous read scaling.",
});

const sampleSyntheticTranscripts = {
  goodEn: "We enable RDS Multi-AZ to maintain a synchronous standby replica in another Availability Zone for automatic failover, whereas Read Replicas scale read queries asynchronously.",
  goodZhHk: "我哋用 RDS Multi-AZ 喺另一個 AZ 保持 synchronous standby 做 automatic failover，而 Read Replicas 係用嚟 asynchronous 擴展 read queries。",
  wrongOutdated: "RDS Multi-AZ standby instances automatically distribute read-heavy query traffic across both zones.",
};

test("createNovaWebSearchTool invokes Bedrock nova_grounding systemTool and extracts citations", async () => {
  const sent = [];
  const searchTool = createNovaWebSearchTool({
    modelId: "us.amazon.nova-2-lite-v1:0",
    send: async command => {
      sent.push(command.input);
      return {
        stopReason: "end_turn",
        output: {
          message: {
            role: "assistant",
            content: [
              {
                toolUse: {
                  toolUseId: "tu-1",
                  name: "nova_grounding",
                  input: { query: "common Amazon RDS Multi-AZ interview questions" },
                  type: "server_tool_use",
                },
              },
              { text: "Common RDS interview question: Multi-AZ vs Read Replicas." },
              {
                citationsContent: {
                  citations: [
                    {
                      title: "Amazon RDS Multi-AZ",
                      location: { web: { url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html" } },
                    },
                  ],
                },
              },
            ],
          },
        },
      };
    },
  });

  const parsed = extractNovaGroundingResult({
    output: {
      message: {
        content: [
          { toolUse: { name: "nova_grounding", input: { query: "rds interview" } } },
          { text: "RDS Multi-AZ provides high availability." },
          { citationsContent: { citations: [{ title: "RDS Docs", location: { web: { url: "https://aws.amazon.com/rds/" } } }] } },
        ],
      },
    },
  });
  assert.equal(parsed.answer, "RDS Multi-AZ provides high availability.");
  assert.deepEqual(parsed.queries, ["rds interview"]);
  assert.deepEqual(parsed.citations, [{ title: "RDS Docs", url: "https://aws.amazon.com/rds/" }]);

  const gen = searchTool.stream({
    toolUse: { toolUseId: "call-1", name: "nova_web_search", input: { query: "RDS interview questions" } },
  });
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].toolConfig, { tools: [{ systemTool: { name: "nova_grounding" } }] });
});

test("4-agent Strands Graph mines interview question, verifies AWS docs via MCP tool, localizes and calibrates", async () => {
  const docCalls = [];
  const mockDocTool = tool({
    name: "aws___search_documentation",
    description: "Mock AWS Knowledge MCP documentation search",
    inputSchema: {
      type: "object",
      properties: { search_phrase: { type: "string" } },
      required: ["search_phrase"],
    },
    callback: async input => {
      docCalls.push(input);
      return {
        results: [
          {
            title: "Multi-AZ DB instance deployments",
            url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html",
            context: "Amazon RDS Multi-AZ deployments provide enhanced availability and durability with a synchronous standby replica.",
          },
        ],
      };
    },
  });

  const mockWebTool = tool({
    name: "nova_web_search",
    description: "Mock Nova web search",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    callback: async input => ({
      answer: `Top interview question for ${input.query}: RDS Multi-AZ vs Read Replica.`,
      citations: [{ title: "AWS Interview Guide", url: "https://example.com/rds-interview" }],
    }),
  });

  let minerCalledTool = false;
  let checkerCalledTool = false;
  const q = sampleGeneratedQuestion("rds", "multi-az-failover", 1, null);

  const send = async command => {
    const sys = command.input.system?.[0]?.text ?? "";
    if (sys.includes("InterviewQuestionMinerAgent")) {
      if (!minerCalledTool) {
        minerCalledTool = true;
        return {
          stopReason: "tool_use",
          output: {
            message: {
              role: "assistant",
              content: [{ toolUse: { toolUseId: "web-1", name: "nova_web_search", input: { query: "Amazon RDS interview questions" } } }],
            },
          },
        };
      }
      return {
        stopReason: "end_turn",
        output: {
          message: {
            role: "assistant",
            content: [{ text: JSON.stringify({ serviceId: "rds", candidateId: "multi-az-failover", commonQuestion: "Multi-AZ vs Read Replica" }) }],
          },
        },
      };
    }
    if (sys.includes("AwsDocsFactCheckerAgent")) {
      if (!checkerCalledTool) {
        checkerCalledTool = true;
        return {
          stopReason: "tool_use",
          output: {
            message: {
              role: "assistant",
              content: [{ toolUse: { toolUseId: "doc-1", name: "aws___search_documentation", input: { search_phrase: "RDS Multi-AZ vs Read Replica" } } }],
            },
          },
        };
      }
      return {
        stopReason: "end_turn",
        output: {
          message: {
            role: "assistant",
            content: [{ text: JSON.stringify({ id: q.id, serviceId: "rds", title: q.title, enPrompt: q.prompts["en-US"], concepts: q.concepts, misconceptions: q.misconceptions, acceptableAnswers: q.acceptableAnswers, referenceAnswer: q.referenceAnswer }) }],
          },
        },
      };
    }
    if (sys.includes("TrilingualLocalizationAgent")) {
      return {
        stopReason: "end_turn",
        output: {
          message: { role: "assistant", content: [{ text: JSON.stringify(q) }] },
        },
      };
    }
    if (sys.includes("CalibrationCriticAgent")) {
      return {
        stopReason: "end_turn",
        output: {
          message: {
            role: "assistant",
            content: [{ text: JSON.stringify({ question: q, syntheticTranscripts: sampleSyntheticTranscripts }) }],
          },
        },
      };
    }
    throw new Error(`Unexpected system prompt: ${sys}`);
  };

  const grader = async ({ transcript }) => {
    if (transcript.includes("synchronous standby")) {
      return {
        concepts: [
          { id: "standby-failover", verdict: "met", evidence: "synchronous standby" },
          { id: "vs-read-replica", verdict: "met", evidence: "Read Replicas" },
        ],
        feedback: "Well explained based on AWS documentation.",
      };
    }
    return {
      concepts: [
        { id: "standby-failover", verdict: "missing", evidence: "" },
        { id: "vs-read-replica", verdict: "contradicted", evidence: "distribute read-heavy query traffic" },
      ],
      feedback: "Multi-AZ standby does not serve read traffic.",
    };
  };

  const generator = createQuestionGenerator({
    send,
    webSearchTool: mockWebTool,
    docTools: [mockDocTool],
    grader,
  });

  const result = await generator.generateOrRefreshQuestion({
    serviceId: "rds",
    label: "Amazon RDS",
    passage: "Amazon RDS manages relational databases.",
  });

  assert.equal(minerCalledTool, true);
  assert.equal(checkerCalledTool, true);
  assert.equal(docCalls.length, 1);
  assert.equal(result.question.id, "multi-az-failover");
  assert.equal(result.question.status, "approved");
  assert.equal(result.calibration.goodEnScore, 100);
  assert.equal(result.calibration.goodZhHkScore, 100);
  assert.equal(result.calibration.wrongOutdatedScore, 0);
});

test("CalibrationCriticAgent retries when first attempt has Cantonese in zh-CN or fails synthetic calibration", async () => {
  let attemptCount = 0;
  const qGood = sampleGeneratedQuestion("rds", "multi-az-failover", 1, null);
  const qBadMandarin = {
    ...qGood,
    prompts: {
      ...qGood.prompts,
      "zh-CN": "你嘅資料庫點解要用 Multi-AZ？", // Contains Cantonese characters 嘅, 點
    },
  };

  const send = async command => {
    const sys = command.input.system?.[0]?.text ?? "";
    if (sys.includes("CalibrationCriticAgent")) {
      attemptCount++;
      const chosen = attemptCount === 1 ? qBadMandarin : qGood;
      return {
        stopReason: "end_turn",
        output: {
          message: {
            role: "assistant",
            content: [{ text: JSON.stringify({ question: chosen, syntheticTranscripts: sampleSyntheticTranscripts }) }],
          },
        },
      };
    }
    return {
      stopReason: "end_turn",
      output: { message: { role: "assistant", content: [{ text: JSON.stringify(qGood) }] } },
    };
  };

  const grader = async ({ transcript }) => ({
    concepts: transcript.includes("synchronous standby")
      ? [
          { id: "standby-failover", verdict: "met", evidence: "synchronous standby" },
          { id: "vs-read-replica", verdict: "met", evidence: "Read Replicas" },
        ]
      : [
          { id: "standby-failover", verdict: "missing", evidence: "" },
          { id: "vs-read-replica", verdict: "missing", evidence: "" },
        ],
    feedback: "Checked.",
  });

  const generator = createQuestionGenerator({
    send,
    webSearchTool: null,
    docTools: [],
    grader,
    maxAttempts: 2,
  });

  const result = await generator.generateOrRefreshQuestion({
    serviceId: "rds",
    label: "Amazon RDS",
    passage: "Amazon RDS manages relational databases.",
  });
  assert.equal(attemptCount, 2);
  assert.equal(result.question.id, "multi-az-failover");
});

test("runQuestionBatchJob checkpoints per service, skips completed services on resume, and refreshes existing revisions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-qgen-"));
  try {
    const checkpointFile = join(dir, "checkpoint.json");
    const rows = new Map();
    const store = {
      async get(key) { return structuredClone(rows.get(key.SK)); },
      async listQuestions(serviceId) {
        return structuredClone([...rows.values()].filter(row => !serviceId || row.serviceId === serviceId));
      },
      async atomic(writes) {
        for (const write of writes) {
          const before = rows.get(write.item.SK);
          if (write.previous === undefined ? before : before?.revision !== write.previous) {
            throw new Error("Question revision changed; read the current item before editing");
          }
        }
        for (const write of writes) rows.set(write.item.SK, structuredClone(write.item));
      },
    };

    const calls = [];
    const mockGenerator = {
      async generateOrRefreshQuestion({ serviceId, existingQuestion, slotIndex }) {
        calls.push({ serviceId, slotIndex, mode: existingQuestion ? "refresh" : "generate" });
        const id = existingQuestion ? existingQuestion.id : `${serviceId}-q${slotIndex}`;
        const version = existingQuestion ? existingQuestion.version + 1 : 1;
        const expectedRevision = existingQuestion ? existingQuestion.expectedRevision : null;
        return {
          question: sampleGeneratedQuestion(serviceId, id, version, expectedRevision),
          calibration: { goodEnScore: 100, goodZhHkScore: 100, wrongOutdatedScore: 0 },
        };
      },
    };

    // 1. Generate for rds and ecs (1 question per service) and auto-publish to DynamoDB store
    const run1 = await runQuestionBatchJob({
      mode: "generate",
      services: ["rds", "ecs"],
      countPerService: 1,
      checkpointFile,
      publish: true,
      store,
      generator: mockGenerator,
    });
    assert.deepEqual(run1.completedServices, ["rds", "ecs"]);
    assert.equal(run1.publishedCount, 2);
    assert.equal(JSON.parse(readFileSync(checkpointFile, "utf8")).length, 2);

    // 2. Resume with rds, ecs, and cloudfront -> rds & ecs are skipped from checkpoint!
    const run2 = await runQuestionBatchJob({
      mode: "generate",
      services: ["rds", "ecs", "cloudfront"],
      countPerService: 1,
      checkpointFile,
      publish: true,
      store,
      generator: mockGenerator,
    });
    assert.deepEqual(run2.skippedServices, ["rds", "ecs"]);
    assert.deepEqual(run2.completedServices, ["cloudfront"]);
    assert.equal(run2.publishedCount, 1);
    assert.equal(JSON.parse(readFileSync(checkpointFile, "utf8")).length, 3);

    // 3. Refresh rds from DynamoDB -> preserves id, sets expectedRevision=0, increments version to 2
    const refreshFile = join(dir, "refreshed.json");
    const run3 = await runQuestionBatchJob({
      mode: "refresh",
      services: ["rds"],
      checkpointFile: refreshFile,
      publish: true,
      store,
      generator: mockGenerator,
    });
    assert.deepEqual(run3.completedServices, ["rds"]);
    assert.equal(run3.questions[0].id, "rds-q1");
    assert.equal(run3.questions[0].version, 2);
    assert.equal(run3.questions[0].expectedRevision, 0);
    const dbRow = rows.get("SERVICE#rds#QUESTION#rds-q1");
    assert.equal(dbRow.version, 2);
    assert.equal(dbRow.revision, 1);
    assert.equal(dbRow.status, "approved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
