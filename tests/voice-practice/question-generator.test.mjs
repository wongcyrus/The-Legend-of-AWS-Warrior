import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "../../src/VoiceAgent/node_modules/@strands-agents/sdk/dist/src/index.js";
import { questionClaimFields, readAwsSource, validateFactualReview,
  validateSourceClaims, validateTechnicalTranslations } from "../../src/VoiceAgent/question-quality.mjs";
import {
  classifyFailureStage,
  createNovaWebSearchTool,
  createQuestionGenerator,
  extractNovaGroundingResult,
  findDuplicateOrOverlappingQuestion,
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

const sourceUrl = "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html";
const sourceText = "Multi-AZ DB instance deployments maintain a synchronous standby in another Availability Zone for automatic failover. The standby cannot serve read traffic. Read Replicas use asynchronous replication to offload read queries.";
const sampleClaims = question => [...questionClaimFields(question)].map(([field, claim]) => ({
  field, claim, sourceUrl, quote: sourceText,
}));
const sampleFactualReview = question => ({
  passed: true, failureStage: "rubric", issues: [],
  claimReviews: [...questionClaimFields(question).keys()].map(field => ({
    field, verdict: "supported", reason: "The retrieved passage supports this deployment variant.",
  })),
  alternativesRequired: false,
  alternativeReason: "This is a fixed feature comparison, not an architectural implementation choice.",
  alternativeAnswers: [],
});

function groundedQualityGenerator(question, { passage = sourceText, review = sampleFactualReview(question),
  transcripts = sampleSyntheticTranscripts, grader, changeClaims, changeRubric, readUrl = sourceUrl } = {}) {
  const stats = { reviews: 0, grades: 0, sourceReads: 0, feedback: [] };
  let researchTurn = 0;
  let calibrated = false;
  const docs = tool({
    name: "aws_web_answer", description: "Mock discovery",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    callback: async () => ({ citations: [{ url: sourceUrl }] }),
  });
  const generator = createQuestionGenerator({
    webSearchTool: null, docTools: [docs], maxAttempts: 1,
    sourceReader: async url => { stats.sourceReads++; return { url, text: passage }; },
    grader: async input => { stats.grades++; return grader(input); },
    send: async command => {
      stats.feedback.push(...command.input.messages.flatMap(message => message.content)
        .filter(block => block.toolResult).map(block => JSON.stringify(block.toolResult)));
      const system = command.input.system[0].text;
      if (system.startsWith("You are FactualReviewAgent")) {
        stats.reviews++;
        const payload = JSON.parse(command.input.messages[0].content[0].text);
        return structuredResponse(command, typeof review === "function" ? review(payload) : review);
      }
      if (system.includes("AwsDocsFactCheckerAgent")) {
        if (researchTurn++ < 2) return {
          stopReason: "tool_use", output: { message: { content: [{
            toolUse: { toolUseId: `research-${researchTurn}`,
              name: researchTurn === 1 ? "aws_web_answer" : "read_aws_sources",
              input: researchTurn === 1 ? { query: "Source facts" } : { urls: [readUrl] } },
          }] } },
        };
        const response = questionNodeResponse(command, question);
        const output = response.output.message.content[0].toolUse.input;
        output.sourceClaims = sampleClaims(question).map(claim => ({ ...claim, quote: passage }));
        changeClaims?.(output.sourceClaims);
        changeRubric?.(output);
        return response;
      }
      if (system.includes("CalibrationCriticAgent")) {
        if (!calibrated) {
          calibrated = true;
          return { stopReason: "tool_use", output: { message: { content: [{
            toolUse: { toolUseId: "calibrate", name: "verify_and_calibrate_question",
              input: { question, syntheticTranscripts: transcripts } },
          }] } } };
        }
        return structuredResponse(command, { question, syntheticTranscripts: transcripts });
      }
      return questionNodeResponse(command, question);
    },
  });
  return { generator, stats };
}

function structuredResponse(command, output) {
  if (command.input.system?.[0]?.text.includes("CalibrationCriticAgent") && !output.review) {
    output = { ...output, review: { passed: true, failureStage: "rubric", issues: [] } };
  }
  const outputTool = command.input.toolConfig.tools.find(
    entry => entry.toolSpec?.name === "strands_structured_output"
  );
  assert.ok(outputTool, "Every generator node must request structured output");
  assert.equal(outputTool.toolSpec.inputSchema.json.type, "object");
  return {
    stopReason: "tool_use",
    output: {
      message: {
        role: "assistant",
        content: [{
          toolUse: {
            toolUseId: "structured-output",
            name: outputTool.toolSpec.name,
            input: output,
          },
        }],
      },
    },
  };
}

function questionNodeResponse(command, question) {
  const systemText = command.input.system?.[0]?.text ?? "";
  if (systemText.includes("InterviewQuestionMinerAgent")) {
    return structuredResponse(command, {
      serviceId: question.serviceId,
      candidateId: question.id,
      interviewTopic: question.title,
      commonQuestion: question.prompts["en-US"],
      typicalCommunityAnswer: question.referenceAnswer,
      suspectedOutdatedClaims: question.misconceptions,
      webCitations: [],
    });
  }
  if (systemText.includes("AwsDocsFactCheckerAgent")) {
    const { id, serviceId, title, concepts, misconceptions, acceptableAnswers, referenceAnswer } = question;
    return structuredResponse(command, {
      id, serviceId, title, concepts, misconceptions, acceptableAnswers, referenceAnswer,
      enPrompt: question.prompts["en-US"],
      awsDocCitations: ["https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html"],
      sourceClaims: sampleClaims(question),
    });
  }
  if (systemText.startsWith("You are FactualReviewAgent")) return structuredResponse(command, sampleFactualReview(question));
  return structuredResponse(command, question);
}

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
  let checkerReadSource = false;
  let criticCalledTool = false;
  const q = sampleGeneratedQuestion("rds", "multi-az-failover", 1, null);

  const send = async command => {
    const sys = command.input.system?.[0]?.text ?? "";
    if (sys.startsWith("You are FactualReviewAgent")) {
      assert.doesNotMatch(command.input.messages[0].content[0].text, /goodEnScore|goodZhHkScore/);
      return questionNodeResponse(command, q);
    }
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
      return questionNodeResponse(command, q);
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
      if (!checkerReadSource) {
        checkerReadSource = true;
        return { stopReason: "tool_use", output: { message: { role: "assistant", content: [{
          toolUse: { toolUseId: "read-source", name: "read_aws_sources", input: { urls: [sourceUrl] } },
        }] } } };
      }
      const handoff = command.input.messages.flatMap(message => message.content)
        .filter(block => typeof block.text === "string").map(block => block.text).join("\n");
      assert.match(handoff, /"candidateId":"multi-az-failover"/);
      return questionNodeResponse(command, q);
    }
    if (sys.includes("TrilingualLocalizationAgent")) {
      return questionNodeResponse(command, q);
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
      return structuredResponse(command, { question: q, syntheticTranscripts: sampleSyntheticTranscripts });
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
    sourceReader: async url => ({ url, text: sourceText }),
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
  assert.equal(result.question.status, "draft");
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
  assert.doesNotThrow(() => JSON.stringify(result.trace));
});

