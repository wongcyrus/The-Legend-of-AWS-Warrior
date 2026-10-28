import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHandler } from "../../src/VoicePractice/index.mjs";
import { bankKey, digest, completionKey, sessionKey, budgetKey, attemptKey, lessons, isMeaningfulTranscript } from "../../src/VoicePractice/domain.mjs";
import { awsDependencies, parseAgentResponse, readBounded, resolveOwner } from "../../src/VoicePractice/aws.mjs";
import { activities, validateGrade, rewardFor } from "../../src/VoicePractice/activities.mjs";
import { walletKey, activityKey, gradeKey, castKey } from "../../src/VoicePractice/economy.mjs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { questionKey, questionActivityId } from "../../src/VoicePractice/questions.mjs";
import { createQuestionAdmin } from "../../src/VoicePractice/question-bank.mjs";
import { readFileSync } from "node:fs";

const require = createRequire(new URL("../../src/VoicePractice/package.json", import.meta.url));
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const qaDrafts = JSON.parse(readFileSync(new URL("../../src/VoicePractice/questions.json", import.meta.url), "utf8"))
  .map(question => ({ ...question, status: "draft" }));
const approvedQuestions = () => qaDrafts.slice(0, 2).map(question => ({ ...question, status: "approved" }));
const createAnswer = async (f, serviceId = "s3", language = "en-US") => {
  const response = await f.req("/voice/sessions", { serviceId, type: "question_answer", language });
  assert.equal(response.statusCode, 200, response.body);
  return response.data;
};

function fixture({ readAloud = false, graded = false, catalog, languages, questions = [] } = {}) {
  const rows = new Map(), jobs = [], calls = [];
  let time = 1700000000000;
  const key = item => `${item.PK}/${item.SK}`;
  for (const question of questions) rows.set(key(questionKey(question.serviceId, question.id)),
    { ...question, ...questionKey(question.serviceId, question.id), revision: 0 });
  const conflict = () => Object.assign(new Error("conflict"), { conflict: true });
  const deps = {
    ...(catalog ? { activities: catalog } : {}),
    ...(languages ? { languageConfig: languages } : {}),
    now: () => time,
    store: {
      async get(k) { return structuredClone(rows.get(key(k))); },
      async listQuestions(serviceId) {
        return structuredClone([...rows.values()].filter(row => row.PK === "QUESTION_BANK" &&
          (!serviceId || row.serviceId === serviceId)));
      },
      async listActivities(owner) {
        return structuredClone([...rows.values()].filter(row => row.PK === `PLAYER#${owner}` && row.SK.startsWith("ACTIVITY#")));
      },
      isConflict: e => Boolean(e.conflict),
      async atomic(writes) {
        for (const w of writes) {
          const current = rows.get(key(w.item));
          if (w.previous === undefined ? current !== undefined : current?.revision !== w.previous) throw conflict();
        }
        for (const w of writes) rows.set(key(w.item), structuredClone(w.item));
      },
    },
    async ownerFor(event) {
      if (!event.requestContext?.identity?.apiKeyId) throw Object.assign(new Error("auth"), { conflict: false });
      return digest(event.requestContext.identity.apiKeyId);
    },
    async enqueue(job) { if (deps.queueError) throw new Error("queue down"); jobs.push(job); },
    async agent(operation, input) {
      calls.push({ operation, input });
      if (deps.agentError) throw new Error("agent unavailable");
      if (operation === "generate") return { questions: [{ id: "s3-storage", prompt: "Explain S3 storage and private access.",
        requiredConcepts: ["objects", "buckets", "private access"], misconceptions: ["public by default"] }] };
      if (deps.evaluate) return deps.evaluate(input);
      if (operation === "grade_reading") return { score: 80, breakdown: { coverage: 55, content: 25 }, feedback: "Good reading coverage." };
      if (operation === "grade_answer") return { concepts: input.question.concepts.map(concept => ({
        id: concept.id, verdict: "met", evidence: input.transcript,
      })), feedback: "You explained the required ideas." };
      return { passed: input.transcript.includes("correct"), feedback: "Explain buckets and private objects." };
    },
  };
  const handler = createHandler(deps, { VOICE_WEB_ORIGIN: "https://game.example" });
  async function req(path, body, options = {}) {
    const response = await handler({
      path, httpMethod: options.method ?? (body === undefined ? "GET" : "POST"),
      headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...options.headers },
      requestContext: { identity: { apiKeyId: options.owner ?? "alice@example.com" } },
      body: body === undefined ? undefined : JSON.stringify(body),
      queryStringParameters: options.query,
    });
    const data = response.body ? JSON.parse(response.body) : null;
    if (!graded && path === "/voice/sessions" && response.statusCode === 200) {
      // Exercise pre-rollout records without allowing clients to select a legacy mode.
      const historical = rows.get(key(sessionKey(data.id)));
      Object.assign(historical, { mode: "read_aloud", status: "pairing", expiresAt: Math.floor(time / 1000) + 300,
        readingTexts: lessons[body.serviceId].readingTexts, question: lessons[body.serviceId].readingTexts["en-US"] });
    }
    return { ...response, data };
  }
  const run = async () => { const job = jobs.shift(); if (job) await handler(job); };
  async function paired(approvedBank = true) {
    if (approvedBank) rows.set(key(bankKey("s3", "1")), {
      ...bankKey("s3", "1"), revision: 1, status: "approved",
      questions: [{ id: "s3-basics", prompt: "Explain S3.", requiredConcepts: ["objects"], misconceptions: ["public by default"] }],
    });
    const created = (await req("/voice/sessions", { serviceId: "s3" })).data;
    if (!readAloud) {
      // Simulate a session created before the read-aloud rollout.
      const historical = rows.get(key(sessionKey(created.id)));
      for (const field of ["mode", "readingTexts", "question", "bankVersion"]) delete historical[field];
    }
    const claim = (await req("/voice/mobile/claim", { id: created.id, pairingToken: created.pairingToken })).data;
    if (approvedBank) {
      assert.equal(claim.status, "ready");
      assert.equal(claim.question, readAloud ? lessons.s3.readingTexts["en-US"] : "Explain S3.");
    }
    return { ...created, ...claim, token: claim.mobileToken };
  }
  return { rows, jobs, calls, deps, req, run, paired, handler, key, advance: seconds => { time += seconds * 1000; } };
}

test("completion summary uses authenticated owner, survives session expiry and never exposes private fields", async () => {
  const f = fixture({ readAloud: true }), p = await f.paired();
  await f.req("/voice/mobile/answer", { transcript: "I am reading this service aloud.", source: "browser",
    speechCompleted: true }, { token: p.token });
  f.advance(86400);
  const result = await f.req("/voice/completions");
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.data.completed, 1);
  assert.equal(result.data.total, 6);
  assert.deepEqual(result.data.services.find(service => service.serviceId === "s3"),
    { serviceId: "s3", label: "Amazon S3", completed: true, completedAt: 1700000000 });
  assert.ok(result.data.services.filter(service => service.serviceId !== "s3")
    .every(service => !service.completed && service.completedAt === null));
  assert.equal((await f.req("/voice/completions", undefined, { owner: "other" })).data.completed, 0);
  assert.deepEqual(Object.keys(result.data.services[0]).sort(), ["completed", "completedAt", "label", "serviceId"]);
  assert.equal((await f.req("/voice/completions", undefined, { query: { token: p.token } })).statusCode, 400);
});

test("Q&A is enabled only for valid approved questions in the requested service and language", async () => {
  const f = fixture({ graded: true, questions: [
    ...qaDrafts,
    { ...qaDrafts[0], id: "retired", status: "retired" },
    { ...qaDrafts[0], id: "invalid", status: "approved", concepts: [] },
  ] });
  assert.equal((await f.req("/voice/sessions", { serviceId: "s3", type: "question_answer" })).statusCode, 409);
  assert.equal(f.jobs.length, 0);
  const admin = createQuestionAdmin(f.deps.store);
  await admin.setStatus("approve", "s3", qaDrafts[0].id, 0);
  const session = await createAnswer(f, "s3", "zh-HK");
  assert.equal(session.mode, "graded_question_answer");
  assert.equal(session.question, qaDrafts[0].prompts["zh-HK"]);
  assert.equal(session.readingTexts, undefined);
  assert.equal(session.paired, false);
  assert.equal(session.inputDevice, "desktop");
  assert.equal(session.activityId, questionActivityId("s3", qaDrafts[0].id));
  assert.equal((await f.req("/voice/sessions", { serviceId: "ec2", type: "question_answer" })).statusCode, 409);
  assert.equal((await f.req("/voice/sessions", { serviceId: "s3", type: "question_answer", language: "fr-FR" })).statusCode, 400);
  assert.equal((await f.req("/voice/sessions", { serviceId: "s3", type: "unknown" })).statusCode, 400);
  assert.equal((await f.req("/voice/sessions", { serviceId: "s3" })).data.mode, "graded_read_aloud");
  const summary = await f.req("/voice/completions");
  assert.equal(summary.data.activities.filter(activity => activity.type === "question_answer").length, 1);
  for (const response of [session, summary.data, (await f.req(`/voice/sessions/${session.id}`)).data]) {
    const json = JSON.stringify(response);
    for (const field of ["referenceAnswer", "acceptableAnswers", "concepts", "questionSnapshot", "expectedRevision"])
      assert.equal(json.includes(`"${field}"`), false, field);
    assert.equal(json.includes(qaDrafts[0].referenceAnswer), false);
  }
});

