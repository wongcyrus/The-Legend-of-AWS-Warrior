import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { Agent, BedrockModel, Graph, McpClient, tool } from "@strands-agents/sdk";
import { createAgent as createGraderAgent } from "./agent.mjs";

const defaultClient = new BedrockRuntimeClient({ maxAttempts: 3, retryMode: "adaptive" });
const cantoneseOnlyChars = /[嘅喺唔畀佢哋乜啲揀嚟]/u;
const forbiddenVoiceClaim = /\b(?:pronunciat\w*|mispronounc\w*|your\s+voice|voice\s+(?:is|was|quality|tone|clarity|inaccurate|accurate)|accent|intonation|enunciat\w*)\b|發音|讀音|咬字|聲線|語調|口音|发音|读音/iu;

export function parseJsonFromText(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Empty model response");
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fenced) return JSON.parse(fenced[1].trim());
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  return JSON.parse(trimmed);
}

export function extractNovaGroundingResult(response) {
  const blocks = response?.output?.message?.content ?? [];
  const textParts = [];
  const queries = [];
  const citations = [];
  for (const block of blocks) {
    if (typeof block?.text === "string") textParts.push(block.text);
    if (block?.toolUse?.name === "nova_grounding" && block.toolUse.input?.query) {
      queries.push(String(block.toolUse.input.query));
    }
    for (const citation of block?.citationsContent?.citations ?? []) {
      const url = citation?.location?.web?.url;
      if (url) citations.push({ title: citation?.title ?? url, url });
    }
  }
  return {
    answer: textParts.join("").trim(),
    queries,
    citations,
  };
}

export function createNovaWebSearchTool({
  send = command => defaultClient.send(command),
  modelId = process.env.VOICE_MODEL_ID ?? "us.amazon.nova-2-lite-v1:0",
} = {}) {
  return tool({
    name: "nova_web_search",
    description: "Search the live web using Amazon Nova Web Grounding (nova_grounding) for common AWS interview questions, community answers, and recent AWS service changes.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query for AWS interview questions or recent AWS service changes.",
        },
      },
      required: ["query"],
    },
    callback: async input => {
      const query = String(input?.query ?? "").trim();
      if (!query) throw new Error("Search query is required");
      const response = await send(new ConverseCommand({
        modelId,
        messages: [{ role: "user", content: [{ text: query }] }],
        toolConfig: { tools: [{ systemTool: { name: "nova_grounding" } }] },
        inferenceConfig: { maxTokens: 1000, temperature: 0 },
      }));
      return extractNovaGroundingResult(response);
    },
  });
}

export async function loadAwsKnowledgeMcpTools({
  url = "https://knowledge-mcp.global.api.aws",
  allowed = ["aws___search_documentation", "aws___read_documentation"],
} = {}) {
  const [mcpClient] = await McpClient.loadServers({
    awsKnowledge: {
      url,
      toolFilters: { allowed },
    },
  });
  const tools = await mcpClient.listTools();
  return {
    tools,
    disconnect: () => mcpClient.disconnect(),
  };
}

