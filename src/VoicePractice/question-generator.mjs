import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { activities } from "./activities.mjs";
import { gradeAnswer, validateQuestion } from "./questions.mjs";
import { createQuestionAdmin, validateQuestionBatch } from "./question-bank.mjs";
import {
  createNovaWebSearchTool,
  createQuestionGenerator as createAgentQuestionGenerator,
  extractNovaGroundingResult,
  loadAwsKnowledgeMcpTools,
  parseJsonFromText,
} from "../VoiceAgent/question-generator.mjs";

export {
  createNovaWebSearchTool,
  extractNovaGroundingResult,
  loadAwsKnowledgeMcpTools,
  parseJsonFromText,
};

const serviceCatalog = new Map();
for (const activity of activities) {
  if (!serviceCatalog.has(activity.serviceId) || activity.round === 1) {
    serviceCatalog.set(activity.serviceId, {
      serviceId: activity.serviceId,
      label: activity.label,
      passage: activity.readingTexts["en-US"],
    });
  }
}

export function createQuestionGenerator(options = {}) {
  return createAgentQuestionGenerator({
    validateQuestion,
    gradeAnswer,
    ...options,
  });
}

function loadCheckpointFile(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(raw)) throw new Error("Checkpoint file must contain a JSON array of questions");
  return raw;
}

function saveCheckpointFile(filePath, questions) {
  if (!filePath) return;
  writeFileSync(filePath, JSON.stringify(questions, null, 2) + "\n", { mode: 0o600 });
}

export async function runQuestionBatchJob({
  mode = "generate",
  services = [],
  countPerService = 2,
  status = "approved",
  checkpointFile = null,
  force = false,
  publish = false,
  store = null,
  generator = createQuestionGenerator(),
  onServiceComplete = null,
} = {}) {
  if (!["generate", "refresh"].includes(mode)) throw new Error("mode must be generate or refresh");
  if (!Array.isArray(services) || !services.length) throw new Error("Specify at least one serviceId");
  for (const serviceId of services) {
    if (!serviceCatalog.has(serviceId)) throw new Error(`Unknown service: ${serviceId}`);
  }
  const admin = store ? createQuestionAdmin(store) : null;
  if (publish && !admin) throw new Error("store is required when publish is enabled");

  const checkpoint = loadCheckpointFile(checkpointFile);
  const byKey = new Map(checkpoint.map(item => [`${item.serviceId}:${item.id}`, item]));
  const summary = {
    completedServices: [],
    skippedServices: [],
    publishedCount: 0,
    questions: [],
  };

  for (const serviceId of services) {
    const meta = serviceCatalog.get(serviceId);
    const checkpointForService = [...byKey.values()].filter(q => q.serviceId === serviceId);
    if (!force && checkpointForService.length >= (mode === "generate" ? countPerService : 1)) {
      summary.skippedServices.push(serviceId);
      continue;
    }

    const existingDbQuestions = admin ? await admin.exportQuestions(serviceId) : [];
    const existingIds = new Set([
      ...existingDbQuestions.map(q => q.id),
      ...checkpointForService.map(q => q.id),
    ]);
    const generatedForService = [];

    if (mode === "refresh") {
      const targets = existingDbQuestions.length
        ? existingDbQuestions
        : checkpointForService;
      if (!targets.length) {
        throw new Error(`No existing questions found to refresh for service ${serviceId}`);
      }
      for (let i = 0; i < targets.length; i++) {
        const existingQuestion = targets[i];
        const { question } = await generator.generateOrRefreshQuestion({
          serviceId,
          label: meta.label,
          passage: meta.passage,
          existingQuestion,
          avoidIds: [...existingIds].filter(id => id !== existingQuestion.id),
          slotIndex: i + 1,
          status,
        });
        generatedForService.push(question);
        byKey.set(`${serviceId}:${question.id}`, question);
      }
    } else {
      for (let i = 0; i < countPerService; i++) {
        const { question } = await generator.generateOrRefreshQuestion({
          serviceId,
          label: meta.label,
          passage: meta.passage,
          existingQuestion: null,
          avoidIds: [...existingIds],
          slotIndex: i + 1,
          status,
        });
        existingIds.add(question.id);
        generatedForService.push(question);
        byKey.set(`${serviceId}:${question.id}`, question);
      }
    }

    validateQuestionBatch(generatedForService, status);
    const allSaved = [...byKey.values()];
    saveCheckpointFile(checkpointFile, allSaved);

    if (publish && admin) {
      if (status === "approved") {
        summary.publishedCount += await admin.publish(generatedForService);
      } else {
        summary.publishedCount += await admin.importDrafts(generatedForService);
      }
    }
    summary.completedServices.push(serviceId);
    if (typeof onServiceComplete === "function") {
      await onServiceComplete({ serviceId, questions: generatedForService });
    }
  }

  summary.questions = [...byKey.values()];
  return summary;
}