test("Q&A rotates questions within the selected service and never requires completed reading rounds", async () => {
  const f = fixture({ graded: true, questions: approvedQuestions() });
  const first = await createAnswer(f);
  await f.req(`/voice/sessions/${first.id}/answer`, spoken("S3"));
  await f.run();
  const result = (await f.req(`/voice/sessions/${first.id}`)).data.result;
  assert.equal(result.score, 100);
  assert.equal(result.mpAwarded, 30);
  assert.equal(result.breakdown.understanding, 100);
  assert.equal(result.breakdown.coverage, undefined);
  assert.equal(f.calls[0].operation, "grade_answer");
  assert.equal(f.calls[0].input.history, undefined);
  assert.equal((await f.req("/voice/completions")).data.completed, 0, "Q&A does not rewrite reading participation");
  const next = await createAnswer(f);
  assert.notEqual(next.questionId, first.questionId);
  assert.equal(next.serviceId, "s3");
  await f.req(`/voice/sessions/${next.id}/answer`, spoken("S3"));
  await f.run();
  const repeat = await createAnswer(f);
  assert.equal(repeat.questionId, first.questionId);
  await f.req(`/voice/sessions/${repeat.id}/answer`, spoken("S three"));
  await f.run();
  assert.equal((await f.req(`/voice/sessions/${repeat.id}`)).data.result.mpAwarded, 0);
  assert.equal((await f.req("/voice/wallet")).data.balance, 60);
  const reading = await createReading(f);
  assert.equal(reading.serviceId, "s3");
});

test("Q&A first-pass credits are atomic across tabs, languages and question versions", async () => {
  const question = approvedQuestions()[0];
  const f = fixture({ graded: true, questions: [question] });
  const a = await createAnswer(f), b = await createAnswer(f, "s3", "zh-HK");
  for (const session of [a, b])
    await f.req(`/voice/sessions/${session.id}/answer`, spoken("S3", session.language));
  await Promise.all([f.run(), f.run()]);
  const results = await Promise.all([a, b].map(async s => (await f.req(`/voice/sessions/${s.id}`)).data.result));
  assert.deepEqual(results.map(result => result.mpAwarded).sort((a, b) => a - b), [0, 30]);
  const admin = createQuestionAdmin(f.deps.store);
  await admin.importDrafts([{ ...question, status: "draft", version: 2, expectedRevision: 0 }]);
  await admin.setStatus("approve", "s3", question.id, 1);
  const revised = await createAnswer(f);
  assert.equal(revised.activityId, a.activityId);
  await f.req(`/voice/sessions/${revised.id}/answer`, spoken("S3"));
  await f.run();
  assert.equal((await f.req(`/voice/sessions/${revised.id}`)).data.result.mpAwarded, 0);
  assert.equal((await f.req("/voice/wallet")).data.balance, 30);
});

test("Q&A snapshots survive edits and retirement; marks remain visible without leaking rubrics", async () => {
  const question = approvedQuestions()[0];
  const f = fixture({ graded: true, questions: [question] }), s = await createAnswer(f);
  const admin = createQuestionAdmin(f.deps.store);
  await admin.importDrafts([{ ...question, status: "draft", version: 2, expectedRevision: 0,
    prompts: { "en-US": "Changed question?" } }]);
  assert.equal((await f.req("/voice/sessions", { serviceId: "s3", type: "question_answer" })).statusCode, 409);
  await f.req(`/voice/sessions/${s.id}/answer`, spoken("S3"));
  await f.run();
  assert.equal(f.calls[0].input.question.prompt, question.prompts["en-US"]);
  assert.deepEqual(f.calls[0].input.question.concepts, question.concepts);
  const summary = (await f.req("/voice/completions")).data;
  const saved = summary.activities.find(activity => activity.activityId === s.activityId);
  assert.equal(saved.available, false);
  assert.equal(saved.bestScore, 100);
  assert.equal(saved.title, question.title);
  assert.equal(summary.wallet.balance, 30);
  assert.equal((await f.req(`/voice/sessions/${s.id}`, undefined, { owner: "bob" })).statusCode, 404);
  const other = (await f.req("/voice/completions", undefined, { owner: "bob" })).data;
  assert.equal(other.activities.some(activity => activity.type === "question_answer"), false);
});

test("Q&A mobile transfer shares question, keeps rubric private and accepts short spoken answers", async () => {
  const f = fixture({ graded: true, questions: approvedQuestions() }), s = await createAnswer(f);
  assert.equal((await f.req("/voice/mobile/claim", { id: s.id, pairingToken: s.pairingToken })).statusCode, 409);
  const transfer = (await f.req(`/voice/sessions/${s.id}/transfer`, {})).data;
  const claim = (await f.req("/voice/mobile/claim", { id: s.id, pairingToken: transfer.pairingToken })).data;
  assert.equal(claim.questionId, s.questionId);
  assert.deepEqual(claim.questionTexts, s.questionTexts);
  assert.equal(claim.questionSnapshot, undefined);
  assert.equal(claim.conversation, undefined);
  assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, spoken("S3"))).statusCode, 409);
  for (const transcript of ["", " ", "..."]) {
    assert.equal((await f.req("/voice/mobile/answer", spoken(transcript), { token: claim.mobileToken })).statusCode, 400);
    assert.equal((await f.deps.store.get(sessionKey(s.id))).attempts, 0);
  }
  assert.equal((await f.req("/voice/mobile/answer", spoken("S3"), { token: claim.mobileToken })).data.status, "evaluating");
  const job = f.jobs[0];
  await f.run();
  await f.handler(job);
  const result = (await f.req("/voice/mobile/session", undefined, { token: claim.mobileToken })).data;
  assert.equal(result.result.mpAwarded, 30);
  assert.equal(result.questionSnapshot, undefined);
  assert.equal(f.calls.length, 1);
});

test("Q&A grading failures are retryable, saved grades recover without rerunning AI, and wallet cap consumes rewards", async () => {
  const f = fixture({ graded: true, questions: [approvedQuestions()[0]] }), s = await createAnswer(f);
  f.deps.agentError = true;
  const body = spoken("S3");
  await f.req(`/voice/sessions/${s.id}/answer`, body);
  await f.run();
  assert.equal((await f.req(`/voice/sessions/${s.id}`)).data.result.error, "processing_failed");
  assert.equal((await f.req("/voice/wallet")).data.balance, 0);
  f.deps.agentError = false;
  const atomic = f.deps.store.atomic;
  f.deps.store.atomic = writes => {
    if (writes.some(write => write.item.SK.startsWith("GRADE#"))) throw Object.assign(new Error("busy"), { conflict: true });
    return atomic(writes);
  };
  await f.req(`/voice/sessions/${s.id}/answer`, body);
  const job = f.jobs.shift();
  await assert.rejects(() => f.handler(job), /Voice worker failed/);
  f.deps.store.atomic = atomic;
  const owner = digest("alice@example.com");
  await atomic([{ item: { ...walletKey(owner), balance: 95, earned: 95, spent: 0, revision: 1 } }]);
  await f.handler(job);
  const result = (await f.req(`/voice/sessions/${s.id}`)).data;
  assert.equal(result.attempts, 1);
  assert.equal(result.result.mpAwarded, 5);
  assert.equal(f.calls.length, 2, "one failed call and one saved grade, no model rerun for credit");
  const again = await createAnswer(f);
  await f.req(`/voice/sessions/${again.id}/answer`, body);
  await f.run();
  assert.equal((await f.req(`/voice/sessions/${again.id}`)).data.result.mpAwarded, 0);
  assert.equal((await f.req("/voice/wallet")).data.balance, 100);
});

test("Q&A computes weighted points server-side and rejects fabricated evidence", async () => {
  const question = { ...approvedQuestions()[0], concepts: [
    { id: "storage", description: "Stores objects.", weight: 75 },
    { id: "private", description: "Keeps access private.", weight: 25 },
  ] };
  const f = fixture({ graded: true, questions: [question] }), s = await createAnswer(f);
  f.deps.evaluate = () => ({ score: 100, passed: true, mpAwarded: 1000, feedback: "Explain storage.",
    concepts: [{ id: "storage", verdict: "met", evidence: "not actually spoken" }, { id: "private", verdict: "missing", evidence: "" }] });
  await f.req(`/voice/sessions/${s.id}/answer`, spoken("S3"));
  await f.run();
  assert.equal((await f.req(`/voice/sessions/${s.id}`)).data.result.error, "processing_failed");
  f.deps.evaluate = () => ({ score: 100, passed: true, mpAwarded: 1000, feedback: "Explain private access.",
    concepts: [{ id: "storage", verdict: "met", evidence: "S3" }, { id: "private", verdict: "missing", evidence: "" }] });
  await f.req(`/voice/sessions/${s.id}/answer`, spoken("S3"));
  await f.run();
  const result = (await f.req(`/voice/sessions/${s.id}`)).data.result;
  assert.equal(result.score, 75);
  assert.equal(result.mpAwarded, 20);
});

