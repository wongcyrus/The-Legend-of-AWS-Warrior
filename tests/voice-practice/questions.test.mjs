import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createQuestionAdmin, validateDrafts, validateQuestionBatch } from "../../src/VoicePractice/question-bank.mjs";
import { createQuestions, gradeAnswer, questionActivityId, validateAnswerGrade, validateQuestion, isAnswerTranscript } from "../../src/VoicePractice/questions.mjs";
import { languageConfig } from "../../src/VoicePractice/content.mjs";
import { rewardFor } from "../../src/VoicePractice/activities.mjs";
import { createAgent } from "../../src/VoiceAgent/agent.mjs";
import { questionRubric } from "../../src/VoicePractice/questions.mjs";
import { awsDependencies } from "../../src/VoicePractice/aws.mjs";
import { Readable } from "node:stream";

const published = JSON.parse(readFileSync(new URL("../../src/VoicePractice/questions.json", import.meta.url), "utf8"));
const drafts = published.map(question => ({ ...question, status: "draft" }));
const question = drafts[0];
const assessment = {
  concepts: question.concepts.map(concept => ({ id: concept.id, verdict: "met", evidence: "S3" })),
  feedback: "You explained the ideas.",
};

test("pilot includes two questions per service in English, Cantonese and Mandarin for direct publication", () => {
  assert.equal(validateQuestionBatch(published, "approved").length, 12);
  assert.equal(validateDrafts(drafts).length, 12);
  const counts = new Map();
  for (const draft of drafts) {
    assert.equal(draft.status, "draft");
    assert.equal(draft.expectedRevision, null);
    assert.deepEqual(Object.keys(draft.prompts), ["en-US", "zh-HK", "zh-CN"]);
    counts.set(draft.serviceId, (counts.get(draft.serviceId) ?? 0) + 1);
    assert.match(draft.prompts["zh-HK"], /\p{Script=Han}/u);
    assert.match(draft.prompts["zh-CN"], /\p{Script=Han}/u);
    assert.doesNotMatch(draft.prompts["zh-CN"], /[嘅喺唔畀佢哋乜啲揀嚟]/u);
  }
  assert.equal(counts.size, 6);
  assert.ok([...counts.values()].every(count => count === 2));
});

test("question validation fails closed on ambiguous identifiers, invalid weights, locales and missing rubrics", () => {
  for (const change of [
    { id: "bad#id" }, { serviceId: "" }, { version: 0 }, { version: 1.5 }, { title: "" },
    { status: "active" }, { prompts: {} }, { prompts: { "fr-FR": "Question?" } },
    { prompts: { "en-US": "x".repeat(2001) } }, { concepts: [] },
    { concepts: [question.concepts[0], question.concepts[0]] },
    { concepts: [{ ...question.concepts[0], weight: 99 }] },
    { concepts: [{ ...question.concepts[0], weight: 100.5 }] },
    { misconceptions: [""] }, { acceptableAnswers: null }, { referenceAnswer: "" },
  ]) assert.throws(() => validateQuestion({ ...question, ...change }));
  const clean = validateQuestion({ ...question, owner: "private", score: 100 });
  assert.equal(clean.owner, undefined);
  assert.equal(clean.score, undefined);
  assert.throws(() => validateDrafts([{ ...question, status: "approved" }]));
  assert.throws(() => validateDrafts([{ ...question, expectedRevision: undefined }]));
  assert.throws(() => validateDrafts([question, question]));
  assert.throws(() => validateDrafts([{ ...question, serviceId: "not-a-service" }]));
});

test("Q&A evidence is complete and transcript-grounded; scores and rewards are derived, never model-controlled", () => {
  const grade = gradeAnswer({ ...assessment, score: 1, passed: false, mpAwarded: 999 }, question, "S3");
  assert.deepEqual(grade, { score: 100, passed: true, breakdown: { understanding: 100 }, feedback: assessment.feedback });
  assert.equal(gradeAnswer({ ...assessment, concepts: [
    assessment.concepts[0], { ...assessment.concepts[1], verdict: "contradicted" },
  ] }, question, "S3").score, 50);
  assert.equal(gradeAnswer({ ...assessment, concepts: assessment.concepts.map(concept =>
    ({ ...concept, verdict: "missing", evidence: "" })) }, question, "S3").score, 0);
  assert.equal(gradeAnswer(assessment, question, "Ｓ３").score, 100);
  for (const change of [
    { concepts: [] }, { concepts: [assessment.concepts[0], assessment.concepts[0]] },
    { concepts: [{ ...assessment.concepts[0], id: "invented" }, assessment.concepts[1]] },
    { concepts: [{ ...assessment.concepts[0], evidence: "fabricated" }, assessment.concepts[1]] },
    { concepts: [{ ...assessment.concepts[0], verdict: "missing", evidence: "S3" }, assessment.concepts[1]] },
    { concepts: [{ ...assessment.concepts[0], verdict: "met", evidence: " " }, assessment.concepts[1]] },
    { feedback: "" },
  ]) assert.throws(() => gradeAnswer({ ...assessment, ...change }, question, "S3"));
  assert.throws(() => validateAnswerGrade({ ...grade, score: 101 }));
  assert.throws(() => validateAnswerGrade({ ...grade, breakdown: { understanding: 99 } }));
  assert.deepEqual([59, 60, 74, 75, 89, 90, 100].map(score => rewardFor(score, "question_answer")), [0, 10, 10, 20, 20, 30, 30]);
  assert.deepEqual([59, 60, 75, 90].map(score => rewardFor(score)), [0, 5, 10, 15]);
  assert.equal(isAnswerTranscript("S3"), true);
  assert.equal(isAnswerTranscript("是"), true);
  assert.equal(isAnswerTranscript("..."), false);
});

