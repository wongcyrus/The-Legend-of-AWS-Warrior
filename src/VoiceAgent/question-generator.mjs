import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { Agent, BedrockModel, Graph, McpClient, TextBlock, tool } from "@strands-agents/sdk";
import { BeforeMultiAgentInvocationEvent, BeforeNodeCallEvent, Status } from "@strands-agents/sdk/multiagent";
import { createAgent as createGraderAgent } from "./agent.mjs";

let telemetryInitialized = false;

export async function enableStrandsTelemetry({
  otlp = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.LANGFUSE_BASE_URL),
  console: consoleExporter = process.env.STRANDS_TRACE_CONSOLE === "1",
} = {}) {
  if (telemetryInitialized) return true;
  if (!otlp && !consoleExporter) return false;
  const telemetry = await import("@strands-agents/sdk/telemetry");
  telemetry.setupTracer({ exporters: { otlp, console: consoleExporter } });
  telemetry.setupMeter({ exporters: { otlp, console: consoleExporter } });
  telemetryInitialized = true;
  return true;
}

export function extractGraphTopology(graph, { steps = [], handoffs = [] } = {}) {
  const visitCounts = new Map();
  const durationByNode = new Map();
  const toolsByNode = new Map();
  for (const step of steps) {
    visitCounts.set(step.nodeId, (visitCounts.get(step.nodeId) ?? 0) + 1);
    durationByNode.set(step.nodeId, (durationByNode.get(step.nodeId) ?? 0) + (step.duration ?? 0));
    if (!toolsByNode.has(step.nodeId)) toolsByNode.set(step.nodeId, new Set());
    for (const tc of step.toolCalls ?? []) {
      if (tc?.name) toolsByNode.get(step.nodeId).add(tc.name);
    }
  }
  const handoffCounts = new Map();
  for (const h of handoffs) {
    for (const target of h.targets ?? []) {
      const key = `${h.source}->${target}`;
      handoffCounts.set(key, (handoffCounts.get(key) ?? 0) + 1);
    }
  }

  const nodes = [...graph.nodes.values()].map(node => ({
    id: node.id,
    type: node.type,
    description: node.config?.description ?? "",
    preserveContext: Boolean(node.preserveContext),
    visits: visitCounts.get(node.id) ?? 0,
    totalDurationMs: durationByNode.get(node.id) ?? 0,
    toolsUsed: [...(toolsByNode.get(node.id) ?? [])],
  }));

  const edges = graph.edges.map(edge => {
    const key = `${edge.source}->${edge.target}`;
    const stageByTarget = {
      trilingual_localizer: "localization",
      aws_docs_fact_checker: "rubric",
      interview_miner: "topic",
    };
    const loopStage = edge.source === "calibration_critic" ? stageByTarget[edge.target] ?? null : null;
    return {
      source: edge.source,
      target: edge.target,
      conditional: typeof edge.handler === "function",
      loopStage,
      traversals: handoffCounts.get(key) ?? 0,
    };
  });

  const mermaidLines = ["flowchart LR"];
  for (const node of nodes) {
    const stats = node.visits > 0 ? `<br/>(${node.visits}x · ${node.totalDurationMs}ms)` : "";
    const tools = node.toolsUsed.length > 0 ? `<br/>🔧 ${node.toolsUsed.join(", ")}` : "";
    mermaidLines.push(`  ${node.id}["<b>${node.id}</b>${stats}${tools}"]`);
  }
  for (const edge of edges) {
    const countLabel = edge.traversals > 0 ? ` (${edge.traversals}x)` : "";
    if (edge.conditional) {
      const stageLabel = edge.loopStage ? `: ${edge.loopStage}` : "";
      mermaidLines.push(`  ${edge.source} -. "conditional loop${stageLabel}${countLabel}" .-> ${edge.target}`);
    } else {
      mermaidLines.push(`  ${edge.source} -->|"handoff${countLabel}"| ${edge.target}`);
    }
  }

  return {
    graphId: graph.id,
    nodes,
    edges,
    mermaid: mermaidLines.join("\n"),
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderStrandsTraceReportHtml(traces = [], { title = "AWS Strands Multi-Agent Graph & Runtime Trace Report" } = {}) {
  const traceList = Array.isArray(traces) ? traces : [traces];
  const cardsHtml = traceList.map((trace, idx) => {
    const totalDuration = Math.max(1, trace.duration ?? 1);
    const baseStart = trace.steps?.[0]?.startTime ?? 0;
    const stepsRows = (trace.steps ?? []).map(step => {
      const offsetPct = baseStart > 0 && step.startTime >= baseStart
        ? Math.min(95, Math.max(0, ((step.startTime - baseStart) / totalDuration) * 100))
        : 0;
      const widthPct = Math.max(4, Math.min(100 - offsetPct, ((step.duration ?? 0) / totalDuration) * 100));
      const toolBadges = (step.toolCalls ?? [])
        .map(tc => `<span class="badge tool">🔧 ${escapeHtml(tc.name)} (${escapeHtml(tc.status)})</span>`)
        .join(" ");
      const innerCycles = (step.agentTraces ?? [])
        .map(at => {
          const children = (at.children ?? []).map(c => `${escapeHtml(c.name)} (${c.duration ?? 0}ms)`).join(" → ");
          return `<div class="inner-trace">↻ <b>${escapeHtml(at.name)}</b> (${at.duration ?? 0}ms)${children ? `: ${children}` : ""}</div>`;
        })
        .join("");
      return `
        <tr>
          <td>#${step.stepIndex}</td>
          <td><code>${escapeHtml(step.nodeId)}</code></td>
          <td><span class="badge status-${escapeHtml(String(step.status).toLowerCase())}">${escapeHtml(step.status)}</span></td>
          <td>${step.duration ?? 0} ms</td>
          <td>${step.usage?.totalTokens ?? 0} (${step.usage?.inputTokens ?? 0} in / ${step.usage?.outputTokens ?? 0} out)</td>
          <td>
            <div class="waterfall-track">
              <div class="waterfall-bar" style="left:${offsetPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%"></div>
            </div>
            ${toolBadges ? `<div class="tools-row">${toolBadges}</div>` : ""}
            ${innerCycles}
          </td>
        </tr>`;
    }).join("");

    const handoffBadges = (trace.handoffs ?? [])
      .map(h => `<span class="badge ${h.isLoopBack ? "loopback" : "handoff"}">${escapeHtml(h.source)} ──► ${escapeHtml((h.targets ?? []).join(", "))}${h.isLoopBack ? " (Cyclic Retry)" : ""}</span>`)
      .join(" ");

    return `
      <section class="card">
        <div class="card-header">
          <div>
            <h2>Run #${idx + 1}: <code>${escapeHtml(trace.serviceId)}</code> · Question <code>${escapeHtml(trace.questionId ?? "pending")}</code></h2>
            <p class="meta">Graph ID: <code>${escapeHtml(trace.graphId)}</code> · Mode: <b>${escapeHtml(trace.mode)}</b> · Slot: <b>#${escapeHtml(trace.slotIndex)}</b> · Status: <b>${escapeHtml(trace.status)}</b> · Duration: <b>${trace.duration ?? 0} ms</b> · Total Tokens: <b>${trace.usage?.totalTokens ?? 0}</b></p>
          </div>
          ${trace.calibration ? `<div class="calibration">goodEn: <b>${trace.calibration.goodEnScore}%</b> · goodZhHk: <b>${trace.calibration.goodZhHkScore}%</b> · wrongOutdated: <b>${trace.calibration.wrongOutdatedScore}%</b></div>` : ""}
        </div>
        <div class="mermaid">${escapeHtml(trace.topology?.mermaid ?? "flowchart LR\n  interview_miner --> aws_docs_fact_checker --> trilingual_localizer --> calibration_critic")}</div>
        ${handoffBadges ? `<div class="handoffs"><strong>Edge Handoffs:</strong> ${handoffBadges}</div>` : ""}
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Strands Node</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Tokens</th>
              <th>Runtime Waterfall &amp; Inner Agent Loop Traces</th>
            </tr>
          </thead>
          <tbody>${stepsRows}</tbody>
        </table>
      </section>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: true, theme: "dark" });
  </script>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 24px; }
    h1 { color: #ff9900; margin-top: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 20px; margin-bottom: 24px; }
    .card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    .meta { color: #8b949e; font-size: 14px; margin: 4px 0 12px; }
    .calibration { background: #1f2937; border: 1px solid #374151; padding: 8px 12px; border-radius: 6px; font-size: 13px; }
    .mermaid { background: #0d1117; border: 1px solid #21262d; border-radius: 8px; padding: 16px; margin: 12px 0; overflow-x: auto; }
    .handoffs { margin: 12px 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    th, td { border-top: 1px solid #21262d; padding: 10px 8px; text-align: left; vertical-align: top; }
    th { color: #8b949e; font-weight: 600; }
    .waterfall-track { position: relative; height: 10px; background: #21262d; border-radius: 5px; overflow: hidden; margin-bottom: 6px; }
    .waterfall-bar { position: absolute; top: 0; bottom: 0; background: linear-gradient(90deg, #ff9900, #38bdf8); border-radius: 5px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .badge.tool { background: #1e3a5f; color: #7dd3fc; }
    .badge.handoff { background: #1f2937; color: #d1d5db; border: 1px solid #374151; }
    .badge.loopback { background: #451a03; color: #fdba74; border: 1px solid #f97316; }
    .badge.status-completed { background: #064e3b; color: #6ee7b7; }
    .inner-trace { color: #9ca3af; font-size: 12px; margin-top: 4px; }
    code { color: #79c0ff; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${cardsHtml}
</body>
</html>`;
}

const defaultClient = new BedrockRuntimeClient({ maxAttempts: 3, retryMode: "adaptive" });
const cantoneseOnlyChars = /[嘅喺唔畀佢哋乜啲揀嚟]/u;
const forbiddenVoiceClaim = /\b(?:pronunciat\w*|mispronounc\w*|your\s+voice|voice\s+(?:is|was|quality|tone|clarity|inaccurate|accurate)|accent|intonation|enunciat\w*)\b|發音|讀音|咬字|聲線|語調|口音|发音|读音/iu;
const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "by", "can", "could", "do", "does",
  "for", "from", "game", "give", "how", "if", "in", "into", "is", "it", "its", "need", "needs",
  "not", "of", "on", "one", "only", "or", "other", "our", "out", "over", "player", "players",
  "should", "so", "some", "such", "than", "that", "the", "their", "them", "then", "there",
  "these", "they", "this", "to", "up", "use", "used", "using", "want", "what", "when", "where",
  "which", "while", "who", "why", "will", "with", "would", "you", "your", "amazon", "aws",
  "service", "services", "application", "applications", "system", "example", "explain",
]);

export function summarizeExistingQuestion(question) {
  if (!question || typeof question !== "object") return null;
  const id = String(question.id ?? "").trim();
  if (!id) return null;
  const title = String(question.title ?? "").trim();
  const enPrompt = String(question.prompts?.["en-US"] ?? question.enPrompt ?? "").trim();
  const concepts = Array.isArray(question.concepts)
    ? question.concepts.map(c => (typeof c === "string" ? c : `${c?.id ?? ""}: ${c?.description ?? ""}`.trim())).filter(Boolean)
    : [];
  return { id, title, enPrompt, concepts };
}

function tokenizeTopicText(text, serviceId = "") {
  const serviceParts = new Set(String(serviceId).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const tokens = String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2 && !stopWords.has(token) && !serviceParts.has(token));
  return new Set(tokens);
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

export function findDuplicateOrOverlappingQuestion(question, avoidQuestions = [], avoidIds = []) {
  const blockedIds = new Set(avoidIds.map(id => String(id).trim()).filter(Boolean));
  if (blockedIds.has(question.id)) {
    return { reason: "duplicate_id", matchId: question.id };
  }
  const normalizedTitle = String(question.title ?? "").normalize("NFKC").trim().toLowerCase();
  const normalizedPrompt = String(question.prompts?.["en-US"] ?? "").normalize("NFKC").trim().toLowerCase();
  const candidatePromptTokens = tokenizeTopicText(`${question.title ?? ""} ${question.prompts?.["en-US"] ?? ""}`, question.serviceId);
  const candidateConceptTokens = tokenizeTopicText(
    (question.concepts ?? []).map(c => `${c.id} ${c.description}`).join(" "),
    question.serviceId
  );

  for (const rawExisting of avoidQuestions) {
    const existing = summarizeExistingQuestion(rawExisting);
    if (!existing) continue;
    if (existing.id === question.id) {
      return { reason: "duplicate_id", matchId: existing.id, matchTitle: existing.title };
    }
    const existingTitle = existing.title.normalize("NFKC").trim().toLowerCase();
    const existingPrompt = existing.enPrompt.normalize("NFKC").trim().toLowerCase();
    if (normalizedTitle && existingTitle && normalizedTitle === existingTitle) {
      return { reason: "duplicate_title", matchId: existing.id, matchTitle: existing.title };
    }
    if (normalizedPrompt && existingPrompt && normalizedPrompt === existingPrompt) {
      return { reason: "duplicate_prompt", matchId: existing.id, matchTitle: existing.title };
    }
    const existingPromptTokens = tokenizeTopicText(`${existing.title} ${existing.enPrompt}`, question.serviceId);
    const promptSim = jaccardSimilarity(candidatePromptTokens, existingPromptTokens);
    if (promptSim >= 0.55) {
      return { reason: "overlapping_prompt", similarity: promptSim, matchId: existing.id, matchTitle: existing.title };
    }
    const existingConceptTokens = tokenizeTopicText(existing.concepts.join(" "), question.serviceId);
    const conceptSim = jaccardSimilarity(candidateConceptTokens, existingConceptTokens);
    if (conceptSim >= 0.6) {
      return { reason: "overlapping_concepts", similarity: conceptSim, matchId: existing.id, matchTitle: existing.title };
    }
  }
  return null;
}

export function classifyFailureStage(errorOrMessage) {
  if (errorOrMessage && typeof errorOrMessage === "object" && typeof errorOrMessage.failureStage === "string") {
    return errorOrMessage.failureStage;
  }
  const msg = String(errorOrMessage?.message ?? errorOrMessage ?? "");
  if (
    /already used|overlaps too closely|duplicate_id|duplicate_title|duplicate_prompt|overlapping_prompt|overlapping_concepts|Question id is required|Question serviceId is required/i.test(msg)
  ) {
    return "topic";
  }
  if (
    /Mandarin prompt \(zh-CN\) contains Cantonese-only characters|Synthetic goodZhHk failed calibration|Question prompt for zh-HK is required|Question prompt for zh-CN is required/i.test(msg)
  ) {
    return "localization";
  }
  return "rubric";
}

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

function createStrandsNodeAgent({ id, description, systemPrompt, tools = [], send, modelId, maxTokens = 2200, traceAttributes }) {
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
    ...(traceAttributes ? { traceAttributes } : {}),
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
  otel = false,
  traceConsole = false,
  onTraceEvent = null,
} = {}) {
  if (typeof validateQuestion !== "function" || typeof gradeAnswer !== "function") {
    throw new Error("validateQuestion and gradeAnswer functions are required");
  }
  if (otel || traceConsole || process.env.STRANDS_OTEL_ENABLED === "1" || process.env.STRANDS_TRACE_CONSOLE === "1") {
    enableStrandsTelemetry({ otlp: Boolean(otel || process.env.STRANDS_OTEL_ENABLED === "1"), console: Boolean(traceConsole || process.env.STRANDS_TRACE_CONSOLE === "1") });
  }

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
    if (!targetMeta.lockedId) {
      const overlap = findDuplicateOrOverlappingQuestion(question, targetMeta.avoidQuestions, targetMeta.avoidIds);
      if (overlap) {
        if (overlap.reason === "duplicate_id") {
          throw new Error(`Question id "${question.id}" is already used; choose a different id and interview topic not in [${targetMeta.avoidIds.join(", ")}]`);
        }
        throw new Error(
          `Question topic overlaps too closely (${overlap.reason}) with existing question "${overlap.matchId}" ("${overlap.matchTitle ?? ""}"); choose a completely different AWS feature or architectural scenario`
        );
      }
    }
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

    const [enRaw, hkRaw, wrongRaw] = await Promise.all([
      grader({
        operation: "grade_answer",
        language: "en-US",
        feedbackLanguage: "English",
        question: rubricFor("en-US"),
        transcript: transcripts.goodEn,
      }),
      grader({
        operation: "grade_answer",
        language: "zh-HK",
        feedbackLanguage: "Traditional Chinese (Cantonese)",
        question: rubricFor("zh-HK"),
        transcript: transcripts.goodZhHk,
      }),
      grader({
        operation: "grade_answer",
        language: "en-US",
        feedbackLanguage: "English",
        question: rubricFor("en-US"),
        transcript: transcripts.wrongOutdated,
      }),
    ]);

    const enGrade = gradeAnswer(enRaw, question, transcripts.goodEn);
    if (!enGrade.passed || enGrade.score < 80) {
      throw new Error(`Synthetic goodEn failed calibration (score=${enGrade.score}, expected >=80)`);
    }

    const hkGrade = gradeAnswer(hkRaw, question, transcripts.goodZhHk);
    if (!hkGrade.passed || hkGrade.score < 80) {
      throw new Error(`Synthetic goodZhHk failed calibration (score=${hkGrade.score}, expected >=80)`);
    }

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

  const calibrationTool = tool({
    name: "verify_and_calibrate_question",
    description: "Run deterministic schema validation, semantic duplicate detection, and 3-way synthetic student grading (goodEn, goodZhHk, wrongOutdated) on the candidate question and rubric.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "object", description: "Complete localized trilingual question object." },
        syntheticTranscripts: {
          type: "object",
          properties: {
            goodEn: { type: "string" },
            goodZhHk: { type: "string" },
            wrongOutdated: { type: "string" },
          },
          required: ["goodEn", "goodZhHk", "wrongOutdated"],
        },
      },
      required: ["question", "syntheticTranscripts"],
    },
    callback: async (input, toolContext) => {
      const state = toolContext?.invocationState ?? {};
      if (!state.targetMeta) throw new Error("Missing targetMeta in invocationState");
      try {
        const verified = await verifyAndCalibrate(input, state.targetMeta);
        state.calibratedResult = verified;
        state.lastCritique = null;
        state.lastFailureStage = null;
        return {
          passed: true,
          questionId: verified.question.id,
          calibration: verified.calibration,
        };
      } catch (error) {
        state.calibratedResult = null;
        state.lastCritique = error.message;
        state.lastFailureStage = classifyFailureStage(error);
        return {
          passed: false,
          failureStage: state.lastFailureStage,
          critique: error.message,
        };
      }
    },
  });

  const buildGraph = (activeDocTools, invocationState, traceAttributes) => {
    const interviewMiner = createStrandsNodeAgent({
      id: "interview_miner",
      description: "Mines the most common real-world AWS interview questions using Amazon Nova web grounding.",
      modelId,
      send,
      tools: webSearchTool ? [webSearchTool] : [],
      traceAttributes,
      systemPrompt: `You are Agent 1 (InterviewQuestionMinerAgent) in a Strands Multi-Agent AWS Question Bank pipeline.
Your job is to find the most common, practical cloud engineering interview question for the requested AWS service (or audit an existing question if supplied).
1. Always call the nova_web_search tool first to search for the most frequently asked interview questions and typical candidate answers for the target AWS service.
2. If avoidQuestions or avoidQuestionIds is non-empty, or if [node: calibration_critic] reported a previousAttemptCritique, you MUST pick a COMPLETELY DIFFERENT interview question topic, architectural scenario, and AWS capability/feature that does NOT overlap in prompt or grading concepts with any entry in avoidQuestions, and choose a unique candidateId not in avoidQuestionIds.
3. Focus on practical, foundational scenario-based interview questions that a student can answer orally in 20-45 seconds (explaining WHY and HOW, not memorizing obscure quotas).
4. Identify any parts of the popular interview question or traditional candidate answer that might be outdated due to AWS updates.
5. Return ONLY valid JSON:
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
      traceAttributes,
      systemPrompt: `You are Agent 2 (AwsDocsFactCheckerAgent) in a Strands Multi-Agent AWS Question Bank pipeline.
You receive the mined interview question from [node: interview_miner] (and, if a rubric calibration retry occurred, a targeted previousAttemptCritique from [node: calibration_critic]).
Your job is to verify BOTH the question premise and the answer against official AWS documentation using your documentation search tools (such as aws___search_documentation).
1. Call aws___search_documentation to verify current AWS behavior, security defaults, and best practices for this service and topic.
2. If [node: calibration_critic] reported a rubric or grading calibration critique, fix the concepts[], weights, misconceptions[], or prompt clarity to resolve that exact critique.
3. If the mined interview question premise or traditional answer is outdated, rewrite the question and rubric so they are 100% accurate according to current official AWS documentation.
4. Ensure the id, title, enPrompt, and concepts[] do NOT duplicate or overlap with any existing question listed in avoidQuestions or avoidQuestionIds.
5. Place any outdated community belief or common mistake into misconceptions[] (1-3 concise strings).
6. Design 2 or 3 atomic grading concepts in concepts[] whose integer weights MUST sum strictly to 100 (e.g. 60 + 40, or 50 + 50, or 40 + 35 + 25).
7. Each concept description must describe a clear architectural idea in plain English that a student can express in their own spoken words.
8. Never mention voice, pronunciation, accent, or speaking tone anywhere.
9. Return ONLY valid JSON:
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
      traceAttributes,
      systemPrompt: `You are Agent 3 (TrilingualLocalizationAgent) in a Strands Multi-Agent AWS Question Bank pipeline.
You receive the AWS-documentation-verified question and rubric from [node: aws_docs_fact_checker] (and, if a localization retry occurred, a targeted previousAttemptCritique from [node: calibration_critic]).
Your job is to produce the complete trilingual question object with prompts in "en-US", "zh-HK", and "zh-CN".
Rules:
1. If [node: calibration_critic] reported a localization critique (such as Cantonese characters in "zh-CN" or a mismatch in "zh-HK"), fix the localized prompts while keeping the verified rubric intact.
2. "en-US": Keep the clear, conversational English scenario interview prompt.
3. "zh-HK": Translate into authentic spoken Hong Kong Cantonese (using natural HK Cantonese phrasing such as 你嘅、點解、點樣、入面、邊啲) while keeping official English AWS service/feature terms (e.g., Amazon S3, IAM role, Security Group) where HK cloud engineers naturally code-switch.
4. "zh-CN": Translate into natural Simplified Chinese Mandarin. NEVER use Cantonese characters (嘅, 喺, 唔, 畀, 佢, 哋, 乜, 啲, 揀, 嚟) in "zh-CN".
5. Preserve id, serviceId, version, status, expectedRevision, title, concepts, misconceptions, acceptableAnswers, and referenceAnswer exactly as required by the schema.
6. Return ONLY valid JSON:
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
      description: "Generates synthetic spoken student transcripts (Good English, Good HK Cantonese code-switched, and Outdated/Misconception) and invokes verify_and_calibrate_question to calibrate the rubric.",
      modelId,
      send,
      tools: [calibrationTool],
      traceAttributes,
      systemPrompt: `You are Agent 4 (CalibrationCriticAgent) in a Strands Multi-Agent AWS Question Bank pipeline.
You receive the localized trilingual question from [node: trilingual_localizer].
Your job is to construct three realistic spoken student transcripts to test-grade the rubric, call the verify_and_calibrate_question tool to verify schema + live grading, and output the final JSON:
1. "goodEn": A natural 1-2 sentence spoken English answer that clearly states every concept in question.concepts[].
2. "goodZhHk": A natural 1-2 sentence spoken Hong Kong Cantonese + English code-switched answer that clearly states every concept in question.concepts[].
3. "wrongOutdated": A plausible 1-2 sentence spoken English answer that states the misconception in question.misconceptions[0] and misses the required concepts.
4. Call verify_and_calibrate_question with { question, syntheticTranscripts } to validate the rubric. If verify_and_calibrate_question reports a transcript issue, refine syntheticTranscripts and re-verify; if the question or rubric itself is flawed, output the JSON so the Strands Graph conditional loop routes the critique back to [node: interview_miner].
5. Never mention pronunciation, voice quality, or accent in any field.
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

    const evaluateCriticOutcome = async state => {
      const criticResults = state.node("calibration_critic")?.results ?? [];
      const turnNumber = criticResults.length;
      if (invocationState.evaluatedCriticTurn === turnNumber) {
        return;
      }
      invocationState.evaluatedCriticTurn = turnNumber;
      if (!invocationState.calibratedResult) {
        const criticNode = state.node("calibration_critic");
        const finalText = (criticNode?.content ?? [])
          .map(block => (typeof block?.text === "string" ? block.text : ""))
          .join("\n")
          .trim();
        try {
          const parsed = parseJsonFromText(finalText);
          invocationState.calibratedResult = await verifyAndCalibrate(parsed, invocationState.targetMeta);
          invocationState.lastCritique = null;
          invocationState.lastFailureStage = null;
        } catch (error) {
          invocationState.lastCritique = error.message;
          invocationState.lastFailureStage = classifyFailureStage(error);
        }
      }
      if (invocationState.calibratedResult) {
        invocationState.shouldRetry = false;
        return;
      }
      invocationState.cycleCount = (invocationState.cycleCount ?? 0) + 1;
      invocationState.lastFailureStage = invocationState.lastFailureStage ?? classifyFailureStage(invocationState.lastCritique);
      invocationState.shouldRetry = invocationState.cycleCount < maxAttempts;
      const targetByStage = {
        localization: "trilingual_localizer",
        rubric: "aws_docs_fact_checker",
        topic: "interview_miner",
      };
      const critiqueMessage = JSON.stringify({
        previousAttemptCritique: invocationState.lastCritique,
        failureStage: invocationState.lastFailureStage,
        targetNode: targetByStage[invocationState.lastFailureStage] ?? "interview_miner",
        cycle: invocationState.cycleCount,
      });
      const lastCriticResult = criticResults[criticResults.length - 1];
      if (lastCriticResult && Array.isArray(lastCriticResult.content)) {
        lastCriticResult.content.push(new TextBlock(critiqueMessage));
      }
    };

    const graph = new Graph({
      id: "aws-interview-question-pipeline",
      sources: ["interview_miner"],
      ...(traceAttributes ? { traceAttributes } : {}),
      nodes: [
        { agent: interviewMiner, preserveContext: true },
        { agent: awsDocsFactChecker, preserveContext: true },
        { agent: trilingualLocalizer, preserveContext: true },
        { agent: calibrationCritic, preserveContext: true },
      ],
      edges: [
        ["interview_miner", "aws_docs_fact_checker"],
        ["aws_docs_fact_checker", "trilingual_localizer"],
        ["trilingual_localizer", "calibration_critic"],
        {
          source: "calibration_critic",
          target: "trilingual_localizer",
          handler: async state => {
            const lastNodeId = state.results.at(-1)?.nodeId;
            if (lastNodeId === "aws_docs_fact_checker") return true;
            if (lastNodeId !== "calibration_critic") return false;
            await evaluateCriticOutcome(state);
            return Boolean(invocationState.shouldRetry && invocationState.lastFailureStage === "localization");
          },
        },
        {
          source: "calibration_critic",
          target: "aws_docs_fact_checker",
          handler: async state => {
            const lastNodeId = state.results.at(-1)?.nodeId;
            if (lastNodeId === "interview_miner") return true;
            if (lastNodeId !== "calibration_critic") return false;
            await evaluateCriticOutcome(state);
            return Boolean(invocationState.shouldRetry && invocationState.lastFailureStage === "rubric");
          },
        },
        {
          source: "calibration_critic",
          target: "interview_miner",
          handler: async state => {
            const lastNodeId = state.results.at(-1)?.nodeId;
            if (lastNodeId !== "calibration_critic") return false;
            await evaluateCriticOutcome(state);
            return Boolean(invocationState.shouldRetry && invocationState.lastFailureStage === "topic");
          },
        },
      ],
      maxConcurrency: 1,
      maxSteps: Math.max(4, maxAttempts * 4),
    });

    graph.addHook(BeforeMultiAgentInvocationEvent, event => {
      const criticNodeState = event.state.node("calibration_critic");
      if (criticNodeState && criticNodeState.results.length === 0) {
        criticNodeState.status = Status.COMPLETED;
      }
    });

    graph.addHook(BeforeNodeCallEvent, event => {
      if (event.nodeId !== "calibration_critic") {
        const criticResults = event.state.node("calibration_critic")?.results ?? [];
        const lastCriticResult = criticResults[criticResults.length - 1];
        if (lastCriticResult && Array.isArray(lastCriticResult.content) && lastCriticResult.content.length > 0) {
          lastCriticResult.content = [];
        }
      }
    });

    return graph;
  };

  const generateOrRefreshQuestion = async ({
    serviceId,
    label,
    passage,
    existingQuestion = null,
    avoidIds = [],
    avoidQuestions = [],
    slotIndex = 1,
    status = "approved",
  }) => {
    let mcpSession = null;
    const activeDocTools = docTools ?? (await (async () => {
      mcpSession = await mcpLoader();
      return mcpSession.tools;
    })());

    try {
      const normalizedAvoidQuestions = avoidQuestions
        .map(summarizeExistingQuestion)
        .filter(q => q && q.id !== existingQuestion?.id);
      const mergedAvoidIds = [...new Set([
        ...avoidIds,
        ...normalizedAvoidQuestions.map(q => q.id),
      ])].filter(id => id && id !== existingQuestion?.id);

      const targetMeta = {
        serviceId,
        status,
        version: existingQuestion ? existingQuestion.version + 1 : 1,
        expectedRevision: existingQuestion ? (existingQuestion.expectedRevision ?? 0) : null,
        lockedId: existingQuestion?.id ?? null,
        avoidIds: mergedAvoidIds,
        avoidQuestions: normalizedAvoidQuestions,
      };

      const invocationState = {
        targetMeta,
        calibratedResult: null,
        lastCritique: null,
        lastFailureStage: null,
        evaluatedCriticTurn: 0,
        shouldRetry: false,
        cycleCount: 0,
      };

      const mode = existingQuestion ? "refresh_existing_question" : "generate_new_question";
      const traceAttributes = {
        "aws.service.id": String(serviceId),
        "strands.pipeline.mode": mode,
        "strands.slot.index": Number(slotIndex),
      };

      const graph = buildGraph(activeDocTools, invocationState, traceAttributes);
      const taskPrompt = JSON.stringify({
        mode,
        serviceId,
        serviceLabel: label,
        baselineServicePassage: passage,
        slotIndex,
        avoidQuestionIds: mergedAvoidIds,
        avoidQuestions: normalizedAvoidQuestions,
        targetVersion: targetMeta.version,
        targetStatus: targetMeta.status,
        targetExpectedRevision: targetMeta.expectedRevision,
        ...(existingQuestion ? { existingQuestion } : {}),
      });

      const steps = [];
      const handoffs = [];
      const inFlightByNode = new Map();
      let stepCounter = 0;

      const streamGen = graph.stream(taskPrompt, { invocationState });
      let next = await streamGen.next();
      while (!next.done) {
        const event = next.value;
        if (typeof onTraceEvent === "function") {
          onTraceEvent(event);
        }
        if (event.type === "beforeNodeCallEvent") {
          stepCounter++;
          inFlightByNode.set(event.nodeId, {
            stepIndex: stepCounter,
            nodeId: event.nodeId,
            startTime: Date.now(),
            toolCalls: [],
            agentTraces: [],
          });
        } else if (event.type === "nodeStreamUpdateEvent" && event.inner?.source === "agent") {
          const current = inFlightByNode.get(event.nodeId);
          const agentEvent = event.inner.event;
          if (current && agentEvent) {
            if (agentEvent.type === "beforeToolCallEvent" && agentEvent.toolUse) {
              current.toolCalls.push({
                toolUseId: agentEvent.toolUse.toolUseId,
                name: agentEvent.toolUse.name,
                input: agentEvent.toolUse.input,
                status: "running",
              });
            } else if (agentEvent.type === "afterToolCallEvent" && agentEvent.toolUse) {
              const tc = [...current.toolCalls].reverse().find(item => item.toolUseId === agentEvent.toolUse.toolUseId);
              if (tc) {
                tc.status = agentEvent.result?.status ?? (agentEvent.error ? "error" : "success");
              }
            } else if (agentEvent.type === "agentResultEvent" && agentEvent.result) {
              current.agentTraces = (agentEvent.result.traces ?? []).map(t => (typeof t.toJSON === "function" ? t.toJSON() : t));
            }
          }
        } else if (event.type === "nodeResultEvent") {
          const current = inFlightByNode.get(event.nodeId) ?? {
            stepIndex: ++stepCounter,
            nodeId: event.nodeId,
            startTime: Date.now() - (event.result?.duration ?? 0),
            toolCalls: [],
            agentTraces: [],
          };
          inFlightByNode.delete(event.nodeId);
          steps.push({
            ...current,
            nodeType: event.nodeType,
            status: event.result?.status ?? "COMPLETED",
            duration: event.result?.duration ?? 0,
            usage: event.result?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          });
        } else if (event.type === "multiAgentHandoffEvent") {
          const isLoopBack = event.source === "calibration_critic" && (event.targets ?? []).length > 0;
          handoffs.push({
            source: event.source,
            targets: [...(event.targets ?? [])],
            timestamp: Date.now(),
            isLoopBack,
            failureStage: isLoopBack ? invocationState.lastFailureStage : null,
          });
        }
        next = await streamGen.next();
      }

      const graphResult = next.value;
      const topology = extractGraphTopology(graph, { steps, handoffs });
      const trace = {
        graphId: graph.id,
        serviceId,
        mode,
        slotIndex,
        questionId: invocationState.calibratedResult?.question?.id ?? null,
        status: graphResult.status,
        duration: graphResult.duration,
        usage: graphResult.usage,
        cycles: (invocationState.cycleCount ?? 0) + 1,
        topology,
        steps,
        handoffs,
        calibration: invocationState.calibratedResult?.calibration ?? null,
      };

      if (graphResult.status !== "COMPLETED") {
        throw new Error(`Strands Graph ended with status ${graphResult.status}`);
      }
      if (invocationState.calibratedResult) {
        return {
          ...invocationState.calibratedResult,
          trace,
        };
      }
      throw new Error(
        `Failed to generate & calibrate question for ${serviceId} after ${maxAttempts} attempts: ${invocationState.lastCritique ?? "Unknown calibration error"}`
      );
    } finally {
      if (mcpSession) await mcpSession.disconnect().catch(() => {});
    }
  };

  return {
    generateOrRefreshQuestion,
  };
}