test("question catalog queries consume every page with service boundaries and consistent reads", async () => {
  const database = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
  const requests = [];
  database.send = async command => {
    requests.push(command.input);
    return requests.length === 1 ? { Items: [{ id: "a" }],
      LastEvaluatedKey: { PK: "QUESTION_BANK", SK: "SERVICE#s3#QUESTION#a" } } : { Items: [{ id: "b" }] };
  };
  const { store } = awsDependencies({ VOICE_TABLE: "voice" }, { dynamo: database });
  assert.deepEqual(await store.listQuestions("s3"), [{ id: "a" }, { id: "b" }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].ConsistentRead, true);
  assert.deepEqual(requests[0].ExpressionAttributeValues, { ":bank": "QUESTION_BANK", ":prefix": "SERVICE#s3#QUESTION#" });
  assert.equal(requests[1].ExclusiveStartKey.SK, "SERVICE#s3#QUESTION#a");
});

test("Q&A uses the shared attempt budget and rejects untranslated or expired sessions", async () => {
  const question = { ...approvedQuestions()[0], prompts: { "en-US": "Where do you store screenshots?" } };
  const f = fixture({ graded: true, questions: [question] });
  assert.equal((await f.req("/voice/sessions", { serviceId: "s3", type: "question_answer", language: "zh-HK" })).statusCode, 409);
  const s = await createAnswer(f);
  assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, spoken("S3", "zh-HK"))).statusCode, 400);
  f.deps.evaluate = input => ({ feedback: "Explain how the storage works.",
    concepts: input.question.concepts.map(concept => ({ id: concept.id, verdict: "missing", evidence: "" })) });
  for (let i = 0; i < 6; i++) {
    assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, spoken(`wrong ${i}`))).statusCode, 200);
    await f.run();
  }
  assert.equal((await f.req(`/voice/sessions/${s.id}`)).data.status, "failed");
  assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, spoken("wrong again"))).statusCode, 409);
  assert.equal(f.calls.length, 6);
  assert.equal((await f.req("/voice/wallet")).data.balance, 0);
  const fresh = await createAnswer(f);
  const key = budgetKey(digest("alice@example.com"), 1700000000);
  const budget = await f.deps.store.get(key);
  await f.deps.store.atomic([{ item: { ...budget, count: 100, revision: budget.revision + 1 }, previous: budget.revision }]);
  assert.equal((await f.req(`/voice/sessions/${fresh.id}/answer`, spoken("S3"))).statusCode, 429);
  f.advance(1201);
  assert.equal((await f.req(`/voice/sessions/${fresh.id}`)).statusCode, 410);
});

test("owner binding, hashed capabilities, one conditional scan-to-answer claim and cancellation", async () => {
  const f = fixture();
  const created = await f.req("/voice/sessions", { serviceId: "s3", owner: "attacker" });
  assert.equal(created.statusCode, 200);
  const { id, pairingToken } = created.data;
  const stored = await f.deps.store.get(sessionKey(id));
  assert.equal(stored.owner, digest("alice@example.com"));
  assert.equal(stored.pairingHash, digest(pairingToken));
  assert.ok(!JSON.stringify(stored).includes(pairingToken));
  assert.equal((await f.req(`/voice/sessions/${id}`, undefined, { owner: "other" })).statusCode, 404);
  assert.equal((await f.req("/voice/mobile/claim", { id, pairingToken: "wrong" })).statusCode, 401);
  const claims = await Promise.all([1, 2].map(() => f.req("/voice/mobile/claim", { id, pairingToken })));
  assert.deepEqual(claims.map(x => x.statusCode).sort(), [200, 409]);
  const token = claims.find(x => x.statusCode === 200).data.mobileToken;
  assert.ok((await f.deps.store.get(sessionKey(id))).approvedAt);
  assert.equal(claims.find(x => x.statusCode === 200).data.status, "ready");
  await f.req(`/voice/sessions/${id}/cancel`, {});
  assert.equal((await f.req("/voice/mobile/session", undefined, { token })).statusCode, 410);
});

test("application checks pairing and approved expiry without TTL deletion", async () => {
  const f = fixture();
  const created = (await f.req("/voice/sessions", { serviceId: "s3" })).data;
  f.advance(301);
  assert.equal((await f.req("/voice/mobile/claim", { id: created.id, pairingToken: created.pairingToken })).statusCode, 410);
  const p = await f.paired();
  f.advance(301);
  assert.equal((await f.req("/voice/mobile/session", undefined, { token: p.token })).statusCode, 200);
  f.advance(900);
  assert.equal((await f.req("/voice/mobile/session", undefined, { token: p.token })).statusCode, 410);
});

test("new practices offer authored bilingual graded reading immediately without touching legacy banks", async () => {
  const f = fixture({ graded: true });
  f.deps.agentError = true;
  for (const [serviceId, lesson] of Object.entries(lessons)) {
    const created = (await f.req("/voice/sessions", { serviceId, mode: "graded", readingTexts: { "en-US": "injected" } })).data;
    assert.equal(created.mode, "graded_read_aloud");
    assert.equal(created.inputDevice, "desktop");
    assert.equal(created.status, "ready");
    assert.equal(created.paired, false);
    assert.equal(created.attempts, 0);
    assert.equal(created.maxAttempts, 6);
    assert.equal((await f.req("/voice/mobile/claim", { id: created.id, pairingToken: created.pairingToken })).statusCode, 409);
    const transfer = (await f.req(`/voice/sessions/${created.id}/transfer`, {})).data;
    const claimed = await f.req("/voice/mobile/claim", { id: created.id, pairingToken: transfer.pairingToken });
    assert.equal(claimed.statusCode, 200);
    assert.equal(claimed.data.mode, "graded_read_aloud");
    assert.equal(claimed.data.status, "ready");
    assert.deepEqual(claimed.data.readingTexts, lesson.readingTexts);
    assert.equal(claimed.data.question, lesson.readingTexts["en-US"]);
    assert.ok(lesson.readingTexts["en-US"].length < 1000);
    assert.match(lesson.readingTexts["zh-HK"], /\p{Script=Han}/u);
    assert.equal(f.jobs.length, 0);
  }
  assert.equal(f.calls.length, 0);
});

test("configuration drives new services, language availability and grading feedback; saved sessions retain their snapshot", async () => {
  const languages = { defaultLanguage: "fr-FR", languages: [
    { id: "fr-FR", label: "Français", speechLocale: "fr-FR", feedbackLanguage: "French" },
    { id: "de-DE", label: "Deutsch", speechLocale: "de-DE", feedbackLanguage: "German" },
  ] };
  const catalog = [{ activityId: "new-service-r1-v1", version: "1", serviceId: "new-service",
    label: "Configured service", round: 1, readingTexts: { "fr-FR": "Je lis cette activité configurée." } }];
  const f = fixture({ graded: true, languages, catalog });
  const created = (await f.req("/voice/sessions", { serviceId: "new-service" })).data;
  assert.equal(created.serviceId, "new-service");
  assert.equal(created.serviceLabel, "Configured service");
  assert.equal(created.defaultLanguage, "fr-FR");
  assert.equal(created.question, catalog[0].readingTexts["fr-FR"]);
  assert.deepEqual(created.languages, [{ id: "fr-FR", label: "Français", speechLocale: "fr-FR" }]);
  assert.equal((await f.req(`/voice/sessions/${created.id}/answer`,
    spoken("Ich lese diese Aktivität.", "de-DE"))).statusCode, 400);
  languages.languages = [];
  catalog[0].readingTexts["fr-FR"] = "Changed configuration must not change saved sessions.";
  await f.req(`/voice/sessions/${created.id}/answer`, spoken("Je lis cette activité configurée.", "fr-FR"));
  await f.run();
  assert.equal(f.calls[0].input.feedbackLanguage, "French");
  assert.equal(f.calls[0].input.language, "fr-FR");
  assert.equal(f.calls[0].input.readingTexts["fr-FR"], "Je lis cette activité configurée.");
  assert.equal((await f.req(`/voice/sessions/${created.id}`)).data.result.mpAwarded, 10);
  assert.equal((await f.req("/voice/completions")).data.activities[0].completed, true);
});

const spoken = (transcript = "Amazon S3 stores objects in private buckets.", language = "en-US") =>
  ({ transcript, language, source: "browser", speechCompleted: true });
const grade = score => ({ score, breakdown: { coverage: Math.min(score, 70), content: Math.max(0, score - 70) },
  feedback: "Read the passage and include its main points." });
const createReading = async (f, serviceId = "s3", owner) =>
  (await f.req("/voice/sessions", { serviceId }, { owner })).data;
async function completeReading(f, session, score = 80, owner) {
  f.deps.evaluate = () => grade(score);
  const submitted = await f.req(`/voice/sessions/${session.id}/answer`, spoken(), { owner });
  assert.equal(submitted.data.status, "evaluating");
  await f.run();
  return (await f.req(`/voice/sessions/${session.id}`, undefined, { owner })).data;
}

test("reading grades are strictly validated and thresholds are server owned", () => {
  for (const score of [0, 59, 60, 74, 75, 89, 90, 100]) {
    assert.equal(validateGrade({ ...grade(score), passed: true }).passed, score >= 60);
    assert.equal(rewardFor(score), score >= 90 ? 15 : score >= 75 ? 10 : score >= 60 ? 5 : 0);
  }
  for (const bad of [null, {}, grade(-1), grade(101), grade(60.5), { ...grade(70), score: "70" },
    { ...grade(70), score: true }, { ...grade(70), breakdown: { coverage: 71, content: -1 } },
    { ...grade(70), breakdown: { coverage: 70, content: 1 } }, { ...grade(70), feedback: "" },
    { ...grade(70), feedback: "x".repeat(1601) }]) assert.throws(() => validateGrade(bad));
});