function createStrandsNodeAgent({ id, description, systemPrompt, tools = [], send, modelId, maxTokens = 2200 }) {
  const model = new BedrockModel({ modelId, maxTokens, temperature: 0, stream: false });
  model._client.send = async command => {
    const response = await send(command);
    if (!["end_turn", "tool_use"].includes(response?.stopReason)) {
      throw new Error(`Incomplete model response (${response?.stopReason ?? "unknown"})`);
    }
    return {
      ...response,
      output: {
        ...response.output,
        message: { role: "assistant", ...response.output?.message },
      },
      usage: response.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  };
  return new Agent({
    id,
    name: id,
    description,
    model,
    systemPrompt,
    tools,
    printer: false,
    retryStrategy: null,
  });
}

export function createQuestionGenerator({
  send = command => defaultClient.send(command),
  modelId = process.env.VOICE_MODEL_ID ?? "us.amazon.nova-2-lite-v1:0",
  webSearchTool = createNovaWebSearchTool({ send, modelId }),
  docTools = null,
  mcpLoader = loadAwsKnowledgeMcpTools,
  validateQuestion,
  gradeAnswer,
  grader = createGraderAgent({ send, modelId }),
  maxAttempts = 3,
} = {}) {
  if (typeof validateQuestion !== "function" || typeof gradeAnswer !== "function") {
    throw new Error("validateQuestion and gradeAnswer functions are required");
  }

  const buildGraph = activeDocTools => {
    const interviewMiner = createStrandsNodeAgent({
      id: "interview_miner",
      description: "Mines the most common real-world AWS interview questions using Amazon Nova web grounding.",
      modelId,
      send,
      tools: webSearchTool ? [webSearchTool] : [],
      systemPrompt: `You are Agent 1 (InterviewQuestionMinerAgent) in a Strands Multi-Agent AWS Question Bank pipeline.
Your job is to find the most common, practical cloud engineering interview question for the requested AWS service (or audit an existing question if supplied).
1. Always call the nova_web_search tool first to search for the most frequently asked interview questions and typical candidate answers for the target AWS service.
2. Focus on practical, foundational scenario-based interview questions that a student can answer orally in 20-45 seconds (explaining WHY and HOW, not memorizing obscure quotas).
3. Identify any parts of the popular interview question or traditional candidate answer that might be outdated due to AWS updates.
4. Return ONLY valid JSON:
{
  "serviceId": "...",
  "candidateId": "short-kebab-case-id",
  "interviewTopic": "...",
  "commonQuestion": "...",
  "typicalCommunityAnswer": "...",
  "suspectedOutdatedClaims": ["..."],
  "webCitations": ["..."]
}`,
    });

    const awsDocsFactChecker = createStrandsNodeAgent({
      id: "aws_docs_fact_checker",
      description: "Audits interview questions and answers against official AWS documentation via AWS Knowledge MCP.",
      modelId,
      send,
      tools: activeDocTools,
      systemPrompt: `You are Agent 2 (AwsDocsFactCheckerAgent) in a Strands Multi-Agent AWS Question Bank pipeline.
You receive the mined interview question from [node: interview_miner].
Your job is to verify BOTH the question premise and the answer against official AWS documentation using your documentation search tools (such as aws___search_documentation).
1. Call aws___search_documentation to verify current AWS behavior, security defaults, and best practices for this service and topic.
2. If the mined interview question premise or traditional answer is outdated, rewrite the question and rubric so they are 100% accurate according to current official AWS documentation.
3. Place any outdated community belief or common mistake into misconceptions[] (1-3 concise strings).
4. Design 2 or 3 atomic grading concepts in concepts[] whose integer weights MUST sum strictly to 100 (e.g. 60 + 40, or 50 + 50, or 40 + 35 + 25).
5. Each concept description must describe a clear architectural idea in plain English that a student can express in their own spoken words.
6. Never mention voice, pronunciation, accent, or speaking tone anywhere.
7. Return ONLY valid JSON:
{
  "id": "kebab-case-question-id",
  "serviceId": "...",
  "title": "Concise 3-6 word title",
  "enPrompt": "Practical 1-2 sentence scenario interview question in English...",
  "concepts": [
    { "id": "concept-one", "description": "...", "weight": 60 },
    { "id": "concept-two", "description": "...", "weight": 40 }
  ],
  "misconceptions": ["..."],
  "acceptableAnswers": ["..."],
  "referenceAnswer": "Concise 1-2 sentence reference answer grounded in official AWS docs.",
  "awsDocCitations": ["https://docs.aws.amazon.com/..."]
}`,
    });

    const trilingualLocalizer = createStrandsNodeAgent({
      id: "trilingual_localizer",
      description: "Localizes AWS-verified interview questions into English (en-US), Hong Kong Cantonese (zh-HK), and Simplified Chinese Mandarin (zh-CN).",
      modelId,
      send,
      tools: [],
      systemPrompt: `You are Agent 3 (TrilingualLocalizationAgent) in a Strands Multi-Agent AWS Question Bank pipeline.
You receive the AWS-documentation-verified question and rubric from [node: aws_docs_fact_checker].
Your job is to produce the complete trilingual question object with prompts in "en-US", "zh-HK", and "zh-CN".
Rules:
1. "en-US": Keep the clear, conversational English scenario interview prompt.
2. "zh-HK": Translate into authentic spoken Hong Kong Cantonese (using natural HK Cantonese phrasing such as 你嘅、點解、點樣、入面、邊啲) while keeping official English AWS service/feature terms (e.g., Amazon S3, IAM role, Security Group) where HK cloud engineers naturally code-switch.
3. "zh-CN": Translate into natural Simplified Chinese Mandarin. NEVER use Cantonese characters (嘅, 喺, 唔, 畀, 佢, 哋, 乜, 啲, 揀, 嚟) in "zh-CN".
4. Preserve id, serviceId, version, status, expectedRevision, title, concepts, misconceptions, acceptableAnswers, and referenceAnswer exactly as required by the schema.
5. Return ONLY valid JSON:
{
  "id": "...",
  "serviceId": "...",
  "version": 1,
  "status": "approved",
  "expectedRevision": null,
  "title": "...",
  "prompts": {
    "en-US": "...",
    "zh-HK": "...",
    "zh-CN": "..."
  },
  "concepts": [
    { "id": "...", "description": "...", "weight": 60 },
    { "id": "...", "description": "...", "weight": 40 }
  ],
  "misconceptions": ["..."],
  "acceptableAnswers": ["..."],
  "referenceAnswer": "..."
}`,
    });

    const calibrationCritic = createStrandsNodeAgent({
      id: "calibration_critic",
      description: "Generates synthetic spoken student transcripts (Good English, Good HK Cantonese code-switched, and Outdated/Misconception) to calibrate the rubric.",
      modelId,
      send,
      tools: [],
      systemPrompt: `You are Agent 4 (CalibrationCriticAgent) in a Strands Multi-Agent AWS Question Bank pipeline.
You receive the localized trilingual question from [node: trilingual_localizer].
Your job is to output the final question object AND three realistic spoken student transcripts to test-grade the rubric:
1. "goodEn": A natural 1-2 sentence spoken English answer that clearly states every concept in question.concepts[].
2. "goodZhHk": A natural 1-2 sentence spoken Hong Kong Cantonese + English code-switched answer that clearly states every concept in question.concepts[].
3. "wrongOutdated": A plausible 1-2 sentence spoken English answer that states the misconception in question.misconceptions[0] and misses the required concepts.
4. Never mention pronunciation, voice quality, or accent in any field.
Return ONLY valid JSON:
{
  "question": { ...the complete question object from trilingual_localizer... },
  "syntheticTranscripts": {
    "goodEn": "...",
    "goodZhHk": "...",
    "wrongOutdated": "..."
  }
}`,
    });

    return new Graph({
      id: "aws-interview-question-pipeline",
      nodes: [interviewMiner, awsDocsFactChecker, trilingualLocalizer, calibrationCritic],
      edges: [
        ["interview_miner", "aws_docs_fact_checker"],
        ["aws_docs_fact_checker", "trilingual_localizer"],
        ["trilingual_localizer", "calibration_critic"],
      ],
      maxConcurrency: 1,
      maxSteps: 8,
    });
  };

  const verifyAndCalibrate = async (candidate, targetMeta) => {
    const rawQuestion = {
      ...candidate?.question,
      serviceId: targetMeta.serviceId,
      version: targetMeta.version,
      status: targetMeta.status,
      expectedRevision: targetMeta.expectedRevision,
      ...(targetMeta.lockedId ? { id: targetMeta.lockedId } : {}),
    };
    const question = validateQuestion(rawQuestion);
    if (cantoneseOnlyChars.test(question.prompts["zh-CN"] ?? "")) {
      throw new Error("Mandarin prompt (zh-CN) contains Cantonese-only characters");
    }
    const allTexts = [
      question.title,
      question.referenceAnswer,
      ...Object.values(question.prompts),
      ...question.concepts.map(c => c.description),
      ...question.misconceptions,
      ...question.acceptableAnswers,
    ];
    if (allTexts.some(item => forbiddenVoiceClaim.test(item))) {
      throw new Error("Question rubric must never mention voice or pronunciation");
    }

    const transcripts = candidate?.syntheticTranscripts ?? {};
    if (typeof transcripts.goodEn !== "string" || !transcripts.goodEn.trim() ||
        typeof transcripts.goodZhHk !== "string" || !transcripts.goodZhHk.trim() ||
        typeof transcripts.wrongOutdated !== "string" || !transcripts.wrongOutdated.trim()) {
      throw new Error("CalibrationCriticAgent must supply goodEn, goodZhHk, and wrongOutdated synthetic transcripts");
    }

    const rubricFor = language => ({
      id: question.id,
      prompt: question.prompts[language],
      concepts: question.concepts,
      misconceptions: question.misconceptions,
      acceptableAnswers: question.acceptableAnswers,
      referenceAnswer: question.referenceAnswer,
    });

    const enRaw = await grader({
      operation: "grade_answer",
      language: "en-US",
      feedbackLanguage: "English",
      question: rubricFor("en-US"),
      transcript: transcripts.goodEn,
    });
    const enGrade = gradeAnswer(enRaw, question, transcripts.goodEn);
    if (!enGrade.passed || enGrade.score < 80) {
      throw new Error(`Synthetic goodEn failed calibration (score=${enGrade.score}, expected >=80)`);
    }

    const hkRaw = await grader({
      operation: "grade_answer",
      language: "zh-HK",
      feedbackLanguage: "Traditional Chinese (Cantonese)",
      question: rubricFor("zh-HK"),
      transcript: transcripts.goodZhHk,
    });
    const hkGrade = gradeAnswer(hkRaw, question, transcripts.goodZhHk);
    if (!hkGrade.passed || hkGrade.score < 80) {
      throw new Error(`Synthetic goodZhHk failed calibration (score=${hkGrade.score}, expected >=80)`);
    }

    const wrongRaw = await grader({
      operation: "grade_answer",
      language: "en-US",
      feedbackLanguage: "English",
      question: rubricFor("en-US"),
      transcript: transcripts.wrongOutdated,
    });
    const wrongGrade = gradeAnswer(wrongRaw, question, transcripts.wrongOutdated);
    if (wrongGrade.passed || wrongGrade.score >= 60) {
      throw new Error(`Synthetic wrongOutdated passed unexpectedly (score=${wrongGrade.score}, expected <60)`);
    }

    return {
      question: {
        ...question,
        expectedRevision: targetMeta.expectedRevision,
      },
      calibration: {
        goodEnScore: enGrade.score,
        goodZhHkScore: hkGrade.score,
        wrongOutdatedScore: wrongGrade.score,
      },
    };
  };

  const generateOrRefreshQuestion = async ({
    serviceId,
    label,
    passage,
    existingQuestion = null,
    avoidIds = [],
    slotIndex = 1,
    status = "approved",
  }) => {
    let mcpSession = null;
    const activeDocTools = docTools ?? (await (async () => {
      mcpSession = await mcpLoader();
      return mcpSession.tools;
    })());

    try {
      const targetMeta = {
        serviceId,
        status,
        version: existingQuestion ? existingQuestion.version + 1 : 1,
        expectedRevision: existingQuestion ? (existingQuestion.expectedRevision ?? 0) : null,
        lockedId: existingQuestion?.id ?? null,
      };

      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const graph = buildGraph(activeDocTools);
        const taskPrompt = JSON.stringify({
          mode: existingQuestion ? "refresh_existing_question" : "generate_new_question",
          serviceId,
          serviceLabel: label,
          baselineServicePassage: passage,
          slotIndex,
          avoidQuestionIds: avoidIds,
          targetVersion: targetMeta.version,
          targetStatus: targetMeta.status,
          targetExpectedRevision: targetMeta.expectedRevision,
          ...(existingQuestion ? { existingQuestion } : {}),
          ...(lastError ? { previousAttemptCritique: lastError.message } : {}),
        });

        try {
          const graphResult = await graph.invoke(taskPrompt);
          if (graphResult.status !== "COMPLETED") {
            throw new Error(`Strands Graph ended with status ${graphResult.status}`);
          }
          const finalText = graphResult.content
            .map(block => (typeof block?.text === "string" ? block.text : ""))
            .join("\n")
            .trim();
          const parsed = parseJsonFromText(finalText);
          return await verifyAndCalibrate(parsed, targetMeta);
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(`Failed to generate & calibrate question for ${serviceId} after ${maxAttempts} attempts: ${lastError?.message}`);
    } finally {
      if (mcpSession) await mcpSession.disconnect().catch(() => {});
    }
  };

  return {
    generateOrRefreshQuestion,
  };
}