test("Structured critic output preserves refresh metadata and cannot reuse calibration for a changed final question", async () => {
  const question = sampleGeneratedQuestion();
  let finalQuestion = question;
  let criticTurn = 0;
  let gradingCalls = 0;
  const generator = createQuestionGenerator({
    webSearchTool: null,
    docTools: [],
    maxAttempts: 1,
    send: async command => {
      const systemText = command.input.system?.[0]?.text ?? "";
      if (!systemText.includes("CalibrationCriticAgent")) {
        return questionNodeResponse(command, question);
      }
      criticTurn++;
      if (criticTurn === 1) {
        return {
          stopReason: "tool_use",
          output: {
            message: {
              role: "assistant",
              content: [{
                toolUse: {
                  toolUseId: "calibrate",
                  name: "verify_and_calibrate_question",
                  input: { question, syntheticTranscripts: sampleSyntheticTranscripts },
                },
              }],
            },
          },
        };
      }
      return structuredResponse(command, {
        question: finalQuestion,
        syntheticTranscripts: sampleSyntheticTranscripts,
      });

    },
    grader: async ({ transcript }) => {
      gradingCalls++;
      const met = transcript.includes("synchronous standby");
      return {
        concepts: question.concepts.map((concept, index) => ({
          id: concept.id,
          verdict: met ? "met" : "missing",
          evidence: met ? (index === 0 ? "synchronous standby" : "Read Replicas") : "",
        })),
        feedback: "Checked.",
      };
    },
  });
  const input = {
    serviceId: "rds",
    label: "Amazon RDS",
    passage: "Amazon RDS manages relational databases.",
    existingQuestion: { ...question, id: "locked-rds-id", version: 2, expectedRevision: 5 },
    status: "draft",
  };
  const refreshed = await generator.generateOrRefreshQuestion(input);
  assert.equal(refreshed.question.id, "locked-rds-id");
  assert.equal(refreshed.question.version, 3);
  assert.equal(refreshed.question.expectedRevision, 5);
  assert.equal(refreshed.question.status, "draft");
  assert.equal(gradingCalls, 3, "An unchanged structured result reuses its successful calibration");

  criticTurn = 0;
  finalQuestion = {
    ...question,
    concepts: [{ ...question.concepts[0], weight: 50 }, question.concepts[1]],
  };
  await assert.rejects(
    () => generator.generateOrRefreshQuestion(input),
    /Invalid Q&A question/
  );
});