test("desktop async grading, durable result, private poll and idempotent submission", async () => {
  const f = fixture({ graded: true }), s = await createReading(f);
  const body = spoken();
  const response = await f.req(`/voice/sessions/${s.id}/answer`, { ...body, score: 100, passed: true });
  assert.equal(response.data.status, "evaluating");
  assert.equal(response.data.result, undefined);
  assert.equal((await f.req(`/voice/sessions/${s.id}/transfer`, {})).statusCode, 409);
  assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, body)).data.attempts, 1);
  assert.equal(f.jobs.length, 1);
  const job = structuredClone(f.jobs[0]);
  await f.run();
  await f.handler(job);
  const completed = await f.req(`/voice/sessions/${s.id}`);
  assert.equal(completed.data.id, s.id);
  assert.equal(completed.data.inputDevice, "desktop");
  assert.equal(completed.data.status, "completed");
  assert.deepEqual(completed.data.result, { ...grade(80), feedback: "Good reading coverage.",
    breakdown: { coverage: 55, content: 25 }, passed: true, activityId: s.activityId, mpAwarded: 10 });
  assert.equal(completed.body.includes(body.transcript), false);
  assert.equal(completed.data.conversation, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].operation, "grade_reading");
  assert.deepEqual(f.calls[0].input.readingTexts, s.readingTexts);
  assert.deepEqual((await f.req("/voice/wallet")).data, { balance: 10, max: 100, earned: 10, spent: 0, revision: 1 });
  assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, body)).data.result.mpAwarded, 10);
  assert.equal(f.jobs.length, 0);
  const owner = digest("alice@example.com");
  const attempt = [...f.rows.values()].find(row => row.SK.startsWith("ATTEMPT#"));
  const durable = await f.deps.store.get(gradeKey(owner, s.id, attempt.hash));
  assert.equal(durable.expiresAt, undefined);
  assert.equal((await f.deps.store.get(activityKey(owner, s.activityId))).expiresAt, undefined);
  assert.equal(attempt.expiresAt, s.expiresAt + 86400);
  f.advance(86400);
  assert.equal((await f.req("/voice/completions")).data.activities.find(a => a.activityId === s.activityId).bestScore, 80);
});

test("explicit phone transfer revokes desktop ownership and capabilities remain scoped", async () => {
  const f = fixture({ graded: true }), s = await createReading(f);
  assert.equal((await f.req(`/voice/sessions/${s.id}/transfer`, {}, { owner: "bob" })).statusCode, 404);
  const transfer = await f.req(`/voice/sessions/${s.id}/transfer`, {});
  assert.equal(transfer.data.activityId, s.activityId);
  assert.equal(transfer.data.inputDevice, "phone");
  assert.equal(transfer.data.status, "pairing");
  assert.notEqual(transfer.data.pairingToken, s.pairingToken);
  assert.equal((await f.req("/voice/mobile/claim", { id: s.id, pairingToken: s.pairingToken })).statusCode, 401);
  assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, spoken())).statusCode, 409);
  const claim = (await f.req("/voice/mobile/claim", { id: s.id, pairingToken: transfer.data.pairingToken })).data;
  assert.equal(claim.status, "ready");
  assert.equal(claim.paired, true);
  assert.equal((await f.req(`/voice/sessions/${s.id}/transfer`, {})).statusCode, 409);
  assert.equal((await f.req("/voice/mobile/answer", spoken(), { token: claim.mobileToken })).data.status, "evaluating");
  await f.run();
  const mobile = await f.req("/voice/mobile/session", undefined, { token: claim.mobileToken });
  assert.equal(mobile.data.status, "completed");
  assert.equal(mobile.data.conversation, undefined);
  assert.equal(mobile.body.includes(spoken().transcript), false);
  const second = await createReading(f);
  const token = (await f.req(`/voice/sessions/${second.id}/transfer`, {})).data.pairingToken;
  f.advance(301);
  assert.equal((await f.req("/voice/mobile/claim", { id: second.id, pairingToken: token })).statusCode, 410);
});

test("graded desktop and phone reject meaningless speech before attempts, budget or model work", async () => {
  for (const device of ["desktop", "phone"]) {
    const f = fixture({ graded: true }), s = await createReading(f);
    let path = `/voice/sessions/${s.id}/answer`, options = {};
    if (device === "phone") {
      const transfer = (await f.req(`/voice/sessions/${s.id}/transfer`, {})).data;
      const claim = (await f.req("/voice/mobile/claim", { id: s.id, pairingToken: transfer.pairingToken })).data;
      path = "/voice/mobile/answer";
      options = { token: claim.mobileToken };
    }
    for (const transcript of ["", " ", "...", "!!!", "S3", "啊啊啊啊啊啊", "你好"]) {
      const response = await f.req(path, spoken(transcript, "zh-HK"), options);
      assert.equal(response.statusCode, 400, `${device}: ${JSON.stringify(transcript)}`);
      assert.equal((await f.deps.store.get(sessionKey(s.id))).attempts, 0);
      assert.equal((await f.deps.store.get(sessionKey(s.id))).status, "ready");
      assert.equal(await f.deps.store.get(budgetKey(digest("alice@example.com"), 1700000000)), undefined);
      assert.equal([...f.rows.values()].filter(row => row.SK.startsWith("ATTEMPT#")).length, 0);
      assert.equal(f.jobs.length, 0);
      assert.equal(f.calls.length, 0);
    }
    assert.equal((await f.req(path, spoken("我今日想開聲讀一次", "zh-HK"), options)).data.status, "evaluating");
    assert.equal((await f.deps.store.get(sessionKey(s.id))).attempts, 1);
    assert.equal(f.jobs.length, 1);
  }
});

test("queued evaluation safely ignores smoke-test sessions deleted before processing", async () => {
  const f = fixture({ graded: true }), s = await createReading(f);
  await f.req(`/voice/sessions/${s.id}/answer`, spoken());
  for (const [key, row] of f.rows) if (row.PK === `SESSION#${s.id}`) f.rows.delete(key);
  await f.run();
  assert.equal(f.jobs.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.req("/voice/wallet")).data.balance, 0);
  assert.ok((await f.req("/voice/completions")).data.activities.every(activity => !activity.completed));
});

test("all configured activities rotate earlier rounds first and finish safely", async () => {
  const f = fixture({ graded: true });
  const owner = digest("alice@example.com"), bank = { ...bankKey("s3", "1"), status: "approved", questions: ["unchanged"], revision: 7 };
  f.rows.set(f.key(bank), structuredClone(bank));
  const ids = new Set(), services = new Set();
  let round = 1;
  for (let i = 0; i < activities.length; i++) {
    // Keep this catalog-exhaustion scenario independent of daily submission limits and wallet capacity.
    if (i && i % 90 === 0) f.advance(86400);
    f.rows.delete(f.key(walletKey(owner)));
    const s = await createReading(f);
    assert.ok(s.round >= round);
    if (s.round !== round) { services.clear(); round = s.round; }
    assert.equal(services.has(s.serviceId), false);
    services.add(s.serviceId);
    ids.add(s.activityId);
    const result = await completeReading(f, s, 60);
    assert.equal(result.result.mpAwarded, 5);
  }
  assert.equal(ids.size, activities.length);
  assert.equal((await f.req("/voice/sessions", { serviceId: "s3" })).statusCode, 409);
  const summary = (await f.req("/voice/completions")).data;
  assert.equal(summary.total, 6);
  assert.equal(summary.completed, 6);
  assert.equal(summary.activities.filter(a => a.completed).length, activities.length);
  assert.equal(summary.wallet.balance, 5);
  assert.deepEqual(await f.deps.store.get(bankKey("s3", "1")), bank);
  assert.equal((await f.req("/voice/completions", undefined, { owner: "bob" })).data.wallet.balance, 0);
  assert.equal((await f.deps.store.get(walletKey(owner))).expiresAt, undefined);
});

test("authored passages are bounded, bilingual and versioned, with distinct second rounds", async () => {
  const { AWS_SERVICES } = await import("../../web-game/v2/aws-theme.js");
  assert.deepEqual(new Set(activities.map(a => a.serviceId)), new Set(Object.keys(AWS_SERVICES)));
  assert.equal(new Set(activities.map(a => a.activityId)).size, activities.length);
  for (const activity of activities) {
    assert.match(activity.activityId, /-r[12]-v1$/);
    assert.ok(activity.readingTexts["en-US"].length <= 2000);
    assert.match(activity.readingTexts["zh-HK"], /\p{Script=Han}/u);
    if (activity.round === 2) assert.notEqual(activity.readingTexts["en-US"], lessons[activity.serviceId].readingTexts["en-US"]);
  }
});

test("cross-tab first pass pays once, later improvements update scores but never pay again", async () => {
  const f = fixture({ graded: true });
  const a = await createReading(f), b = await createReading(f), c = await createReading(f);
  assert.equal(a.activityId, b.activityId);
  f.deps.evaluate = () => grade(60);
  for (const s of [a, b]) assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, spoken())).statusCode, 200);
  await Promise.all([f.run(), f.run()]);
  const results = await Promise.all([a, b].map(async s => (await f.req(`/voice/sessions/${s.id}`)).data.result));
  assert.deepEqual(results.map(r => r.mpAwarded).sort((x, y) => x - y), [0, 5]);
  assert.equal((await completeReading(f, c, 100)).result.mpAwarded, 0);
  const summary = (await f.req("/voice/completions")).data;
  assert.equal(summary.wallet.balance, 5);
  const activity = summary.activities.find(row => row.activityId === a.activityId);
  assert.equal(activity.bestScore, 100);
  assert.equal(activity.latestScore, 100);
  assert.equal(activity.mpAwarded, 5);
});

