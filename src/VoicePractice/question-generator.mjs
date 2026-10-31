import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { activities } from "./activities.mjs";
import { gradeAnswer, validateQuestion } from "./questions.mjs";
import { createQuestionAdmin, validateQuestionBatch } from "./question-bank.mjs";
import {
  createNovaWebSearchTool,
  createQuestionGenerator as createAgentQuestionGenerator,
  extractNovaGroundingResult,
  findDuplicateOrOverlappingQuestion,
  loadAwsKnowledgeMcpTools,
  parseJsonFromText,
  summarizeExistingQuestion,
} from "../VoiceAgent/question-generator.mjs";

export {
  createNovaWebSearchTool,
  extractNovaGroundingResult,
  findDuplicateOrOverlappingQuestion,
  loadAwsKnowledgeMcpTools,
  parseJsonFromText,
  summarizeExistingQuestion,
};

const baselineQuestionsPath = new URL("./questions.json", import.meta.url);
const baselineQuestions = existsSync(baselineQuestionsPath)
  ? JSON.parse(readFileSync(baselineQuestionsPath, "utf8"))
  : [];

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
  includeBaselineQuestions = true,
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

    const baselineForService = includeBaselineQuestions
      ? baselineQuestions.filter(q => q.serviceId === serviceId)
      : [];
    const existingDbQuestions = admin ? await admin.exportQuestions(serviceId) : [];
    const existingQuestionsById = new Map();
    for (const q of [...baselineForService, ...existingDbQuestions, ...checkpointForService]) {
      if (q?.id) existingQuestionsById.set(q.id, q);
    }
    const existingIds = new Set(existingQuestionsById.keys());
    const generatedForService = [];

    if (mode === "refresh") {
      const targets = existingDbQuestions.length
        ? existingDbQuestions
        : checkpointForService.length
          ? checkpointForService
          : baselineForService;
      if (!targets.length) {
        throw new Error(`No existing questions found to refresh for service ${serviceId}`);
      }
      for (let i = 0; i < targets.length; i++) {
        const existingQuestion = targets[i];
        const avoidQuestions = [...existingQuestionsById.values()].filter(q => q.id !== existingQuestion.id);
        const { question } = await generator.generateOrRefreshQuestion({
          serviceId,
          label: meta.label,
          passage: meta.passage,
          existingQuestion,
          avoidIds: [...existingIds].filter(id => id !== existingQuestion.id),
          avoidQuestions,
          slotIndex: i + 1,
          status,
        });
        existingQuestionsById.set(question.id, question);
        generatedForService.push(question);
        byKey.set(`${serviceId}:${question.id}`, question);
      }
    } else {
      for (let i = 0; i < countPerService; i++) {
        const avoidQuestions = [...existingQuestionsById.values()];
        const { question } = await generator.generateOrRefreshQuestion({
          serviceId,
          label: meta.label,
          passage: meta.passage,
          existingQuestion: null,
          avoidIds: [...existingIds],
          avoidQuestions,
          slotIndex: i + 1,
          status,
        });
        existingIds.add(question.id);
        existingQuestionsById.set(question.id, question);
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