test("agent, AWS adapter and backend agree on the answer contract without exposing other input", async () => {
  const commands = [];
  const agent = createAgent({ modelId: "test-model", send: async command => {
    commands.push(command);
    return { stopReason: "end_turn", output: { message: { content: [{ text: JSON.stringify(assessment) }] } } };
  } });
  const deps = awsDependencies({ VOICE_AGENT_RUNTIME_ARN: "runtime" }, { runtime: { async send(command) {
    const input = JSON.parse(Buffer.from(command.input.payload));
    assert.equal(input.history, undefined);
    assert.equal(input.owner, undefined);
    assert.equal(input.score, undefined);
    assert.equal(input.operation, "grade_answer");
    return { response: Readable.from([JSON.stringify(await agent(input))]) };
  } } });
  const result = await deps.agent("grade_answer", {
    question: questionRubric(question, "en-US"), transcript: "S3", language: "en-US",
    history: ["Don't forward"], owner: "Don't forward", score: 100, operation: "generate",
  });
  assert.equal(gradeAnswer(result, question, "S3").score, 100);
  assert.equal(commands.length, 1);
});

test("question imports and approvals use revisions, preserve stable IDs, and require reapproval for edits", async () => {
  const rows = new Map();
  const store = {
    async get(key) { return structuredClone(rows.get(key.SK)); },
    async atomic(writes) {
      for (const write of writes) {
        const existing = rows.get(write.item.SK);
        if (write.previous === undefined ? existing : existing?.revision !== write.previous) throw new Error("conflict");
      }
      for (const write of writes) rows.set(write.item.SK, structuredClone(write.item));
    },
  };
  const admin = createQuestionAdmin(store, () => 1000);
  assert.equal(await admin.importDrafts([question]), 1);
  let row = [...rows.values()][0];
  assert.equal(row.status, "draft");
  assert.equal(row.revision, 0);
  await assert.rejects(() => admin.importDrafts([question]), /revision changed/);
  await assert.rejects(() => admin.setStatus("approve", "s3", question.id, 9), /unchanged/);
  await admin.setStatus("approve", "s3", question.id, 0);
  row = [...rows.values()][0];
  assert.equal(row.status, "approved");
  assert.equal(row.approvedAt, 1000);
  await assert.rejects(() => admin.setStatus("approve", "s3", question.id, 1), /unchanged/);
  await assert.rejects(() => admin.importDrafts([{ ...question, expectedRevision: 1 }]), /higher version/);
  await admin.importDrafts([{ ...question, version: 2, expectedRevision: 1 }]);
  row = [...rows.values()][0];
  assert.equal(row.status, "draft");
  assert.equal(row.approvedAt, undefined);
  assert.equal(row.revision, 2);
  assert.equal(row.id, question.id);
  await admin.setStatus("retire", "s3", question.id, 2);
  assert.equal([...rows.values()][0].status, "retired");
});

test("direct batch publishing and private export round-trip without draft approval or reward writes", async () => {
  const rows = new Map(), batches = [];
  const store = {
    async get(key) { return structuredClone(rows.get(key.SK)); },
    async listQuestions(serviceId) {
      return structuredClone([...rows.values()].filter(row => !serviceId || row.serviceId === serviceId));
    },
    async atomic(writes) {
      for (const write of writes) {
        const before = rows.get(write.item.SK);
        if (write.previous === undefined ? before : before?.revision !== write.previous) throw new Error("conflict");
      }
      batches.push(writes);
      for (const write of writes) rows.set(write.item.SK, structuredClone(write.item));
    },
  };
  const admin = createQuestionAdmin(store, () => 1000);
  assert.equal(await admin.publish(published), 12);
  assert.equal(batches.length, 1);
  assert.ok(batches[0].every(write => write.item.PK === "QUESTION_BANK" && write.item.status === "approved"));
  const exported = await admin.exportQuestions("s3");
  assert.equal(exported.length, 2);
  assert.ok(exported.every(row => row.expectedRevision === 0 && row.status === "approved"));
  assert.ok(exported.every(row => !Object.hasOwn(row, "PK") && !Object.hasOwn(row, "approvedAt")));
  assert.equal((await admin.exportQuestions()).length, 12);
  assert.equal(await admin.publish(exported.map(row => ({ ...row, version: row.version + 1 }))), 2);
  await assert.rejects(() => admin.publish(exported), /revision changed/);
  await assert.rejects(() => admin.publish(drafts), /matching status/);
  await assert.rejects(() => admin.exportQuestions("not-a-service"), /Unknown service/);
  assert.ok((await admin.exportQuestions("s3")).every(row => row.expectedRevision === 1 && row.version === 2));
});