test("wallet capacity credits only actual MP; historical participation never converts", async () => {
  const f = fixture({ graded: true }), owner = digest("alice@example.com");
  const historical = { ...completionKey(owner, "s3"), mode: "read_aloud", comprehensionAssessed: false,
    verified: true, completedAt: 123 };
  f.rows.set(f.key(historical), historical);
  f.rows.set(f.key(walletKey(owner)), { ...walletKey(owner), balance: 98, earned: 98, spent: 0, revision: 2 });
  const s = await createReading(f);
  assert.equal((await completeReading(f, s, 100)).result.mpAwarded, 2);
  assert.deepEqual(await f.deps.store.get(completionKey(owner, "s3")), historical);
  const next = await createReading(f);
  assert.equal((await completeReading(f, next, 100)).result.mpAwarded, 0);
  assert.equal((await f.req("/voice/wallet")).data.earned, 100);
  assert.equal((await f.req("/voice/wallet")).data.balance, 100);
});

test("invalid/model errors are retryable without fake grades or duplicate budget charges", async () => {
  for (const failure of ["unavailable", "invalid"]) {
    const f = fixture({ graded: true }), s = await createReading(f);
    f.deps.agentError = failure === "unavailable";
    f.deps.evaluate = () => ({ score: 101, feedback: "bad" });
    await f.req(`/voice/sessions/${s.id}/answer`, spoken());
    await f.run();
    const failed = (await f.req(`/voice/sessions/${s.id}`)).data;
    assert.equal(failed.status, "ready");
    assert.equal(failed.result.error, "processing_failed");
    assert.equal(failed.result.score, undefined);
    assert.equal((await f.req("/voice/wallet")).data.balance, 0);
    f.deps.agentError = false; f.deps.evaluate = () => grade(75);
    assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, spoken())).data.status, "evaluating");
    await f.run();
    assert.equal((await f.req(`/voice/sessions/${s.id}`)).data.result.score, 75);
    assert.equal((await f.req(`/voice/sessions/${s.id}`)).data.attempts, 1);
    assert.equal((await f.deps.store.get(budgetKey(digest("alice@example.com"), 1700000000))).count, 1);
  }
});

test("saved grade survives credit transaction interruption without invoking AI again", async () => {
  const f = fixture({ graded: true }), s = await createReading(f);
  const original = f.deps.store.atomic;
  let blocked = true;
  f.deps.store.atomic = async writes => {
    if (blocked && writes.some(w => w.item.SK.startsWith("GRADE#"))) {
      blocked = false; throw new Error("storage interrupted");
    }
    return original(writes);
  };
  await f.req(`/voice/sessions/${s.id}/answer`, spoken());
  const job = f.jobs.shift();
  await assert.rejects(() => f.handler(job), /Voice worker failed/);
  assert.equal(f.calls.length, 1);
  await f.handler(job);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.req(`/voice/sessions/${s.id}`)).data.result.mpAwarded, 10);
});

test("saved grades survive unavailable recovery queues and ten-minute processing timeouts", async () => {
  const f = fixture({ graded: true }), s = await createReading(f);
  const original = f.deps.store.atomic;
  f.deps.store.atomic = async writes => {
    if (writes.some(w => w.item.SK.startsWith("GRADE#"))) throw new Error("storage interrupted");
    return original(writes);
  };
  await f.req(`/voice/sessions/${s.id}/answer`, spoken());
  const job = f.jobs.shift();
  await assert.rejects(() => f.handler(job), /Voice worker failed/);
  f.advance(601);
  f.deps.queueError = true;
  assert.equal((await f.req(`/voice/sessions/${s.id}`)).statusCode, 503);
  const saved = await f.deps.store.get(sessionKey(s.id));
  assert.equal(saved.status, "evaluating");
  assert.ok((await f.deps.store.get(attemptKey(s.id, saved.attemptHash))).grade);
  assert.equal(f.calls.length, 1);
  f.deps.queueError = false; f.deps.store.atomic = original;
  f.advance(4);
  await f.req(`/voice/sessions/${s.id}`);
  await f.run();
  assert.equal((await f.req(`/voice/sessions/${s.id}`)).data.result.mpAwarded, 10);
  assert.equal(f.calls.length, 1);
});

test("six submissions and one hundred per owner/day are enforced for graded reading", async () => {
  const f = fixture({ graded: true }), s = await createReading(f);
  f.deps.evaluate = () => grade(59);
  for (let i = 0; i < 6; i++) {
    assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, spoken(`Attempt number ${i}`))).data.status, "evaluating");
    await f.run();
  }
  assert.equal((await f.req(`/voice/sessions/${s.id}`)).data.status, "failed");
  assert.equal((await f.req("/voice/wallet")).data.balance, 0);
  assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, spoken("seventh reading"))).statusCode, 409);
  const next = await createReading(f);
  const key = budgetKey(digest("alice@example.com"), 1700000000);
  f.rows.set(f.key(key), { ...key, count: 100, revision: 0 });
  assert.equal((await f.req(`/voice/sessions/${next.id}/answer`, spoken())).statusCode, 429);
});

test("casts validate input, isolate owners and atomically enforce balance, shared cooldown and idempotency", async () => {
  const f = fixture({ graded: true }), owner = digest("alice@example.com");
  assert.deepEqual((await f.req("/voice/wallet")).data, { balance: 0, max: 100, earned: 0, spent: 0, revision: 0 });
  const cast = { requestId: randomUUID(), spell: "lightning", level: 2 };
  assert.equal((await f.req("/voice/casts", cast)).statusCode, 409);
  f.rows.set(f.key(walletKey(owner)), { ...walletKey(owner), balance: 10, earned: 10, spent: 0, revision: 1 });
  for (const bad of [{ ...cast, requestId: "bad" }, { ...cast, spell: "__proto__" }, { ...cast, level: 0 },
    { ...cast, level: 4 }, { ...cast, level: 1.2 }, { ...cast, level: "1" }])
    assert.equal((await f.req("/voice/casts", bad)).statusCode, 400);
  const results = await Promise.all([1, 2].map(() => f.req("/voice/casts", cast)));
  assert.ok(results.every(r => r.statusCode === 200));
  assert.deepEqual(results[0].data, results[1].data);
  assert.equal(results[0].data.wallet.balance, 8);
  assert.equal(results[0].data.wallet.spent, 2);
  assert.equal((await f.req("/voice/casts", { ...cast, level: 1 })).statusCode, 409);
  assert.equal((await f.req("/voice/casts", { ...cast, requestId: randomUUID(), spell: "frost" })).statusCode, 409);
  assert.equal((await f.req("/voice/casts", cast, { owner: "bob" })).statusCode, 409);
  assert.equal((await f.req("/voice/wallet", undefined, { owner: "bob" })).data.balance, 0);
  f.advance(6);
  const races = await Promise.all(["frost", "fireball"].map(spell =>
    f.req("/voice/casts", { requestId: randomUUID(), spell, level: 3 })));
  assert.deepEqual(races.map(r => r.statusCode).sort(), [200, 409]);
  assert.equal((await f.req("/voice/wallet")).data.balance, 5);
  assert.equal((await f.deps.store.get(castKey(owner, cast.requestId))).expiresAt, undefined);
  for (const [spell, seconds] of Object.entries({ lightning: 6, fireball: 5, frost: 4, storm: 9, shockwave: 2 })) {
    f.advance(10);
    f.rows.set(f.key(walletKey(owner)), { ...walletKey(owner), balance: 10, earned: 10, spent: 0, revision: 30 });
    const result = (await f.req("/voice/casts", { requestId: randomUUID(), spell, level: 1 })).data;
    assert.equal(result.cooldownUntil, (f.deps.now() / 1000) + seconds);
  }
});

test("cast conflict exhaustion is bounded and safely retries the same UUID", async () => {
  const f = fixture({ graded: true }), owner = digest("alice@example.com");
  f.rows.set(f.key(walletKey(owner)), { ...walletKey(owner), balance: 3, earned: 3, spent: 0, revision: 1 });
  const original = f.deps.store.atomic;
  let calls = 0;
  f.deps.store.atomic = async () => { calls++; throw Object.assign(new Error("collision"), { conflict: true }); };
  const body = { requestId: randomUUID(), spell: "storm", level: 3 };
  assert.equal((await f.req("/voice/casts", body)).statusCode, 503);
  assert.equal(calls, 6);
  f.deps.store.atomic = original;
  assert.equal((await f.req("/voice/casts", body)).data.wallet.balance, 0);
});

