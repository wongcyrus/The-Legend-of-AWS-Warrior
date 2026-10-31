import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "../../src/VoiceAgent/node_modules/@strands-agents/sdk/dist/src/index.js";
import {
  classifyFailureStage,
  createNovaWebSearchTool,
  createQuestionGenerator,
  extractNovaGroundingResult,
  findDuplicateOrOverlappingQuestion,
  renderStrandsTraceReportHtml,
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
  let criticCalledTool = false;
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
      if (!criticCalledTool) {
        criticCalledTool = true;
        return {
          stopReason: "tool_use",
          output: {
            message: {
              role: "assistant",
              content: [{
                toolUse: {
                  toolUseId: "cal-1",
                  name: "verify_and_calibrate_question",
                  input: { question: q, syntheticTranscripts: sampleSyntheticTranscripts },
                },
              }],
            },
          },
        };
      }
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
  assert.equal(criticCalledTool, true);
  assert.equal(docCalls.length, 1);
  assert.equal(result.question.id, "multi-az-failover");
  assert.equal(result.question.status, "approved");
  assert.equal(result.calibration.goodEnScore, 100);
  assert.equal(result.calibration.goodZhHkScore, 100);
  assert.equal(result.calibration.wrongOutdatedScore, 0);
  assert.equal(result.trace.graphId, "aws-interview-question-pipeline");
  assert.equal(result.trace.steps.length, 4);
  assert.deepEqual(
    result.trace.steps.map(s => s.nodeId),
    ["interview_miner", "aws_docs_fact_checker", "trilingual_localizer", "calibration_critic"]
  );
  assert.equal(result.trace.steps[0].toolCalls[0].name, "nova_web_search");
  assert.equal(result.trace.steps[1].toolCalls[0].name, "aws___search_documentation");
  assert.equal(result.trace.steps[3].toolCalls[0].name, "verify_and_calibrate_question");
  assert.ok(result.trace.steps[0].agentTraces.length >= 2);
  assert.match(result.trace.topology.mermaid, /flowchart LR/);
  assert.match(result.trace.topology.mermaid, /conditional loop/);
  const html = renderStrandsTraceReportHtml([result.trace]);
  assert.match(html, /aws-interview-question-pipeline/);
  assert.match(html, /verify_and_calibrate_question/);
});

