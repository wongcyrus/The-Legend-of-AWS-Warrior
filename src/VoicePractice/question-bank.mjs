import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { activities } from "./activities.mjs";
import { questionKey, validateQuestion } from "./questions.mjs";

const services = new Set(activities.map(activity => activity.serviceId));

export function validateQuestionBatch(input, status) {
  if (!Array.isArray(input) || !input.length || input.length > 100) throw new Error("Supply 1-100 questions per batch");
  const ids = new Set();
  return input.map(value => {
    const question = validateQuestion(value);
    const key = questionKey(question.serviceId, question.id);
    if ((status && question.status !== status) || !services.has(question.serviceId) || ids.has(key.SK) ||
        !(value.expectedRevision === null || Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0))
      throw new Error("Each question needs a matching status, known service, unique ID and expectedRevision (null for new)");
    ids.add(key.SK);
    return { question, expectedRevision: value.expectedRevision };
  });
}

export const validateDrafts = input => validateQuestionBatch(input, "draft");

export function createQuestionAdmin(store, now = () => Math.floor(Date.now() / 1000)) {
  const writeQuestions = async (input, status) => {
    const questions = validateQuestionBatch(input, status);
    const writes = await Promise.all(questions.map(async ({ question, expectedRevision }) => {
      const key = questionKey(question.serviceId, question.id);
      const before = await store.get(key);
      if ((before?.revision ?? null) !== expectedRevision)
        throw new Error("Question revision changed; read the current item before editing");
      if (before && question.version <= before.version) throw new Error("Edited questions require a higher version");
      return { item: { ...key, ...question, revision: (before?.revision ?? -1) + 1, updatedAt: now(),
        ...(status === "approved" ? { approvedAt: now() } : {}) },
      previous: before?.revision };
    }));
    await store.atomic(writes);
    return writes.length;
  };
  return {
    importDrafts: input => writeQuestions(input, "draft"),
    publish: input => writeQuestions(input, "approved"),
    async exportQuestions(serviceId) {
      if (serviceId !== undefined && !services.has(serviceId)) throw new Error("Unknown service");
      const rows = await store.listQuestions(serviceId);
      return rows.map(row => {
        const question = validateQuestion(row);
        if (!Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error("Invalid question revision");
        return { ...question, expectedRevision: row.revision };
      }).sort((a, b) => a.serviceId.localeCompare(b.serviceId) || a.id.localeCompare(b.id));
    },
    async setStatus(action, serviceId, id, revision) {
      if (!["approve", "retire"].includes(action) || !Number.isSafeInteger(revision) || revision < 0)
        throw new Error("Invalid review action or revision");
      const before = await store.get(questionKey(serviceId, id));
      const question = validateQuestion(before);
      if (!services.has(serviceId) || question.serviceId !== serviceId || question.id !== id ||
          before.revision !== revision || (action === "approve" && before.status !== "draft"))
        throw new Error("Question is not an unchanged reviewable draft");
      await store.atomic([{ item: { ...before, status: action === "approve" ? "approved" : "retired",
        revision: revision + 1, updatedAt: now(), ...(action === "approve" ? { approvedAt: now() } : {}) },
      previous: revision }]);
    },
  };
}

async function main(args) {
  const [action, target, id, revision] = args;
  if (["validate", "import", "publish"].includes(action) && args.length === 2) {
    const input = JSON.parse(readFileSync(target, "utf8"));
    const questions = validateQuestionBatch(input, action === "import" ? "draft" : action === "publish" ? "approved" : undefined);
    if (action === "validate") { console.log(`Validated ${questions.length} questions. Nothing published.`); return; }
    if (!process.env.VOICE_TABLE) throw new Error("VOICE_TABLE is required");
    const { awsDependencies } = await import("./aws.mjs");
    const admin = createQuestionAdmin(awsDependencies().store);
    if (action === "publish") {
      await admin.publish(input);
      console.log(`Published ${questions.length} questions. Available immediately; existing rewards are unchanged.`);
    } else {
      await admin.importDrafts(input);
      console.log(`Imported ${questions.length} drafts. Explicit approval is still required.`);
    }
    return;
  }
  if (action === "export" && [2, 3].includes(args.length)) {
    if (!process.env.VOICE_TABLE) throw new Error("VOICE_TABLE is required");
    const { awsDependencies } = await import("./aws.mjs");
    const questions = await createQuestionAdmin(awsDependencies().store).exportQuestions(id);
    writeFileSync(target, JSON.stringify(questions, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(`Exported ${questions.length} questions. Contains private rubrics: do not upload to the public website.`);
    return;
  }
  if (["approve", "retire"].includes(action) && args.length === 4 && /^[0-9]+$/.test(revision)) {
    if (!process.env.VOICE_TABLE) throw new Error("VOICE_TABLE is required");
    const { awsDependencies } = await import("./aws.mjs");
    await createQuestionAdmin(awsDependencies().store).setStatus(action, target, id, Number(revision));
    console.log(`Question ${action === "approve" ? "approved" : "retired"}. Existing grades and rewards were not changed.`);
    return;
  }
  if (["generate", "refresh"].includes(action) && target && id) {
    const flags = args.slice(3);
    const serviceList = id.split(",").map(s => s.trim()).filter(Boolean);
    const countFlag = flags.find(f => f.startsWith("--count="));
    const countPerService = countFlag ? Number(countFlag.split("=")[1]) : 2;
    const force = flags.includes("--force");
    const shouldPublish = flags.includes("--publish") || (Boolean(process.env.VOICE_TABLE) && !flags.includes("--no-publish"));
    if (shouldPublish && !process.env.VOICE_TABLE) throw new Error("VOICE_TABLE is required when publishing");
    const store = process.env.VOICE_TABLE ? (await import("./aws.mjs")).awsDependencies().store : null;
    const { runQuestionBatchJob } = await import("./question-generator.mjs");
    const summary = await runQuestionBatchJob({
      mode: action,
      services: serviceList,
      countPerService,
      status: "approved",
      checkpointFile: target,
      force,
      publish: shouldPublish,
      store,
      onServiceComplete: ({ serviceId, questions }) => {
        console.log(`[${action}] Completed ${serviceId}: ${questions.length} calibrated approved question(s) saved to ${target}${shouldPublish ? " & published to DynamoDB" : ""}.`);
      },
    });
    console.log(`Finished ${action}: ${summary.completedServices.length} service(s) processed, ${summary.skippedServices.length} skipped from checkpoint, ${summary.publishedCount} question(s) published.`);
    return;
  }
  throw new Error("Usage: node question-bank.mjs validate|publish|import FILE\n       node question-bank.mjs export FILE [SERVICE]\n       node question-bank.mjs approve|retire SERVICE QUESTION EXPECTED_REVISION\n       node question-bank.mjs generate|refresh FILE SERVICE[,SERVICE...] [--count=2] [--publish|--no-publish] [--force]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