test("parallel credit on different activities and racing debit preserve the wallet ledger", async () => {
  const f = fixture({ graded: true }), owner = digest("alice@example.com");
  const a = await createReading(f, "s3"), b = await createReading(f, "ec2");
  f.rows.set(f.key(walletKey(owner)), { ...walletKey(owner), balance: 95, earned: 95, spent: 0, revision: 1 });
  f.deps.evaluate = () => grade(90);
  for (const s of [a, b]) await f.req(`/voice/sessions/${s.id}/answer`, spoken());
  const cast = { requestId: randomUUID(), spell: "shockwave", level: 3 };
  const jobs = f.jobs.splice(0);
  const results = await Promise.all([...jobs.map(job => f.handler(job)), f.req("/voice/casts", cast)]);
  assert.equal(results.at(-1).statusCode, 200);
  const w = (await f.req("/voice/wallet")).data;
  assert.ok(w.balance <= 100 && w.balance >= 0);
  assert.equal(w.earned - w.spent, w.balance);
  assert.equal(w.spent, 3);
  const credits = (await f.req("/voice/completions")).data.activities.reduce((sum, a) => sum + a.mpAwarded, 0);
  assert.equal(w.earned, 95 + credits);
  assert.equal(w.revision, 4);
});

test("failing a new activity cannot suppress an outstanding legacy participation completion", async () => {
  const f = fixture({ graded: true }), owner = digest("alice@example.com");
  const fresh = await createReading(f);
  const legacy = await createReading(f);
  Object.assign(f.rows.get(f.key(sessionKey(legacy.id))), {
    mode: "read_aloud", status: "ready", approvedAt: 1700000000,
  });
  assert.equal((await completeReading(f, fresh, 40)).completed, false);
  assert.equal(await f.deps.store.get(completionKey(owner, "s3")), undefined);
  await f.req(`/voice/sessions/${legacy.id}/cancel`, {});
  const legacyRow = f.rows.get(f.key(sessionKey(legacy.id)));
  legacyRow.status = "pairing"; legacyRow.pairingHash = digest("legacy-capability");
  const claim = (await f.req("/voice/mobile/claim", { id: legacy.id, pairingToken: "legacy-capability" })).data;
  assert.equal((await f.req("/voice/mobile/answer", spoken(), { token: claim.mobileToken })).data.status, "completed");
  const saved = await f.deps.store.get(completionKey(owner, "s3"));
  assert.equal(saved.mode, "read_aloud");
  assert.equal(saved.verified, true);
  assert.equal((await f.req("/voice/wallet")).data.balance, 0);
});

test("failed-processing transcript retries are bounded, owner-bound and budget-idempotent", async () => {
  const f = fixture({ graded: true }), s = await createReading(f);
  f.deps.agentError = true;
  for (let i = 0; i < 4; i++) {
    assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, spoken())).data.status, "evaluating");
    await f.run();
  }
  assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, spoken())).statusCode, 503);
  assert.equal((await f.req(`/voice/sessions/${s.id}/answer`, spoken(), { owner: "bob" })).statusCode, 404);
  assert.equal((await f.req(`/voice/sessions/${s.id}`)).data.attempts, 1);
  assert.equal((await f.deps.store.get(budgetKey(digest("alice@example.com"), 1700000000))).count, 1);
  assert.equal(f.calls.length, 4);
});

test("cast UUID scope permits another funded owner without sharing request or cooldown records", async () => {
  const f = fixture({ graded: true });
  for (const owner of ["alice@example.com", "bob"]) {
    const key = walletKey(digest(owner));
    f.rows.set(f.key(key), { ...key, balance: 5, earned: 5, spent: 0, revision: 1 });
  }
  const body = { requestId: randomUUID(), spell: "storm", level: 3, owner: "bob" };
  assert.equal((await f.req("/voice/casts", body)).data.wallet.balance, 2);
  assert.equal((await f.req("/voice/casts", body, { owner: "bob" })).data.wallet.balance, 2);
  assert.equal((await f.req("/voice/wallet")).data.balance, 2);
});

test("AWS adapter forwards bounded authored reading input and rejects invalid AgentCore grades", async () => {
  let command, reply = grade(75);
  const deps = awsDependencies({ VOICE_AGENT_RUNTIME_ARN: "runtime", VOICE_AGENT_QUALIFIER: "live" }, {
    runtime: { async send(value) {
      command = value;
      return { response: Readable.from([JSON.stringify(reply)]) };
    } },
  });
  const input = { readingTexts: activities[0].readingTexts, activityId: activities[0].activityId,
    serviceId: "s3", transcript: "S three objects in buckets.", language: "zh-HK" };
  assert.deepEqual(await deps.agent("grade_reading", input), { ...grade(75), passed: true });
  assert.deepEqual(JSON.parse(Buffer.from(command.input.payload).toString()), { operation: "grade_reading", ...input });
  assert.equal(command.input.qualifier, "live");
  assert.ok(command.input.runtimeSessionId.length >= 33);
  reply = { ...grade(75), breakdown: { coverage: 70, content: 30 } };
  await assert.rejects(() => deps.agent("grade_reading", input), /Invalid reading grade/);
  assert.equal(deps.store.isConflict({ name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "TransactionConflict" }] }), true);
  assert.equal(deps.store.isConflict({ name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ValidationError" }] }), false);
});

test("AWS adapter canonicalizes persisted reading maps and excludes unrelated grade input", async () => {
  const payloads = [];
  const deps = awsDependencies({ VOICE_AGENT_RUNTIME_ARN: "runtime" }, {
    runtime: { async send(command) {
      payloads.push(Buffer.from(command.input.payload).toString());
      return { response: Readable.from([JSON.stringify(grade(100))]) };
    } },
  });

  const texts = activities[0].readingTexts;
  for (const readingTexts of [texts, { "zh-HK": texts["zh-HK"], "en-US": texts["en-US"] }]) {
    await deps.agent("grade_reading", { readingTexts, activityId: activities[0].activityId,
      serviceId: "s3", transcript: texts["en-US"], owner: "not-forwarded", history: ["not-forwarded"] });
  }
  assert.equal(payloads[0], payloads[1]);
  assert.deepEqual(Object.keys(JSON.parse(payloads[1]).readingTexts), ["en-US", "zh-HK"]);
  assert.equal(JSON.parse(payloads[1]).owner, undefined);
  assert.equal(JSON.parse(payloads[1]).history, undefined);
  assert.equal(JSON.parse(payloads[1]).language, "en-US");
});

test("catalog progress queries only the authenticated player's activity prefix and consumes every page", async () => {
  const database = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
  const requests = [];
  database.send = async command => {
    requests.push(command.input);
    return requests.length === 1 ? {
      Items: [{ activityId: "s3-reading-r1-v1" }], LastEvaluatedKey: { PK: "PLAYER#owner", SK: "ACTIVITY#next" },
    } : { Items: [{ activityId: "ec2-reading-r1-v1" }] };
  };
  const deps = awsDependencies({ VOICE_TABLE: "voice" }, { dynamo: database });
  assert.deepEqual(await deps.store.listActivities("owner"), [
    { activityId: "s3-reading-r1-v1" }, { activityId: "ec2-reading-r1-v1" },
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].ConsistentRead, true);
  assert.deepEqual(requests[0].ExpressionAttributeValues, { ":owner": "PLAYER#owner", ":prefix": "ACTIVITY#" });
  assert.deepEqual(requests[1].ExclusiveStartKey, { PK: "PLAYER#owner", SK: "ACTIVITY#next" });
});

test("read-aloud completes for any meaningful speech without matching text, calling AI or leaking transcripts", async () => {
  const f = fixture({ readAloud: true }), p = await f.paired(false);
  f.deps.agentError = true;
  const body = { transcript: "Today I am speaking about my favourite game.", source: "browser",
    speechCompleted: true, language: "en-US", passed: true };
  const first = await f.req("/voice/mobile/answer", body, { token: p.token });
  await f.req("/voice/mobile/answer", body, { token: p.token });
  assert.equal(first.data.status, "completed");
  assert.equal(first.data.result.passed, true);
  assert.equal(f.jobs.length, 0);
  assert.equal(f.calls.length, 0);
  const mobile = (await f.req("/voice/mobile/session", undefined, { token: p.token })).data;
  assert.equal(mobile.status, "completed");
  assert.equal(mobile.result.passed, true);
  assert.match(mobile.result.feedback, /participation, not understanding/);
  assert.equal(mobile.attempts, 1);
  assert.equal(mobile.conversation.length, 1);
  const award = await f.deps.store.get(completionKey(digest("alice@example.com"), "s3"));
  assert.equal(award.mode, "read_aloud");
  assert.equal(award.comprehensionAssessed, false);
  const owner = await f.req(`/voice/sessions/${p.id}`);
  assert.equal(owner.data.completed, true);
  assert.equal(owner.body.includes(body.transcript), false);
  assert.equal((await f.req(`/voice/sessions/${p.id}`, undefined, { owner: "bob" })).statusCode, 404);
  assert.equal((await f.req("/voice/mobile/answer", { ...body, transcript: "Another spoken answer." }, { token: p.token })).statusCode, 409);
});

test("Cantonese speech completes reading with localized participation feedback; silence and noise never complete", async () => {
  const f = fixture({ readAloud: true }), p = await f.paired(false);
  for (const transcript of ["", " ", "...", "S3", "啊啊啊啊啊啊", "你好"]) {
    assert.equal(isMeaningfulTranscript(transcript), false);
    assert.equal((await f.req("/voice/mobile/answer", { source: "browser", speechCompleted: true,
      transcript, language: "zh-HK" }, { token: p.token })).statusCode, 400);
  }
  assert.equal(f.jobs.length, 0);
  const transcript = "我今日想開聲讀一次";
  await f.req("/voice/mobile/answer", { source: "browser", speechCompleted: true,
    transcript, language: "zh-HK" }, { token: p.token });
  await f.run();
  const result = (await f.req("/voice/mobile/session", undefined, { token: p.token })).data;
  assert.equal(result.status, "completed");
  assert.match(result.result.feedback, /朗讀練習完成/);
  assert.equal(f.calls.length, 0);
});

test("removed audio endpoints cannot upload or transcribe, reserve budget or award completion", async () => {
  const f = fixture({ readAloud: true }), p = await f.paired(false);
  for (const path of ["/voice/mobile/upload", "/voice/mobile/transcribe"]) {
    const response = await f.req(path, { contentType: "audio/webm", transcript: "injected speech" }, { token: p.token });
    assert.equal(response.statusCode, 404);
    assert.equal(response.data.uploadUrl, undefined);
  }
  const session = (await f.req("/voice/mobile/session", undefined, { token: p.token })).data;
  assert.equal(session.status, "ready");
  assert.equal(session.attempts, 0);
  assert.equal(session.completed, false);
  assert.equal(f.jobs.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.deps.store.get(budgetKey(digest("alice@example.com"), 1700000000)), undefined);
});

test("read-aloud never overwrites an existing comprehension completion", async () => {
  const f = fixture({ readAloud: true });
  const award = { ...completionKey(digest("alice@example.com"), "s3"), verified: true,
    lessonVersion: "1", completedAt: 123, sessionId: "historical" };
  await f.deps.store.atomic([{ item: award }]);
  const p = await f.paired(false);
  await f.req("/voice/mobile/answer", { source: "browser", speechCompleted: true,
    transcript: "Read this aloud once." }, { token: p.token });
  await f.run();
  assert.deepEqual(await f.deps.store.get(completionKey(digest("alice@example.com"), "s3")), award);
  assert.equal((await f.req("/voice/mobile/session", undefined, { token: p.token })).data.status, "completed");
});

test("generation shared across players, duplicate worker does not call AI twice, review required", async () => {
  const f = fixture();
  const a = await f.paired(false);
  const b = await f.paired(false);
  assert.equal(f.jobs.length, 1);
  const job = f.jobs[0];
  await Promise.all([f.handler(job), f.handler(job)]);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.req("/voice/mobile/session", undefined, { token: a.token })).data.status, "awaiting_question_approval");
  const bank = await f.deps.store.get(bankKey("s3", "1"));
  await f.deps.store.atomic([{ item: { ...bank, status: "approved", revision: bank.revision + 1 }, previous: bank.revision }]);
  for (const p of [a, b]) {
    const response = await f.req("/voice/mobile/session", undefined, { token: p.token });
    assert.equal(response.data.status, "ready");
    assert.equal(typeof response.data.question, "string");
    assert.equal(response.data.requiredConcepts, undefined);
  }
});