test("Stage-classified loop routing sends localization defects to trilingual_localizer and rubric defects to aws_docs_fact_checker", async () => {
  assert.equal(classifyFailureStage("Mandarin prompt (zh-CN) contains Cantonese-only characters"), "localization");
  assert.equal(classifyFailureStage("Synthetic goodZhHk failed calibration (score=50, expected >=80)"), "localization");
  assert.equal(classifyFailureStage("Synthetic goodEn failed calibration (score=40, expected >=80)"), "rubric");
  assert.equal(classifyFailureStage("Question concept weights must sum to 100"), "rubric");
  assert.equal(classifyFailureStage('Question topic overlaps too closely (overlapping_prompt) with existing question "s3-1"'), "topic");

  // 1. Localization defect -> routes calibration_critic -> trilingual_localizer (6 steps total, miner & fact_checker run only once)
  let attemptCount = 0;
  const qGood = sampleGeneratedQuestion("rds", "multi-az-failover", 1, null);
  const qBadMandarin = {
    ...qGood,
    prompts: {
      ...qGood.prompts,
      "zh-CN": "你嘅資料庫點解要用 Multi-AZ？", // Contains Cantonese character 嘅
    },
  };

  const sendLocalization = async command => {
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
    send: sendLocalization,
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
  assert.equal(result.trace.cycles, 2);
  assert.equal(result.trace.steps.length, 6);
  assert.deepEqual(
    result.trace.steps.map(s => s.nodeId),
    [
      "interview_miner",
      "aws_docs_fact_checker",
      "trilingual_localizer",
      "calibration_critic",
      "trilingual_localizer",
      "calibration_critic",
    ]
  );
  const locLoopHandoff = result.trace.handoffs.find(h => h.source === "calibration_critic" && h.isLoopBack);
  assert.ok(locLoopHandoff);
  assert.deepEqual(locLoopHandoff.targets, ["trilingual_localizer"]);
  assert.equal(locLoopHandoff.failureStage, "localization");

  // 2. Rubric defect (weights sum to 90 instead of 100) -> routes calibration_critic -> aws_docs_fact_checker (7 steps total, miner runs only once)
  let rubricAttempt = 0;
  const qBadWeights = {
    ...qGood,
    concepts: [
      { ...qGood.concepts[0], weight: 50 },
      { ...qGood.concepts[1], weight: 40 },
    ],
  };
  const generatorRubric = createQuestionGenerator({
    send: async command => {
      const sys = command.input.system?.[0]?.text ?? "";
      if (sys.includes("CalibrationCriticAgent")) {
        rubricAttempt++;
        const chosen = rubricAttempt === 1 ? qBadWeights : qGood;
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
    },
    webSearchTool: null,
    docTools: [],
    grader,
    maxAttempts: 2,
  });

  const rubricResult = await generatorRubric.generateOrRefreshQuestion({
    serviceId: "rds",
    label: "Amazon RDS",
    passage: "Amazon RDS manages relational databases.",
  });
  assert.equal(rubricResult.trace.steps.length, 7);
  assert.deepEqual(
    rubricResult.trace.steps.map(s => s.nodeId),
    [
      "interview_miner",
      "aws_docs_fact_checker",
      "trilingual_localizer",
      "calibration_critic",
      "aws_docs_fact_checker",
      "trilingual_localizer",
      "calibration_critic",
    ]
  );
  const rubricLoopHandoff = rubricResult.trace.handoffs.find(h => h.source === "calibration_critic" && h.isLoopBack);
  assert.ok(rubricLoopHandoff);
  assert.deepEqual(rubricLoopHandoff.targets, ["aws_docs_fact_checker"]);
  assert.equal(rubricLoopHandoff.failureStage, "rubric");
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

test("semantic deduplication blocks repeated topics with different IDs and passes baseline + prior-slot avoidQuestions", async () => {
  const existingRdsQuestion = sampleGeneratedQuestion("rds", "multi-az-failover", 1, null);
  const disguisedDuplicate = {
    ...sampleGeneratedQuestion("rds", "rds-ha-standby-vs-replica", 1, null),
    title: "High Availability Multi-AZ vs Read Replica",
  };
  const distinctRdsQuestion = {
    id: "automated-backups-pitr",
    serviceId: "rds",
    version: 1,
    status: "approved",
    expectedRevision: null,
    title: "Automated Backups and Point-in-Time Recovery",
    prompts: {
      "en-US": "A bad deployment corrupts table rows in Amazon RDS five minutes ago. How do automated backups and transaction logs allow you to recover vs a manual snapshot?",
      "zh-HK": "五分鐘前一次錯誤部署整壞咗 Amazon RDS 入面嘅資料表。自動備份同交易日誌點樣幫你還原，同手動 Snapshot 有咩分別？",
      "zh-CN": "五分钟前一次错误部署损坏了 Amazon RDS 中的表数据。自动备份和事务日志如何帮助你恢复，与手动快照有什么区别？",
    },
    concepts: [
      {
        id: "pitr-logs",
        description: "Automated backups combine daily snapshots with transaction logs to enable point-in-time recovery to any second within the retention window.",
        weight: 60,
      },
      {
        id: "manual-retention",
        description: "Manual snapshots capture a single point in time and persist even after the RDS instance is deleted.",
        weight: 40,
      },
    ],
    misconceptions: [
      "Automated backups are kept forever even after deleting the RDS database without final snapshot.",
    ],
    acceptableAnswers: [
      "Use point-in-time recovery from automated backups and transaction logs to restore to just before the corruption; manual snapshots remain after instance deletion.",
    ],
    referenceAnswer: "Automated backups and transaction logs let you restore to a specific second via Point-in-Time Recovery, while manual snapshots persist after instance deletion.",
  };

  const overlapCheck = findDuplicateOrOverlappingQuestion(disguisedDuplicate, [existingRdsQuestion], []);
  assert.ok(overlapCheck);
  assert.notEqual(overlapCheck.reason, "duplicate_id");
  assert.equal(overlapCheck.matchId, "multi-az-failover");
  assert.equal(findDuplicateOrOverlappingQuestion(distinctRdsQuestion, [existingRdsQuestion], []), null);

  let attempt = 0;
  let receivedCritique = "";
  const send = async command => {
    const sys = command.input.system?.[0]?.text ?? "";
    const latestMessageText = (command.input.messages?.at(-1)?.content ?? [])
      .map(block => block?.text ?? "")
      .join("\n");
    if (latestMessageText.includes("previousAttemptCritique")) {
      receivedCritique = latestMessageText;
    }
    if (sys.includes("CalibrationCriticAgent")) {
      attempt++;
      const chosen = attempt === 1 ? disguisedDuplicate : distinctRdsQuestion;
      return {
        stopReason: "end_turn",
        output: {
          message: {
            role: "assistant",
            content: [{
              text: JSON.stringify({
                question: chosen,
                syntheticTranscripts: {
                  goodEn: "Automated backups and transaction logs enable point-in-time recovery to any second, while manual snapshots persist after the RDS instance is deleted.",
                  goodZhHk: "Automated backups 同 transaction logs 可以做到 point-in-time recovery，而 manual snapshots 喺刪除 RDS instance 之後仍然保留。",
                  wrongOutdated: "Automated backups are kept forever after deleting the database.",
                },
              }),
            }],
          },
        },
      };
    }
    return {
      stopReason: "end_turn",
      output: { message: { role: "assistant", content: [{ text: JSON.stringify(distinctRdsQuestion) }] } },
    };
  };

  const grader = async ({ transcript }) => ({
    concepts: transcript.includes("point-in-time recovery")
      ? [
          { id: "pitr-logs", verdict: "met", evidence: "point-in-time recovery" },
          { id: "manual-retention", verdict: "met", evidence: "manual snapshots" },
        ]
      : [
          { id: "pitr-logs", verdict: "missing", evidence: "" },
          { id: "manual-retention", verdict: "missing", evidence: "" },
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

  const res = await generator.generateOrRefreshQuestion({
    serviceId: "rds",
    label: "Amazon RDS",
    passage: "Amazon RDS manages relational databases.",
    avoidQuestions: [existingRdsQuestion],
  });
  assert.equal(attempt, 2);
  assert.match(receivedCritique, /overlaps too closely/);
  assert.equal(res.question.id, "automated-backups-pitr");

  // Also verify runQuestionBatchJob loads baseline questions.json (e.g. s3 has 2 baseline questions)
  // and accumulates each generated slot into avoidQuestions for the next slot
  const seenAvoidCounts = [];
  await runQuestionBatchJob({
    mode: "generate",
    services: ["s3"],
    countPerService: 2,
    publish: false,
    generator: {
      async generateOrRefreshQuestion({ serviceId, slotIndex, avoidQuestions }) {
        seenAvoidCounts.push(avoidQuestions.length);
        return {
          question: sampleGeneratedQuestion(serviceId, `s3-new-${slotIndex}`, 1, null),
          calibration: { goodEnScore: 100, goodZhHkScore: 100, wrongOutdatedScore: 0 },
        };
      },
    },
  });
  // s3 has 2 baseline questions in questions.json -> slot 1 sees 2 avoidQuestions, slot 2 sees 3 avoidQuestions!
  assert.deepEqual(seenAvoidCounts, [2, 3]);
});

test("Inner Agent maxTurnsPerNode and Outer Graph maxAttempts prevent infinite loops", async () => {
  const mockWebTool = tool({
    name: "nova_web_search",
    description: "Mock Nova web search",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    callback: async () => ({ answer: "Still searching...", citations: [] }),
  });

  let modelTurnCalls = 0;
  const runawayToolGenerator = createQuestionGenerator({
    webSearchTool: mockWebTool,
    docTools: [],
    maxTurnsPerNode: 3,
    maxAttempts: 2,
    send: async () => {
      modelTurnCalls++;
      return {
        stopReason: "tool_use",
        output: {
          message: {
            role: "assistant",
            content: [{
              toolUse: {
                toolUseId: `loop-${modelTurnCalls}`,
                name: "nova_web_search",
                input: { query: `infinite loop turn ${modelTurnCalls}` },
              },
            }],
          },
        },
      };
    },
  });

  await assert.rejects(
    () => runawayToolGenerator.generateOrRefreshQuestion({
      serviceId: "s3",
      label: "Amazon S3",
      passage: "Amazon S3 stores objects.",
    }),
    /exceeded maximum inner loop turns \(3\)/
  );
  assert.equal(modelTurnCalls, 3);
});