test("after cooldown expires on completed questions, choose prioritizes uncompleted first then least-recently-passed (LRU)", async () => {
  const s3Questions = published.filter(q => q.serviceId === "s3");
  const qA = { ...s3Questions[0], id: "a-first" };
  const qB = { ...s3Questions[1], id: "b-second" };
  const qC = { ...s3Questions[0], id: "c-third" };
  const progress = new Map();
  let currentNow = 20 * 86400;
  const store = {
    async listQuestions() { return [qA, qB, qC]; },
    async get(key) { return progress.get(`${key.PK}#${key.SK}`); },
  };
  const qDomain = createQuestions({
    store,
    config: languageConfig,
    services: new Map([["s3", "Amazon S3"]]),
    fail: (code, msg) => { throw new Error(`${code}: ${msg}`); },
    now: () => currentNow,
  });

  // 1. qA was passed on Day 1 (cooldown expired on Day 8), qB was passed on Day 5 (cooldown expired on Day 12), qC is uncompleted:
  progress.set(`PLAYER#p1#ACTIVITY#${questionActivityId("s3", "a-first")}`, { completed: true, lastPassedAt: 1 * 86400 });
  progress.set(`PLAYER#p1#ACTIVITY#${questionActivityId("s3", "b-second")}`, { completed: true, lastPassedAt: 5 * 86400 });
  assert.equal((await qDomain.choose("p1", "s3", "en-US")).id, "c-third", "Uncompleted question must be chosen before expired-cooldown repeats");

  // 2. Now qC is passed on Day 6, and qA was passed again most recently on Day 10 (all cooldowns expired by Day 20):
  // Oldest lastPassedAt is now qB (Day 5), then qC (Day 6), then qA (Day 10).
  progress.set(`PLAYER#p1#ACTIVITY#${questionActivityId("s3", "a-first")}`, { completed: true, lastPassedAt: 10 * 86400 });
  progress.set(`PLAYER#p1#ACTIVITY#${questionActivityId("s3", "c-third")}`, { completed: true, lastPassedAt: 6 * 86400 });
  assert.equal((await qDomain.choose("p1", "s3", "en-US")).id, "b-second", "Should pick least-recently-passed question (qB) instead of repeating alphabetically first (qA)");

  // 3. Once qB is passed on Day 20, the next oldest after cooldown is qC (Day 6):
  progress.set(`PLAYER#p1#ACTIVITY#${questionActivityId("s3", "b-second")}`, { completed: true, lastPassedAt: 20 * 86400 });
  assert.equal((await qDomain.choose("p1", "s3", "en-US")).id, "c-third");
});

test("per-student sticky shuffle assigns different initial questions across students and prevents re-rolling before passing", async () => {
  const s3Questions = published.filter(q => q.serviceId === "s3");
  const pool = ["q-1", "q-2", "q-3", "q-4", "q-5"].map((id, i) => ({
    ...s3Questions[i % s3Questions.length],
    id,
    title: `Secret Title ${id}`,
  }));
  const progress = new Map();
  const store = {
    async listQuestions() { return pool; },
    async get(key) { return progress.get(`${key.PK}#${key.SK}`); },
  };
  const qDomain = createQuestions({
    store,
    config: languageConfig,
    services: new Map([["s3", "Amazon S3"]]),
    fail: (code, msg) => { throw new Error(`${code}: ${msg}`); },
    now: () => 1000,
  });

  // Across a classroom of 20 students, different students receive different initial questions from the pool:
  const firstAssigned = new Set();
  for (let i = 1; i <= 20; i++) {
    const assigned = await qDomain.choose(`student-${i}`, "s3", "en-US");
    firstAssigned.add(assigned.id);
  }
  assert.ok(firstAssigned.size >= 3, "Classroom students should receive diverse initial questions from the service bank");

  // A student who cancels, refreshes, or fails an attempt (completed: false) is always given the exact same sticky question:
  const initial = await qDomain.choose("student-1", "s3", "en-US");
  assert.equal((await qDomain.choose("student-1", "s3", "en-US")).id, initial.id);
  progress.set(`PLAYER#student-1#ACTIVITY#${questionActivityId("s3", initial.id)}`, {
    completed: false, latestScore: 40, bestScore: 40,
  });
  assert.equal((await qDomain.choose("student-1", "s3", "en-US")).id, initial.id,
    "Failing an attempt must not allow re-rolling a different question");
});