test("browser submission is idempotent and completion persists across new sessions", async () => {
  const f = fixture(), p = await f.paired();
  const answer = { transcript: "correct concepts", source: "browser", speechCompleted: true };
  await f.req("/voice/mobile/answer", answer, { token: p.token });
  await f.req("/voice/mobile/answer", answer, { token: p.token });
  assert.equal(f.jobs.length, 1);
  const job = f.jobs[0];
  await Promise.all([f.handler(job), f.handler(job)]);
  assert.equal(f.calls.filter(c => c.operation === "evaluate").length, 1);
  assert.equal((await f.req(`/voice/sessions/${p.id}`)).data.completed, true);
  assert.equal((await f.deps.store.get(completionKey(digest("alice@example.com"), "s3"))).verified, true);
  const p2 = await f.paired();
  assert.equal((await f.req(`/voice/sessions/${p2.id}`)).data.completed, true);
  assert.equal((await f.req(`/voice/sessions/${p2.id}`)).data.result, undefined);
});

test("max six attempts, browser source validation and bounded transcripts", async () => {
  const f = fixture(), p = await f.paired();
  for (const body of [
    { transcript: "words", source: "transcribe", speechCompleted: true },
    { transcript: "words", source: "browser", speechCompleted: false },
    { transcript: "x".repeat(6001), source: "browser", speechCompleted: true },
  ]) assert.equal((await f.req("/voice/mobile/answer", body, { token: p.token })).statusCode, 400);
  for (let i = 0; i < 6; i++) {
    await f.req("/voice/mobile/answer", { transcript: `try ${i}`, source: "browser", speechCompleted: true }, { token: p.token });
    await f.run();
  }
  const state = await f.deps.store.get(sessionKey(p.id));
  assert.equal(state.attempts, 6);
  assert.equal(state.status, "failed");
  assert.match(state.result.feedback, /practice has ended after six answers/);
  assert.doesNotMatch(state.result.feedback, /\?/);
  assert.notEqual((await f.req("/voice/mobile/answer", { transcript: "seventh", source: "browser", speechCompleted: true }, { token: p.token })).statusCode, 200);
});

test("conversation is server-owned, cumulative, idempotent and isolated between sessions and students", async () => {
  const f = fixture(), p = await f.paired();
  f.deps.evaluate = async input => {
    const allStudentWords = [...input.history.map(turn => turn.transcript), input.transcript].join(" ");
    return { passed: allStudentWords.includes("objects") && allStudentWords.includes("private"),
      feedback: "Now explain private access." };
  };
  const first = { source: "browser", speechCompleted: true, transcript: "S3 stores objects in buckets.",
    language: "en-US", history: [{ transcript: "private access", feedback: "pass" }] };
  await f.req("/voice/mobile/answer", first, { token: p.token });
  await f.run();
  assert.deepEqual(f.calls[0].input.history, []);
  const afterFirst = (await f.req("/voice/mobile/session", undefined, { token: p.token })).data;
  assert.equal(afterFirst.result.passed, false);
  assert.equal(afterFirst.conversation.length, 1);
  assert.equal(afterFirst.attempts, 1);
  assert.equal(afterFirst.maxAttempts, 6);
  assert.equal((await f.req(`/voice/sessions/${p.id}`)).data.conversation, undefined);
  const other = await f.paired();
  assert.deepEqual((await f.req("/voice/mobile/session", undefined, { token: other.token })).data.conversation, []);
  assert.equal((await f.req(`/voice/sessions/${p.id}`, undefined, { owner: "bob@example.com" })).statusCode, 404);
  const followup = { source: "browser", speechCompleted: true, transcript: "Keep it private with IAM.",
    language: "zh-HK" };
  await f.req("/voice/mobile/answer", followup, { token: p.token });
  const job = f.jobs.shift();
  await Promise.all([f.handler(job), f.handler(job)]);
  assert.deepEqual(f.calls[1].input.history, afterFirst.conversation);
  assert.equal(f.calls[1].input.language, "zh-HK");
  assert.equal(f.calls[1].input.transcript, followup.transcript);
  const final = (await f.req("/voice/mobile/session", undefined, { token: p.token })).data;
  assert.equal(final.completed, true);
  assert.equal(final.conversation.length, 2);
  assert.equal(final.conversation[1].language, "zh-HK");
  assert.equal(f.calls.length, 2);
  assert.equal((await f.req("/voice/mobile/answer", followup, { token: p.token })).data.conversation.length, 2);
});

test("browser speech language is validated", async () => {
  const f = fixture(), p = await f.paired();
  assert.equal((await f.req("/voice/mobile/answer", { transcript: "some answer", source: "browser",
    speechCompleted: true, language: "unsupported" }, { token: p.token })).statusCode, 400);
});

test("legacy pending recordings fail safely without invoking transcription or awarding completion", async () => {
  const f = fixture({ readAloud: true }), p = await f.paired(false);
  const hash = digest("legacy recording");
  const session = f.rows.get(f.key(sessionKey(p.id)));
  Object.assign(session, { status: "transcribing", attemptHash: hash, attempts: 1 });
  const attempt = { ...attemptKey(p.id, hash), hash, source: "transcribe", state: "pending", revision: 0 };
  f.rows.set(f.key(attempt), attempt);
  await f.handler({ job: "transcribe", id: p.id, attemptHash: hash });
  assert.equal(f.jobs.length, 0);
  const result = await f.req("/voice/mobile/session", undefined, { token: p.token });
  assert.equal(result.data.status, "ready");
  assert.equal(result.data.result.error, "processing_failed");
  assert.equal(result.data.completed, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.jobs.length, 0);
  await f.req("/voice/mobile/answer", { transcript: "Read this aloud once.", source: "browser", speechCompleted: true }, { token: p.token });
  await f.run();
  assert.equal((await f.req("/voice/mobile/session", undefined, { token: p.token })).data.status, "completed");
});

test("failed workers release session with safe error and no completion", async () => {
  const f = fixture(), p = await f.paired();
  f.deps.evaluate = async () => { throw new Error("secret transcript"); };
  await f.req("/voice/mobile/answer", { transcript: "some spoken answer", source: "browser", speechCompleted: true }, { token: p.token });
  await f.run();
  const result = await f.req("/voice/mobile/session", undefined, { token: p.token });
  assert.equal(result.data.status, "ready");
  assert.equal(result.data.result.error, "processing_failed");
  assert.ok(!result.body.includes("secret"));
  assert.equal(result.data.completed, false);
});