test("omitted provider revision metadata is assigned by the server for new questions and refreshes", async () => {
  const question = sampleGeneratedQuestion();
  const { expectedRevision, ...modelQuestion } = question;
  const generator = createQuestionGenerator({
    webSearchTool: null, docTools: [], maxAttempts: 1,
    send: async command => {
      if (command.input.system?.[0]?.text.includes("CalibrationCriticAgent")) {
        return structuredResponse(command, { question: modelQuestion, syntheticTranscripts: sampleSyntheticTranscripts });
      }
      return questionNodeResponse(command, modelQuestion);
    },
    grader: async ({ transcript }) => ({
      concepts: question.concepts.map((concept, index) => ({
        id: concept.id, verdict: transcript.includes("synchronous standby") ? "met" : "missing",
        evidence: transcript.includes("synchronous standby") ? (index ? "Read Replicas" : "synchronous standby") : "",
      })), feedback: "Checked.",
    }),
  });
  const input = { serviceId: "rds", label: "RDS", passage: "RDS" };
  const generated = await generator.generateOrRefreshQuestion(input);
  assert.equal(generated.question.expectedRevision, null);
  const refreshed = await generator.generateOrRefreshQuestion({
    ...input, existingQuestion: { ...question, expectedRevision: 5, version: 2 },
  });
  assert.equal(refreshed.question.expectedRevision, 5);
  assert.equal(refreshed.question.version, 3);
  assert.equal(refreshed.question.id, question.id);
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
      return structuredResponse(command, { question: chosen, syntheticTranscripts: sampleSyntheticTranscripts });
    }
    return questionNodeResponse(command, qGood);
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
        return structuredResponse(command, { question: chosen, syntheticTranscripts: sampleSyntheticTranscripts });
      }
      return questionNodeResponse(command, qGood);
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
      status: "approved",
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
      status: "approved",
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
      status: "approved",
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
      return structuredResponse(command, {
        question: chosen,
        syntheticTranscripts: {
          goodEn: "Automated backups and transaction logs enable point-in-time recovery to any second, while manual snapshots persist after the RDS instance is deleted.",
          goodZhHk: "Automated backups 同 transaction logs 可以做到 point-in-time recovery，而 manual snapshots 喺刪除 RDS instance 之後仍然保留。",
          wrongOutdated: "Automated backups are kept forever after deleting the database.",
        },
      });
    }
    return questionNodeResponse(command, distinctRdsQuestion);
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
    status: "approved",
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