test("origin, no-store, malformed JSON, unknown lesson and capability URL guards", async () => {
  const f = fixture();
  assert.equal((await f.req("/voice/sessions", { serviceId: "__proto__" })).statusCode, 422);
  const result = await f.req("/voice/sessions", { serviceId: "s3" }, { headers: { origin: "https://game.example" } });
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers["Access-Control-Allow-Origin"], "https://game.example");
  assert.equal((await f.req("/voice/sessions", { serviceId: "s3" }, { headers: { origin: "https://evil.example" } })).statusCode, 403);
  assert.equal((await f.req("/voice/mobile/session", undefined, { query: { apiKey: "bad" } })).statusCode, 400);
  assert.equal((await f.req("/voice/mobile/session", undefined, { token: "bad" })).statusCode, 401);
  const malformed = await f.handler({ httpMethod: "POST", path: "/voice/sessions", body: "{", headers: {} });
  assert.equal(malformed.statusCode, 400);
});

test("AgentCore consumes byte streams including split UTF-8, strict JSON/SSE and size limits", async () => {
  const bytes = Buffer.from('{"feedback":"café","verdict":"pass"}');
  const value = await parseAgentResponse({ contentType: "application/json", statusCode: 200,
    response: Readable.from([bytes.subarray(0, 17), bytes.subarray(17)]) });
  assert.equal(value.feedback, "café");
  assert.deepEqual(await parseAgentResponse({ contentType: "text/event-stream",
    response: Readable.from(['data: {"verdict":"retry"}\n\n']) }), { verdict: "retry" });
  await assert.rejects(readBounded(Readable.from(["12345"]), 4));
  await assert.rejects(parseAgentResponse({ response: Readable.from(["not json"]) }));
});

test("canonical ownership requires gateway validation and maps actual key value, not key ID", async () => {
  let lookups = 0;
  const lookup = async key => { lookups++; assert.equal(key, "actual-key-value"); return { Email: "canonical@example.com" }; };
  await assert.rejects(resolveOwner({ headers: { "x-api-key": "actual-key-value" } }, lookup), { status: 401 });
  assert.equal(lookups, 0);
  const owner = await resolveOwner({ requestContext: { identity: { apiKeyId: "gateway-key-id" } },
    headers: { "X-Api-Key": "actual-key-value" }, body: { owner: "attacker" } }, lookup);
  assert.equal(owner, digest("canonical@example.com"));
  await assert.rejects(resolveOwner({ requestContext: { identity: { apiKeyId: "id", apiKey: "unknown" } } },
    async () => undefined), { status: 403 });
});

test("AgentCore invocation forwards only server-owned history, language and the selected rubric", async () => {
  const history = [{ transcript: "EC2 is a virtual server.", feedback: "Who manages the guest OS?" }];
  const selectedQuestion = { id: "ec2", prompt: "Explain EC2.", requiredConcepts: ["virtual servers", "OS control"] };
  const deps = awsDependencies({ VOICE_AGENT_RUNTIME_ARN: "runtime", VOICE_AGENT_QUALIFIER: "live" }, {
    runtime: { async send(command) {
      const payload = JSON.parse(Buffer.from(command.input.payload).toString("utf8"));
      assert.deepEqual(payload, { operation: "evaluate", question: selectedQuestion,
        transcript: "個作業系統係我自己管理。", history, language: "zh-HK" });
      assert.equal(command.input.qualifier, "live");
      return { response: Readable.from(['{"verdict":"retry","feedback":"再講下 security groups。"}']) };
    } },
  });
  assert.deepEqual(await deps.agent("evaluate", { selectedQuestion,
    transcript: "個作業系統係我自己管理。", history, language: "zh-HK", owner: "not-forwarded" }),
  { passed: false, feedback: "再講下 security groups。" });
});

test("AWS dependencies expose no recording upload or transcription capability", () => {
  assert.equal(awsDependencies().audio, undefined);
});

test("concurrent canonical completions award once while completing both sessions", async () => {
  const f = fixture();
  const a = await f.paired(), b = await f.paired();
  for (const p of [a, b]) await f.req("/voice/mobile/answer", {
    transcript: "correct answer", source: "browser", speechCompleted: true,
  }, { token: p.token });
  const jobs = f.jobs.splice(0);
  await Promise.all(jobs.map(job => f.handler(job)));
  assert.equal((await f.req(`/voice/sessions/${a.id}`)).data.status, "completed");
  assert.equal((await f.req(`/voice/sessions/${b.id}`)).data.status, "completed");
  assert.equal([...f.rows.values()].filter(row => row.SK === "COMPLETION#s3").length, 1);
});

test("cancellation during evaluation cannot award completion", async () => {
  const f = fixture(), p = await f.paired();
  await f.req("/voice/mobile/answer", {
    transcript: "correct answer", source: "browser", speechCompleted: true,
  }, { token: p.token });
  await f.req(`/voice/sessions/${p.id}/cancel`, {});
  await f.run();
  assert.equal(await f.deps.store.get(completionKey(digest("alice@example.com"), "s3")), undefined);
  assert.equal(f.calls.length, 0);
});

test("queue failures transition attempts safely and generator failure has bounded retries", async () => {
  const f = fixture(), p = await f.paired();
  f.deps.queueError = true;
  assert.equal((await f.req("/voice/mobile/answer", {
    transcript: "answer", source: "browser", speechCompleted: true,
  }, { token: p.token })).statusCode, 503);
  assert.equal((await f.req("/voice/mobile/session", undefined, { token: p.token })).data.status, "ready");
  const g = fixture(), q = await g.paired(false);
  g.deps.agentError = true;
  for (let i = 0; i < 3; i++) {
    await g.run();
    await g.req("/voice/mobile/session", undefined, { token: q.token });
  }
  assert.equal(g.calls.length, 3);
  assert.equal((await g.req("/voice/mobile/session", undefined, { token: q.token })).data.status, "failed");
  assert.equal(g.jobs.length, 0);
});

test("daily owner budget spans sessions, rejects submission 101 and resets by UTC day", async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) {
    const p = await f.paired();
    const body = { transcript: "correct answer", source: "browser", speechCompleted: true };
    assert.equal((await f.req("/voice/mobile/answer", body, { token: p.token })).statusCode, 200);
    assert.equal((await f.req("/voice/mobile/answer", body, { token: p.token })).statusCode, 200);
    await f.run();
  }
  const p = await f.paired();
  assert.equal((await f.req("/voice/mobile/answer", {
    transcript: "new answer", source: "browser", speechCompleted: true,
  }, { token: p.token })).statusCode, 429);
  assert.equal((await f.deps.store.get(sessionKey(p.id))).attempts, 0);
  const counter = await f.deps.store.get(budgetKey(digest("alice@example.com"), 1700000000));
  assert.equal(counter.count, 100);
  f.advance(86400);
  const next = await f.paired();
  assert.equal((await f.req("/voice/mobile/answer", {
    transcript: "new day", source: "browser", speechCompleted: true,
  }, { token: next.token })).statusCode, 200);
});

test("concurrent sessions cannot exceed daily owner's final reservation", async () => {
  const f = fixture();
  const a = await f.paired(), b = await f.paired();
  await f.deps.store.atomic([{ item: {
    ...budgetKey(digest("alice@example.com"), 1700000000), count: 99, revision: 0,
  } }]);
  const responses = await Promise.all([a, b].map(p => f.req("/voice/mobile/answer", {
    transcript: "correct answer", source: "browser", speechCompleted: true,
  }, { token: p.token })));
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 409]);
  assert.equal((await f.deps.store.get(budgetKey(digest("alice@example.com"), 1700000000))).count, 100);
  assert.equal(f.jobs.length, 1);
});

test("recovery from an interrupted evaluation never invokes AI twice", async () => {
  const f = fixture(), p = await f.paired();
  await f.req("/voice/mobile/answer", {
    transcript: "correct answer", source: "browser", speechCompleted: true,
  }, { token: p.token });
  const s = await f.deps.store.get(sessionKey(p.id));
  const a = await f.deps.store.get(attemptKey(p.id, s.attemptHash));
  await f.deps.store.atomic([{ item: {
    ...a, state: "processing", evaluationStarted: true, leaseUntil: 0, revision: a.revision + 1,
  }, previous: a.revision }]);
  await f.run();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.req(`/voice/sessions/${p.id}`)).data.result.error, "processing_failed");
});

test("approved multi-question bank selects and persists a private question ID without exposing rubric", async () => {
  const f = fixture();
  const questions = ["first", "second", "third"].map(id => ({
    id, prompt: `Explain S3 ${id}.`, requiredConcepts: ["objects"], misconceptions: ["public"],
    acceptableParaphrases: ["object storage"], feedbackGuidance: "Check concepts.",
  }));
  await f.deps.store.atomic([{ item: { ...bankKey("s3", "1"), status: "approved", revision: 0, questions } }]);
  const p = await f.paired(false);
  const state = await f.deps.store.get(sessionKey(p.id));
  assert.ok(questions.some(q => q.id === state.questionId));
  const before = await f.req("/voice/mobile/session", undefined, { token: p.token });
  const after = await f.req("/voice/mobile/session", undefined, { token: p.token });
  assert.equal(before.data.question, state.selectedQuestion.prompt);
  assert.equal(after.data.question, before.data.question);
  for (const field of ["owner", "questionId", "selectedQuestion", "questions", "requiredConcepts", "transcript", "pairingHash", "mobileHash"])
    assert.equal(before.data[field], undefined);
  await f.req("/voice/mobile/answer", { transcript: "correct answer", source: "browser", speechCompleted: true }, { token: p.token });
  await f.run();
  assert.equal(f.calls[0].input.selectedQuestion.id, state.questionId);
  assert.equal((await f.req("/voice/sessions", { serviceId: "unknown-service" })).statusCode, 422);
});