test("Strands structured output retries text replies and invalid schema fields within a node", async () => {
  const mockWebTool = tool({
    name: "nova_web_search",
    description: "Mock Nova web search",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    callback: async () => ({ answer: "RDS Multi-AZ high availability", citations: [] }),
  });
  const mockDocTool = tool({
    name: "aws___search_documentation",
    description: "Mock AWS docs search",
    inputSchema: {
      type: "object",
      properties: { search_phrase: { type: "string" } },
      required: ["search_phrase"],
    },
    callback: async () => ({ results: [{ title: "RDS Multi-AZ", url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html" }] }),
  });

  let localizerTurn = 0;
  const generator = createQuestionGenerator({
    webSearchTool: mockWebTool,
    docTools: [mockDocTool],
    sourceReader: async url => ({ url, text: sourceText }),
    send: async command => {
      const systemText = command.input?.system?.[0]?.text ?? "";
      if (systemText.includes("AwsDocsFactCheckerAgent") &&
          !command.input.messages.some(message => message.content.some(block => block.toolResult))) {
        return {
          stopReason: "tool_use",
          output: { message: { role: "assistant", content: [{
            toolUse: { toolUseId: "docs", name: "aws___search_documentation", input: { search_phrase: "RDS Multi-AZ" } },
          }] } },
        };
      }
      if (systemText.includes("AwsDocsFactCheckerAgent") &&
          !command.input.messages.some(message => message.content.some(block => block.toolResult?.toolUseId === "read-source"))) {
        return { stopReason: "tool_use", output: { message: { role: "assistant", content: [{
          toolUse: { toolUseId: "read-source", name: "read_aws_sources", input: { urls: [sourceUrl] } },
        }] } } };
      }
      if (systemText.includes("TrilingualLocalizationAgent")) {
        localizerTurn++;
        if (localizerTurn === 1) {
          return {
            stopReason: "end_turn",
            output: {
              message: {
                role: "assistant",
                content: [{ text: "Sorry, here is some unformatted text without any JSON braces!" }],
              },
            },
          };
        }
        if (localizerTurn === 2) {
          assert.deepEqual(command.input.toolConfig.toolChoice, { tool: { name: "strands_structured_output" } });
          const invalid = sampleGeneratedQuestion("rds", "rds-multi-az");
          delete invalid.prompts["zh-CN"];
          invalid.concepts[0].weight = "60";
          return structuredResponse(command, invalid);
        }
        const toolErrors = command.input.messages.flatMap(message => message.content)
          .filter(block => block.toolResult);
        assert.ok(toolErrors.length > 0, "Schema errors must be returned to Nova for correction");
        assert.match(JSON.stringify(toolErrors), /zh-CN/);
        assert.match(JSON.stringify(toolErrors), /weight/);
        return questionNodeResponse(command, sampleGeneratedQuestion("rds", "rds-multi-az"));
      }
      if (systemText.includes("CalibrationCriticAgent")) {
        return structuredResponse(command, {
          question: sampleGeneratedQuestion("rds", "rds-multi-az"),
          syntheticTranscripts: sampleSyntheticTranscripts,
        });
      }
      return questionNodeResponse(command, sampleGeneratedQuestion("rds", "rds-multi-az"));
    },
    grader: async ({ transcript }) => {
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
    },
  });

  const result = await generator.generateOrRefreshQuestion({
    serviceId: "rds",
    label: "Amazon RDS",
    passage: "Amazon RDS manages relational databases.",
  });

  assert.equal(localizerTurn, 3);
  assert.equal(result.question.id, "rds-multi-az");
  const nodes = result.trace.topology.nodes;
  for (const node of nodes) {
    assert.equal(node.harness, true);
    assert.equal(node.structuredOutput, true);
  }
  const minerNode = nodes.find(n => n.id === "interview_miner");
  assert.ok(minerNode.plugins.includes("strands:context-offloader"));
  assert.equal(result.trace.steps.length, 4, "Schema retries stay within the localizer node");
});

test("default Chinese models include grounding and production-like calibration grading in usage", async () => {
  const q = sampleGeneratedQuestion();
  const generator = createQuestionGenerator({
    docTools: [],
    send: async command => {
      const sys = command.input.system?.[0]?.text ?? "";
      if (command.input.toolConfig?.tools?.[0]?.systemTool) {
        return { stopReason: "end_turn", output: { message: { content: [{ text: "Research topic" }] } },
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
      }
      if (sys.includes("You grade the student's CURRENT answer")) {
        const request = JSON.parse(command.input.messages[0].content[0].text);
        const met = request.transcript.includes("synchronous standby");
        return {
          stopReason: "end_turn",
          output: { message: { content: [{ text: JSON.stringify({
            concepts: q.concepts.map((concept, index) => ({
              id: concept.id, verdict: met ? "met" : "missing",
              evidence: met ? (index === 0 ? "synchronous standby" : "Read Replicas") : "",
            })), feedback: "Checked.",
          }) }] } },
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        };
      }
      if (sys.includes("InterviewQuestionMinerAgent") &&
          !command.input.messages.some(message => message.content.some(block => block.toolResult))) {
        return { stopReason: "tool_use", output: { message: { content: [{
          toolUse: { toolUseId: "grounding", name: "nova_web_search", input: { query: "RDS interview" } },
        }] } }, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
      }
      const response = sys.includes("CalibrationCriticAgent")
        ? structuredResponse(command, { question: q, syntheticTranscripts: sampleSyntheticTranscripts })
        : questionNodeResponse(command, q);
      return { ...response, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
    },
  });
  const { trace, question } = await generator.generateOrRefreshQuestion({ serviceId: "rds", label: "RDS", passage: "RDS" });
  assert.equal(question.status, "draft");
  assert.equal(trace.modelInvocations.filter(record => record.role === "grader").length, 3);
  assert.equal(trace.modelInvocations.filter(record => record.role === "grounding").length, 1);
  assert.equal(trace.modelInvocations.find(record => record.role === "factChecker").modelId, "zai.glm-5");
  assert.equal(trace.modelInvocations.find(record => record.role === "localizer").modelId, "qwen.qwen3-next-80b-a3b");
  assert.equal(trace.modelInvocations.find(record => record.role === "critic").modelId, "deepseek.v3.2");
  assert.equal(trace.usage.totalTokens, trace.modelInvocations.length * 12);
  assert.equal(trace.usageComplete, true);
});

test("persistent research budget forces structured output after two calls even across tool history", async () => {
  const q = sampleGeneratedQuestion();
  let researchCalls = 0;
  const docTool = tool({
    name: "aws_web_answer",
    description: "Evidence",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    callback: async () => { researchCalls++; return {
      citations: [{ url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html" }],
    }; },
  });
  const generator = createQuestionGenerator({
    webSearchTool: null, docTools: [docTool],
    sourceReader: async url => { researchCalls++; return { url, text: sourceText }; },
    grader: async ({ transcript }) => ({
      concepts: q.concepts.map((concept, index) => ({
        id: concept.id, verdict: transcript.includes("synchronous standby") ? "met" : "missing",
        evidence: transcript.includes("synchronous standby") ? (index ? "Read Replicas" : "synchronous standby") : "",
      })), feedback: "Checked.",
    }),
    send: async command => {
      const sys = command.input.system?.[0]?.text ?? "";
      if (sys.includes("AwsDocsFactCheckerAgent")) {
        if (researchCalls < 2) return {
          stopReason: "tool_use",
          output: { message: { content: [{
            toolUse: { toolUseId: `research-${researchCalls}`,
              name: researchCalls === 0 ? "aws_web_answer" : "read_aws_sources",
              input: researchCalls === 0 ? { query: "RDS" } : { urls: [sourceUrl] } },
          }] } },
        };
        assert.deepEqual(command.input.toolConfig.toolChoice, { tool: { name: "strands_structured_output" } });
      }
      if (sys.includes("CalibrationCriticAgent")) {
        assert.match(sys, /PRIVATE_RESEARCH_EVIDENCE:/);
        assert.match(sys, /Concepts.MultiAZ.html/);
        return structuredResponse(command, { question: q, syntheticTranscripts: sampleSyntheticTranscripts });
      }
      return questionNodeResponse(command, q);
    },
  });
  const { trace, question } = await generator.generateOrRefreshQuestion({ serviceId: "rds", label: "RDS", passage: "RDS" });
  assert.equal(researchCalls, 2);
  assert.equal(trace.evidence.length, 2);
  assert.deepEqual(question.sources, ["https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html"]);
});

test("independent critic rejection overrides successful calibration and retains failed traces", async () => {
  const q = sampleGeneratedQuestion();
  let criticCalls = 0;
  let gradingCalls = 0;
  const generator = createQuestionGenerator({
    webSearchTool: null, docTools: [], maxAttempts: 1,
    grader: async ({ transcript }) => {
      gradingCalls++;
      return { concepts: q.concepts.map((concept, index) => ({
        id: concept.id, verdict: transcript.includes("synchronous standby") ? "met" : "missing",
        evidence: transcript.includes("synchronous standby") ? (index ? "Read Replicas" : "synchronous standby") : "",
      })), feedback: "Checked." };
    },
    send: async command => {
      if (command.input.system?.[0]?.text.includes("CalibrationCriticAgent")) {
        if (++criticCalls === 1) return {
          stopReason: "tool_use", output: { message: { content: [{
            toolUse: { toolUseId: "calibrate", name: "verify_and_calibrate_question",
              input: { question: q, syntheticTranscripts: sampleSyntheticTranscripts } },
          }] } },
        };
        return structuredResponse(command, {
          question: q, syntheticTranscripts: sampleSyntheticTranscripts,
          review: { passed: false, failureStage: "rubric", issues: ["Snapshot rollback claim is unsupported"] },
        });
      }
      return questionNodeResponse(command, q);
    },
  });
  await assert.rejects(
    generator.generateOrRefreshQuestion({ serviceId: "rds", label: "RDS", passage: "RDS" }),
    error => {
      assert.match(error.message, /rollback claim is unsupported/);
      assert.equal(error.trace.status, "FAILED");
      assert.ok(error.trace.modelInvocations.length);
      return true;
    },
  );
  assert.equal(gradingCalls, 3);
});

test("source claims require verbatim retrieved passages and coverage, not just matching AWS URLs", () => {
  const q = sampleGeneratedQuestion();
  const claims = sampleClaims(q);
  const passages = [{ url: sourceUrl, text: sourceText }];
  assert.doesNotThrow(() => validateSourceClaims(q, claims, passages));
  assert.throws(() => validateSourceClaims(q, claims, []), /quotation was not found/);
  assert.throws(() => validateSourceClaims(q, [
    { ...claims[0], quote: "A fabricated default not stated by the source." }, ...claims.slice(1),
  ], passages), /quotation was not found/);
  assert.throws(() => validateSourceClaims(q, claims.filter(claim => claim.field !== "concepts.vs-read-replica"), passages),
    /do not cover rubric fields: concepts.vs-read-replica/);
  assert.throws(() => validateSourceClaims(q, [{ ...claims[0], field: "inventedField" }, ...claims.slice(1)], passages),
    /unknown rubric field/);
});

test("PITR glossary rejects the observed point-to-point translations and formal-only Cantonese", async () => {
  const q = sampleGeneratedQuestion();
  q.prompts = {
    "en-US": "How would you configure point-in-time recovery (PITR)?",
    "zh-HK": "你會點樣設定時間點還原 (PITR)？",
    "zh-CN": "你会如何配置时间点恢复 (PITR)？",
  };
  assert.doesNotThrow(() => validateTechnicalTranslations(q));
  for (const [language, badPrompt] of [
    ["zh-HK", "你會點樣設定點對點恢復？"],
    ["zh-CN", "你会如何配置点对点恢复？"],
  ]) {
    const invalid = { ...q, prompts: { ...q.prompts, [language]: badPrompt } };
    assert.throws(() => validateTechnicalTranslations(invalid), error => error.failureStage === "localization");
    const { generator, stats } = groundedQualityGenerator(invalid);
    await assert.rejects(generator.generateOrRefreshQuestion({ serviceId: "rds" }), /mistranslates point-in-time/);
    assert.equal(stats.reviews, 0);
    assert.equal(stats.grades, 0);
  }
  assert.throws(() => validateTechnicalTranslations({
    ...q, prompts: { ...q.prompts, "zh-HK": "你應該如何設定備份和恢復？" },
  }), /spoken Cantonese/);
});

test("S3 timing, duration and RDS source contradictions fail before grading and cannot be voted away", async () => {
  for (const defect of [
    {
      serviceId: "s3",
      claim: "Lifecycle rules cannot transition objects before the minimum duration of the target class.",
      passage: "Certain storage classes have a minimum object storage duration. If you transition objects out of these storage classes before the minimum duration, you are charged for the remainder of that duration.",
      reason: "The draft confuses entering a target class with exiting a class and minimum-duration charges.",
    },
    {
      serviceId: "s3",
      prompt: "Files are processed for 30 days, then retained for another 90 days before archive. When should they transition?",
      claim: "Transition to the archive after 90 days from creation.",
      passage: "Lifecycle transition rules specify the age of objects in days after creation.",
      reason: "Thirty active days plus another ninety retained days means 120 total days, not 90.",
    },
    {
      serviceId: "rds",
      claim: "Default retention is 7 days.",
      passage: "If you create a DB instance using the Amazon RDS API or the AWS CLI and if you don't set the backup retention period, the default backup retention period is one day. If you create a DB instance using the console, the default backup retention period is seven days.",
      reason: "Seven days is only the console default; API/CLI defaults are one day.",
    },
  ]) {
    const q = sampleGeneratedQuestion(defect.serviceId);
    q.referenceAnswer = defect.claim;
    if (defect.prompt) q.prompts["en-US"] = defect.prompt;
    const { generator, stats } = groundedQualityGenerator(q, {
      passage: defect.passage,
      review: payload => {
        assert.equal(payload.question.referenceAnswer, defect.claim);
        assert.equal(payload.sourcePassages[0].text, defect.passage);
        assert.ok(payload.sourceClaims.some(claim => claim.field === "referenceAnswer"));
        assert.equal(payload.syntheticTranscripts, undefined);
        assert.equal(payload.calibration, undefined);
        const review = sampleFactualReview(q);
        review.claimReviews.find(claim => claim.field === "referenceAnswer").verdict = "contradicted";
        review.claimReviews.find(claim => claim.field === "referenceAnswer").reason = defect.reason;
        return review;
      },
    });
    await assert.rejects(generator.generateOrRefreshQuestion({ serviceId: defect.serviceId }), error => {
      assert.match(error.message, /Independent factual review: referenceAnswer/);
      assert.equal(error.trace.qualityReviews[0].status, "failed");
      assert.equal(error.trace.qualityReviews[0].review.passed, true, "A summary approval cannot override a contradictory claim verdict");
      return true;
    });
    assert.equal(stats.reviews, 1, "Tool and final-output retries reuse the rejection for the same candidate");
    assert.equal(stats.grades, 0);
  }
});

test("factual reviewer corrects approval notes in issues before grading", async () => {
  const q = sampleGeneratedQuestion();
  let reviewTurns = 0;
  const { generator, stats } = groundedQualityGenerator(q, {
    review: () => {
      const review = sampleFactualReview(q);
      if (++reviewTurns === 1) review.issues = ["This fixed feature comparison has no architectural alternatives."];
      return review;
    },
    grader: async ({ transcript }) => ({
      concepts: q.concepts.map(concept => ({
        id: concept.id, verdict: transcript === sampleSyntheticTranscripts.wrongOutdated ? "missing" : "met",
        evidence: transcript === sampleSyntheticTranscripts.wrongOutdated ? "" : "Read Replicas",
      })), feedback: "Checked.",
    }),
  });
  const result = await generator.generateOrRefreshQuestion({ serviceId: "rds" });
  assert.equal(stats.reviews, 2);
  assert.equal(stats.grades, 3);
  assert.ok(stats.feedback.some(feedback => feedback.includes("When passed=true, issues must be empty")));
  assert.equal(result.trace.qualityReviews.length, 1);
  assert.deepEqual(result.trace.qualityReviews[0].review.issues, []);
  assert.equal(result.trace.qualityReviews[0].status, "passed");
});

test("missing source passages fail before factual review or grading", async () => {
  const { generator, stats } = groundedQualityGenerator(sampleGeneratedQuestion(), {
    changeClaims: claims => { claims[0].sourceUrl = "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIT.html"; },
  });
  await assert.rejects(generator.generateOrRefreshQuestion({ serviceId: "rds" }), /exceeded maximum inner loop turns/);
  assert.ok(stats.feedback.some(feedback => feedback.includes("Source URL was not read")));
  assert.equal(stats.reviews, 0);
  assert.equal(stats.grades, 0);
  const unseen = groundedQualityGenerator(sampleGeneratedQuestion(), {
    readUrl: "https://example.com/untrusted-doc",
  });
  await assert.rejects(unseen.generator.generateOrRefreshQuestion({ serviceId: "rds" }), /exceeded maximum inner loop turns/);
  assert.ok(unseen.stats.feedback.some(feedback => feedback.includes("No AWS source passages")));
  assert.equal(unseen.stats.sourceReads, 0, "Non-AWS source URLs must never be fetched");
});

test("writer corrects stale citations and server-owned excerpts cannot be forged by model quotations", async () => {
  const q = sampleGeneratedQuestion();
  let writerTurns = 0;
  const { generator, stats } = groundedQualityGenerator(q, {
    changeRubric: output => {
      writerTurns++;
      if (writerTurns === 1) output.awsDocCitations = ["https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIT.html"];
      if (writerTurns === 2) output.sourceClaims[0].quote = "This invented quotation was never read from an AWS page.";
    },
    grader: async ({ transcript }) => ({
      concepts: q.concepts.map(concept => ({
        id: concept.id, verdict: transcript === sampleSyntheticTranscripts.wrongOutdated ? "missing" : "met",
        evidence: transcript === sampleSyntheticTranscripts.wrongOutdated ? "" : "Read Replicas",
      })), feedback: "Checked.",
    }),
  });
  const result = await generator.generateOrRefreshQuestion({ serviceId: "rds" });
  assert.equal(result.question.id, q.id);
  assert.equal(writerTurns, 2);
  assert.equal(stats.sourceReads, 1);
  assert.equal(stats.reviews, 1);
  assert.equal(stats.grades, 3);
  assert.ok(stats.feedback.some(feedback => feedback.includes("not prior visits")));
  const claims = result.trace.qualityReviews[0].sourceClaims;
  assert.ok(claims.every(claim => sourceText.includes(claim.quote)));
  assert.ok(claims.every(claim => !claim.quote.includes("invented quotation")));
  const calls = result.trace.steps.find(step => step.nodeId === "aws_docs_fact_checker").toolCalls;
  assert.deepEqual(calls.filter(call => call.name === "strands_structured_output").map(call => call.status), ["error", "success"]);
});

test("canonical AWS documentation not listed by discovery is evidence only after its page is read", async () => {
  const q = sampleGeneratedQuestion();
  const canonical = "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html";
  const { generator, stats } = groundedQualityGenerator(q, {
    readUrl: canonical,
    changeRubric: output => {
      output.awsDocCitations = [canonical];
      output.sourceClaims.forEach(claim => { claim.sourceUrl = canonical; });
    },
    grader: async ({ transcript }) => ({
      concepts: q.concepts.map(concept => ({
        id: concept.id, verdict: transcript === sampleSyntheticTranscripts.wrongOutdated ? "missing" : "met",
        evidence: transcript === sampleSyntheticTranscripts.wrongOutdated ? "" : "Read Replicas",
      })), feedback: "Checked.",
    }),
  });
  const result = await generator.generateOrRefreshQuestion({ serviceId: "rds" });
  assert.equal(stats.sourceReads, 1);
  assert.ok(result.question.sources.includes(canonical));
});

test("EC2 and CloudFront valid alternatives must pass calibration rather than being punished for optional services", async () => {
  for (const service of ["ec2", "cloudfront"]) {
    const q = sampleGeneratedQuestion(service, `${service}-optional-services`);
    q.title = service === "ec2" ? "Rolling patch updates" : "Caching immutable game assets";
    q.prompts = service === "ec2" ? {
      "en-US": "How would you patch EC2 instances behind a load balancer while maintaining healthy capacity?",
      "zh-HK": "你會點樣幫負載平衡器後面嘅 EC2 instances 更新補丁，同時保持健康容量？",
      "zh-CN": "你会如何为负载均衡器后面的 EC2 实例更新补丁，同时保持健康容量？",
    } : {
      "en-US": "How would you cache immutable game assets in CloudFront and reduce origin load?",
      "zh-HK": "你會點樣喺 CloudFront 快取唔會改嘅遊戲資源，同時減少 origin 負載？",
      "zh-CN": "你会如何在 CloudFront 缓存不可变的游戏资源，同时减少源站负载？",
    };
    q.concepts = service === "ec2" ? [
      { id: "healthy-capacity", description: "Maintain healthy serving capacity during a controlled rolling update.", weight: 60 },
      { id: "patch-delivery", description: "Deliver operating system patches using an automated mechanism.", weight: 40 },
    ] : [
      { id: "cache-control", description: "Use versioned immutable assets and appropriate cache headers.", weight: 60 },
      { id: "origin-offload", description: "Reduce origin requests through effective caching.", weight: 40 },
    ];
    q.misconceptions = [service === "ec2" ? "All EC2 instances must stop simultaneously for patching." : "All static assets require a zero TTL."];
    q.referenceAnswer = service === "ec2"
      ? "Use Instance Refresh and Image Builder to deploy patched AMIs while preserving healthy capacity."
      : "Use versioned filenames, cache headers and Origin Shield to reduce origin load.";
    q.acceptableAnswers = [q.referenceAnswer];
    const transcripts = {
      goodEn: q.referenceAnswer,
      goodZhHk: `我哋會用 ${service === "ec2" ? "Instance Refresh 同 Image Builder" : "Origin Shield 同 versioned filenames"}。`,
      wrongOutdated: q.misconceptions[0],
    };
    const alternative = service === "ec2"
      ? "Use Patch Manager with a rolling maintenance plan and load-balancer draining."
      : "Use versioned filenames and appropriate cache headers without Origin Shield.";
    const passage = service === "ec2"
      ? "Patch Manager automates operating system patching. A rolling maintenance plan can drain instances from the load balancer while maintaining healthy capacity."
      : "Versioned filenames and appropriate cache headers improve cache hit rates and reduce origin requests. Origin Shield is an optional additional caching layer.";
    const review = { ...sampleFactualReview(q), alternativesRequired: true,
      alternativeReason: "The scenario does not require the specific AWS implementation.",
      alternativeAnswers: [{ answer: alternative, sourceUrl, quote: passage }] };
    for (const acceptsAlternative of [false, true]) {
      const { generator, stats } = groundedQualityGenerator(q, {
        review, passage, transcripts,
        grader: async ({ transcript }) => {
          const met = transcript === alternative ? acceptsAlternative : transcript !== transcripts.wrongOutdated;
          return {
            concepts: q.concepts.map(concept => ({
              id: concept.id, verdict: met ? "met" : "missing",
              evidence: met ? (transcript === alternative ? (service === "ec2" ? "Patch Manager" : "versioned filenames") : (service === "ec2" ? "Instance Refresh" : "Origin Shield")) : "",
            })), feedback: "Checked.",
          };
        },
      });
      if (acceptsAlternative) {
        const result = await generator.generateOrRefreshQuestion({ serviceId: service });
        assert.deepEqual(result.calibration.alternativeScores, [100]);
      } else {
        await assert.rejects(generator.generateOrRefreshQuestion({ serviceId: service }), /Valid alternative answer failed calibration/);
      }
      assert.equal(stats.reviews, 1);
      assert.equal(stats.grades, acceptsAlternative ? 4 : 8);
    }
  }
  const q = sampleGeneratedQuestion();
  assert.throws(() => validateFactualReview({
    ...sampleFactualReview(q), alternativesRequired: true,
  }, sampleClaims(q), [{ url: sourceUrl, text: sourceText }]), /lacks a source-backed valid alternative/);
  assert.throws(() => validateFactualReview({
    ...sampleFactualReview(q), claimReviews: sampleFactualReview(q).claimReviews.slice(1),
  }, sampleClaims(q), []), /omitted claim fields/);
});

test("AWS source reader extracts bounded text and follows only bounded, allowlisted AWS redirects", async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, sourceUrl);
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal);
    return new Response(`<html><nav>irrelevant navigation</nav><div id="main-col-body"><script>hidden instructions</script><p>${sourceText}</p><p>RPO &amp; RTO</p></div></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } });
  };
  const passage = await readAwsSource(sourceUrl + "#details", { fetchImpl });
  assert.match(passage.text, /RPO & RTO/);
  assert.doesNotMatch(passage.text, /hidden instructions|irrelevant navigation/);
  for (const url of ["http://docs.aws.amazon.com/page", "https://example.com/page", "https://user@aws.amazon.com/page",
    "https://aws.amazon.com/page?query=anything"]) {
    await assert.rejects(readAwsSource(url, { fetchImpl }), /official AWS HTTPS/);
  }
  assert.equal(calls, 1);
  await assert.rejects(readAwsSource(sourceUrl, {
    fetchImpl: async () => new Response("a".repeat(1000001), { headers: { "content-type": "text/plain" } }),
  }), /one-megabyte/);
  await assert.rejects(readAwsSource(sourceUrl, {
    fetchImpl: async () => new Response("binary", { headers: { "content-type": "application/octet-stream" } }),
  }), /requires HTML or plain text/);
  await assert.rejects(readAwsSource(sourceUrl, {
    fetchImpl: async () => { throw new TypeError("redirect rejected"); },
  }), /redirect rejected/);
  const resolvedUrl = "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html";
  const redirected = await readAwsSource(sourceUrl, {
    fetchImpl: async url => url === sourceUrl
      ? new Response("", { status: 302, headers: { location: resolvedUrl } })
      : new Response(sourceText, { headers: { "content-type": "text/plain" } }),
  });
  assert.equal(redirected.resolvedUrl, resolvedUrl);
  assert.doesNotThrow(() => validateSourceClaims(sampleGeneratedQuestion(),
    sampleClaims(sampleGeneratedQuestion()).map(claim => ({ ...claim, sourceUrl: resolvedUrl })), [redirected]));
  let unsafeRedirectCalls = 0;
  await assert.rejects(readAwsSource(sourceUrl, {
    fetchImpl: async () => {
      unsafeRedirectCalls++;
      return new Response("", { status: 302, headers: { location: "https://example.com/page" } });
    },
  }), /official AWS HTTPS/);
  assert.equal(unsafeRedirectCalls, 1);
  let redirectCalls = 0;
  await assert.rejects(readAwsSource(sourceUrl, {
    fetchImpl: async () => {
      redirectCalls++;
      return new Response("", { status: 301, headers: { location: sourceUrl } });
    },
  }), /redirect limit/);
  assert.equal(redirectCalls, 4);
});

test("Web Answer cannot silently fall back on an empty or failed Gateway session", async () => {
  let disconnected = false;
  const generator = createQuestionGenerator({
    evidenceSource: "web-answer", webAnswerUrl: "https://unused",
    webAnswerLoader: async () => ({ tools: [], disconnect: async () => { disconnected = true; } }),
  });
  await assert.rejects(generator.generateOrRefreshQuestion({ serviceId: "rds" }), /evidence tool is required/);
  assert.equal(disconnected, true);
});

test("generation CLI rejects implicit publication before any AWS work or checkpoint writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-draft-cli-"));
  try {
    const file = join(directory, "drafts.json");
    const result = spawnSync(process.execPath, [
      "src/VoicePractice/question-bank.mjs", "generate", file, "rds", "--publish", "--no-publish",
    ], { encoding: "utf8", env: { ...process.env, VOICE_TABLE: "not-a-real-table" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /drafts only/);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fatal parallel batch waits for in-flight work and preserves failed traces across resume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-failed-traces-"));
  try {
    const traceFile = join(directory, "traces.json");
    let completed = false;
    const generator = {
      async generateOrRefreshQuestion({ serviceId, status }) {
        if (serviceId === "rds") {
          const error = new Error("Evidence unavailable");
          error.trace = { serviceId, slotIndex: 1, status: "FAILED", modelInvocations: [{ status: "error" }] };
          throw error;
        }
        await new Promise(resolve => setImmediate(resolve));
        completed = true;
        return {
          question: { ...sampleGeneratedQuestion(serviceId), status },
          trace: { serviceId, slotIndex: 1, status: "COMPLETED" },
        };
      },
    };
    await assert.rejects(runQuestionBatchJob({
      services: ["rds", "ecs"], concurrency: 2, countPerService: 1, traceFile, generator,
    }), /Evidence unavailable/);
    assert.equal(completed, true);
    assert.equal(JSON.parse(readFileSync(traceFile, "utf8")).filter(trace => trace.status === "FAILED").length, 1);
    await runQuestionBatchJob({ services: ["ecs"], countPerService: 1, traceFile, generator });
    assert.equal(JSON.parse(readFileSync(traceFile, "utf8")).filter(trace => trace.status === "FAILED").length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
