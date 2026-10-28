import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateGrade } from "./activities.mjs";
import { createEconomy } from "./economy.mjs";

export const lessons = JSON.parse(readFileSync(new URL("./lessons.json", import.meta.url), "utf8"));
export const digest = value => createHash("sha256").update(value).digest("hex");
export const sessionKey = id => ({ PK: `SESSION#${id}`, SK: "SESSION" });
export const bankKey = (service, version) => ({ PK: `BANK#${service}`, SK: `LESSON#${version}` });
export const attemptKey = (id, hash) => ({ PK: `SESSION#${id}`, SK: `ATTEMPT#${hash}` });
export const completionKey = (owner, service) => ({ PK: `PLAYER#${owner}`, SK: `COMPLETION#${service}` });
export const budgetKey = (owner, seconds) => ({ PK: `PLAYER#${owner}`, SK: `VOICE_DAY#${Math.floor(seconds / 86400)}` });
export const isMeaningfulTranscript = value => {
  if (typeof value !== "string") return false;
  const words = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  const cjk = value.match(/\p{Script=Han}/gu) ?? [];
  if (cjk.length >= 6 && new Set(cjk).size >= 3) return true;
  return words.length >= 2 && words.join("").length >= 8;
};
const languages = new Set(["en-US", "zh-HK"]);
const MAX_ATTEMPTS = 6;
const activeStates = new Set(["ready", "awaiting_question_approval", "generating_question"]);
const uuid = value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const secret = () => randomBytes(32).toString("base64url");
const equal = (value, hash) => typeof value === "string" && value.length <= 256 &&
  typeof hash === "string" && hash.length === 64 && timingSafeEqual(Buffer.from(digest(value)), Buffer.from(hash));
export function validateBank(value) {
  const list = a => Array.isArray(a) && a.length >= 1 && a.length <= 12 &&
    a.every(x => typeof x === "string" && x.trim().length > 0 && x.length <= 500);
  if (!value || typeof value.question !== "string" || !value.question.trim() || value.question.length > 2000 ||
      !list(value.requiredConcepts) || !list(value.misconceptions)) throw new Error("Invalid generated question");
  return { question: value.question, requiredConcepts: value.requiredConcepts, misconceptions: value.misconceptions };
}
export function validateQuestions(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10) throw new Error("Invalid question bank");
  const ids = new Set();
  return value.map(q => {
    if (typeof q.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(q.id) || ids.has(q.id))
      throw new Error("Invalid question ID");
    ids.add(q.id);
    const bank = validateBank({ ...q, question: q.prompt });
    const acceptableParaphrases = q.acceptableParaphrases ?? [];
    if (!Array.isArray(acceptableParaphrases) || acceptableParaphrases.length > 20 ||
        acceptableParaphrases.some(p => typeof p !== "string" || p.length > 500) ||
        (q.feedbackGuidance !== undefined && (typeof q.feedbackGuidance !== "string" || q.feedbackGuidance.length > 2000)))
      throw new Error("Invalid question guidance");
    return { id: q.id, prompt: bank.question, requiredConcepts: bank.requiredConcepts, misconceptions: bank.misconceptions,
      acceptableParaphrases, feedbackGuidance: q.feedbackGuidance ?? "Evaluate conceptual understanding, not exact phrasing." };
  });
}
export function validateResult(value) {
  if (!value || typeof value.passed !== "boolean" || typeof value.feedback !== "string" ||
      !value.feedback.trim() || value.feedback.length > 2000) throw new Error("Invalid evaluation");
  return { passed: value.passed, feedback: value.feedback };
}
export function createService(deps) {
  const { store, ownerFor, enqueue, agent } = deps;
  const now = () => Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const economy = createEconomy({ store, now, fail, completionKey, sessionKey, attemptKey });
  const load = async id => {
    if (!uuid(id)) fail(404, "Session not found");
    const s = await store.get(sessionKey(id));
    if (!s) fail(404, "Session not found");
    if (s.expiresAt <= now()) fail(410, "Session expired");
    if (s.status === "cancelled") fail(410, "Session cancelled");
    return s;
  };
  const save = async (before, changes, extra = []) => {
    const next = { ...before, ...changes, revision: before.revision + 1 };
    await store.atomic([{ item: next, previous: before.revision }, ...extra]);
    return next;
  };
  const ownerSession = async (event, id) => {
    const owner = await ownerFor(event);
    const s = await load(id);
    if (s.owner !== owner) fail(404, "Session not found");
    return s;
  };
  const mobileSession = async event => {
    const header = Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === "authorization")?.[1];
    const match = /^Bearer ([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(header ?? "");
    if (!match) fail(401, "Invalid mobile capability");
    const s = await load(match[1]);
    if (!equal(match[2], s.mobileHash)) fail(401, "Invalid mobile capability");
    return s;
  };
  const completion = s => store.get(completionKey(s.owner, s.serviceId));
  const view = async (s, mobile = false) => ({
    id: s.id, status: s.status, paired: Boolean(s.mobileHash || (s.mode !== "graded_read_aloud" && s.approvedAt)), serviceId: s.serviceId,
    ...(["read_aloud", "graded_read_aloud"].includes(s.mode) ? { mode: s.mode, readingTexts: s.readingTexts } : {}),
    ...(s.mode === "graded_read_aloud" ? {
      activityId: s.activityId, round: s.round, inputDevice: s.inputDevice,
      serviceLabel: lessons[s.serviceId].label, expiresAt: s.expiresAt,
      attempts: s.attempts, maxAttempts: MAX_ATTEMPTS,
      language: s.language ?? "en-US", wallet: await economy.wallet(s.owner),
      resultActivity: { activityId: s.activityId, serviceId: s.serviceId, round: s.round,
        path: "/voice/completions" },
    } : {}),
    ...(mobile ? { serviceLabel: lessons[s.serviceId].label, expiresAt: s.expiresAt,
      ...(s.mode === "graded_read_aloud" ? {} : { conversation: s.conversation ?? [] }), language: s.language ?? "en-US",
      attempts: s.attempts, maxAttempts: MAX_ATTEMPTS } : { pairCode: s.pairCode }),
    ...(s.question ? { question: s.question } : {}), ...(s.result ? { result: s.result } : {}),
    completed: (await completion(s))?.verified === true,
  });
  const ensureQuestion = async s => {
    if (!activeStates.has(s.status) || !s.approvedAt) return s;
    if (["read_aloud", "graded_read_aloud"].includes(s.mode)) {
      return s.status === "ready" ? s : save(s, { status: "ready" });
    }
    const lesson = lessons[s.serviceId];
    const key = bankKey(s.serviceId, lesson.version);
    let bank = await store.get(key);
    if (bank?.status === "approved") {
      if (s.status !== "ready") {
        const questions = validateQuestions(bank.questions);
        const selected = questions[randomInt(questions.length)];
        return save(s, { ...validateBank({ ...selected, question: selected.prompt }),
          questionId: selected.id, selectedQuestion: selected, bankVersion: lesson.version, status: "ready" });
      }
      return s;
    }
    if ((bank?.status === "failed" || (bank?.status === "generating" && bank.lockUntil <= now())) && bank.generationAttempts >= 3)
      return save(s, { status: "failed", result: { passed: false, error: "question_unavailable", feedback: "Question generation is unavailable. Please try again later." } });
    if (!bank || bank.status === "failed" || (bank.status === "generating" && bank.lockUntil <= now())) {
      const lockId = randomUUID();
      const next = { ...key, status: "generating", lockId, lockUntil: now() + 180,
        revision: (bank?.revision ?? -1) + 1, lessonVersion: lesson.version, serviceId: s.serviceId,
        generationAttempts: (bank?.generationAttempts ?? 0) + 1, claimed: false };
      try {
        await store.atomic([{ item: next, previous: bank?.revision }]);
        bank = next;
        try { await enqueue({ job: "generate", serviceId: s.serviceId, version: lesson.version, lockId }); }
        catch {
          await store.atomic([{ item: { ...next, revision: next.revision + 1, status: "failed" }, previous: next.revision }]);
          throw new Error("Worker unavailable");
        }
      } catch (e) { if (!store.isConflict(e)) throw e; bank = await store.get(key); }
    }
    const status = bank?.status === "pending_approval" ? "awaiting_question_approval" : "generating_question";
    return s.status === status ? s : save(s, { status });
  };
  const dispatchAttempt = async (s, a) => {
    try { await enqueue({ job: "evaluate", id: s.id, attemptHash: a.hash }); }
    catch {
      if (!a.grade) await failAttempt(s, a);
      fail(503, "Worker unavailable; please check the result and retry");
    }
  };
  const submit = async (s, transcript, language = "en-US") => {
    if (s.mode !== "graded_read_aloud" && !s.approvedAt) fail(403, "Desktop approval required");
    if (!languages.has(language)) fail(400, "Unsupported speaking language");
    if (s.mode === "graded_read_aloud" && !isMeaningfulTranscript(transcript))
      fail(400, "A meaningful spoken transcript is required");
    const hash = digest(`browser:${transcript}${language !== "en-US" ? `:${language}` : ""}`);
    const old = await store.get(attemptKey(s.id, hash));
    if (s.mode === "graded_read_aloud" && old?.state === "failed" && s.status === "ready") {
      if ((old.processingRetries ?? 0) >= 3) fail(503, "Reading assessment is unavailable; start a new practice later");
      const retry = { ...old, state: "pending", evaluationStarted: false, leaseUntil: 0,
        processingRetries: (old.processingRetries ?? 0) + 1, revision: old.revision + 1 };
      const next = await save(s, { status: "evaluating", attemptHash: hash, result: null,
        workerStarted: now(), lastDispatch: now() }, [{ item: retry, previous: old.revision }]);
      await dispatchAttempt(next, retry);
      return view(next, true);
    }
    if (old) return { ...await view(await load(s.id), true),
      ...(old.state === "done" ? { result: old.result } : {}) };
    if (s.status !== "ready") fail(409, "Session is not ready");
    if (s.attempts >= MAX_ATTEMPTS) fail(429, "Attempt limit reached");
    const key = budgetKey(s.owner, now());
    const budget = await store.get(key);
    if ((budget?.count ?? 0) >= 100) fail(429, "Daily voice practice limit reached; try again tomorrow");
    const reservation = { ...key, count: (budget?.count ?? 0) + 1,
      revision: (budget?.revision ?? -1) + 1, expiresAt: (Math.floor(now() / 86400) + 2) * 86400 };
    const a = { ...attemptKey(s.id, hash), hash, source: "browser", transcript, language, state: "pending",
      revision: 0, expiresAt: s.expiresAt + 86400, createdAt: now() };
    const next = await save(s, { status: "evaluating",
      attemptHash: hash, attempts: s.attempts + 1, language, result: null, workerStarted: now(), lastDispatch: now() },
    [{ item: a }, { item: reservation, previous: budget?.revision }]);
    if (s.mode === "read_aloud") {
      await worker({ job: "evaluate", id: s.id, attemptHash: a.hash });
      return view(await load(s.id), true);
    }
    await dispatchAttempt(next, a);
    return view(next, true);
  };
  const failAttempt = async (s, a) => {
    const fresh = await load(s.id);
    if (fresh.attemptHash !== a.hash || !["evaluating", "transcribing"].includes(fresh.status)) return;
    const current = await store.get(attemptKey(s.id, a.hash));
    if (current?.grade) return;
    await save(fresh, { status: fresh.mode !== "graded_read_aloud" && fresh.attempts >= MAX_ATTEMPTS ? "failed" : "ready",
      result: { passed: false, error: "processing_failed", feedback: "Processing failed. Please read aloud again using browser speech recognition." } },
    [{ item: { ...current, state: "failed", revision: current.revision + 1 }, previous: current.revision }]);
  };
  async function worker(job) {
    if (job.job === "generate") {
      const lesson = lessons[job.serviceId];
      if (!lesson || job.version !== lesson.version) return;
      let bank = await store.get(bankKey(job.serviceId, job.version));
      if (bank?.status !== "generating" || bank.lockId !== job.lockId || bank.lockUntil <= now() || bank.claimed) return;
      try {
        const claimed = { ...bank, claimed: true, revision: bank.revision + 1 };
        await store.atomic([{ item: claimed, previous: bank.revision }]); bank = claimed;
        const generated = validateQuestions((await agent("generate", { lesson: { serviceId: job.serviceId, ...lesson } })).questions);
        await store.atomic([{ item: { ...bank, questions: generated, status: "pending_approval",
          revision: bank.revision + 1 }, previous: bank.revision }]);
      } catch (e) {
        if (!store.isConflict(e)) await store.atomic([{ item: { ...bank, status: "failed",
          revision: bank.revision + 1 }, previous: bank.revision }]);
      }
      return;
    }
    if (job.job !== "evaluate" || !/^[a-f0-9]{64}$/.test(job.attemptHash ?? "")) return;
    let s, a;
    try {
      s = await load(job.id);
      a = await store.get(attemptKey(s.id, job.attemptHash));
      if (!a || s.attemptHash !== a.hash || !["evaluating", "transcribing"].includes(s.status) ||
          ["done", "failed"].includes(a.state) || (!a.grade && (a.leaseUntil ?? 0) > now())) return;
      if (s.mode === "graded_read_aloud" && a.grade) {
        await economy.finish(s, a, validateGrade(a.grade)); return;
      }
      if (a.source !== "browser" || a.evaluationStarted) { await failAttempt(s, a); return; }
      const next = { ...a, state: "processing", leaseUntil: now() + 120, revision: a.revision + 1 };
      await store.atomic([{ item: next, previous: a.revision }]); a = next;
      const transcript = a.transcript;
      if (typeof transcript !== "string" || !transcript.trim() || transcript.length > 6000) throw new Error("Invalid transcript");
      const started = { ...a, evaluationStarted: true, revision: a.revision + 1 };
      await store.atomic([{ item: started, previous: a.revision }]); a = started;
      if (s.mode === "graded_read_aloud") {
        const grade = validateGrade(await agent("grade_reading", {
          activityId: s.activityId, serviceId: s.serviceId, readingTexts: s.readingTexts,
          transcript, language: a.language ?? "en-US",
        }));
        const graded = { ...a, grade, revision: a.revision + 1 };
        await store.atomic([{ item: graded, previous: a.revision }]); a = graded;
        await economy.finish(s, a, grade);
        return;
      }
      const readAloud = s.mode === "read_aloud";
      const result = readAloud ? {
        passed: isMeaningfulTranscript(transcript),
        feedback: isMeaningfulTranscript(transcript)
          ? a.language === "zh-HK"
            ? "多謝你開聲讀出嚟！朗讀練習完成。呢次只記錄參與，唔會評核理解或者逐字比對。"
            : "Thanks for speaking aloud! Read-aloud practice complete. This records participation, not understanding or an exact text match."
          : a.language === "zh-HK"
            ? "未聽到足夠清楚嘅說話，請再朗讀一次。唔使逐字比對。"
            : "Not enough speech was detected. Please read aloud again. No exact text match is required.",
      } : validateResult(await agent("evaluate", { question: s.question,
        selectedQuestion: s.selectedQuestion, language: a.language ?? "en-US",
        history: s.conversation ?? [],
        rubric: { requiredConcepts: s.requiredConcepts, misconceptions: s.misconceptions }, transcript }));
      if (!result.passed && s.attempts >= MAX_ATTEMPTS) {
        result.feedback = a.language === "zh-HK"
          ? readAloud ? "今次練習已結束，未能辨識足夠說話。請搵老師幫手再試；呢次唔會獲得完成徽章。"
            : "今次六次回答已經用完，練習到此結束，未達到全部重點。請同老師一齊重溫對話；呢次唔會獲得完成徽章。"
          : readAloud ? "This practice has ended without detecting enough speech. Ask your teacher for help before trying again. No completion badge was awarded."
            : "This practice has ended after six answers without covering all required concepts. Review the conversation with your teacher. No completion badge was awarded.";
      }
      s = await load(s.id);
      if (s.attemptHash !== a.hash || !["evaluating", "transcribing"].includes(s.status)) return;
      const extras = [{ item: { ...a, state: "done", transcript, result, revision: a.revision + 1 }, previous: a.revision }];
      const conversation = [...(s.conversation ?? []), {
        transcript, feedback: result.feedback, language: a.language ?? "en-US", passed: result.passed,
      }];
      if (result.passed && !(await completion(s))) extras.push({ item: {
        ...completionKey(s.owner, s.serviceId), completedAt: now(), serviceId: s.serviceId,
        lessonVersion: s.bankVersion, sessionId: s.id, verified: true,
        ...(readAloud ? { mode: "read_aloud", comprehensionAssessed: false } : {}),
      } });
      try {
        await save(s, { status: result.passed ? "completed" : s.attempts >= MAX_ATTEMPTS ? "failed" : "ready",
          result, conversation }, extras);
      } catch (e) {
        if (!store.isConflict(e) || !result.passed || !(await completion(s))) throw e;
        await save(s, { status: "completed", result, conversation }, extras.slice(0, 1));
      }
    } catch (e) {
      if (store.isConflict(e) || e.status === 410) return;
      if (s && a && !a.grade) await failAttempt(s, a);
      else if (a?.grade) throw e;
    }
  }
  async function route(event) {
    if (event.job && !event.requestContext) { await worker(event); return; }
    const method = event.httpMethod;
    const path = event.resource?.includes("{") ? event.path : (event.path ?? event.rawPath);
    if (Object.keys(event.queryStringParameters ?? {}).some(k => /key|token/i.test(k))) fail(400, "Credentials are not accepted in URLs");
    let body = {};
    if (event.body) {
      if (event.isBase64Encoded || event.body.length > 10000) fail(400, "Invalid body");
      try { body = JSON.parse(event.body); } catch { fail(400, "Invalid JSON"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "Invalid body");
    }
    if (method === "GET" && path === "/voice/completions") {
      const owner = await ownerFor(event);
      const services = await Promise.all(Object.entries(lessons).map(async ([serviceId, lesson]) => {
        const saved = await store.get(completionKey(owner, serviceId));
        const completed = saved?.verified === true;
        return { serviceId, label: lesson.label, completed, completedAt: completed ? saved.completedAt : null,
          ...(saved?.mode === "graded_read_aloud" ? { bestScore: saved.bestScore, latestScore: saved.latestScore,
            feedback: saved.feedback, mpAwarded: saved.mpAwarded } : {}) };
      }));
      return { services, completed: services.filter(service => service.completed).length, total: services.length,
        wallet: await economy.wallet(owner), activities: await economy.summaries(owner) };
    }
    if (method === "GET" && path === "/voice/wallet") return economy.wallet(await ownerFor(event));
    if (method === "POST" && path === "/voice/casts") return economy.cast(await ownerFor(event), body);
    if (method === "POST" && path === "/voice/sessions") {
      const owner = await ownerFor(event);
      if (typeof body.serviceId !== "string" || !Object.hasOwn(lessons, body.serviceId)) fail(422, "Lesson unavailable");
      const activity = await economy.choose(owner, body.serviceId);
      const id = randomUUID(), pairingToken = secret();
      const s = { ...sessionKey(id), id, owner, serviceId: activity.serviceId, status: "ready",
        mode: "graded_read_aloud", activityId: activity.activityId, round: activity.round, inputDevice: "desktop",
        readingTexts: activity.readingTexts,
        question: activity.readingTexts["en-US"], bankVersion: activity.version,
        pairingHash: digest(pairingToken), pairCode: String(randomInt(100000, 1000000)),
        expiresAt: now() + 1200, pairingExpiresAt: now() + 300, attempts: 0, revision: 0 };
      await store.atomic([{ item: s }]);
      return { ...await view(s), pairingToken };
    }
    if (method === "POST" && path === "/voice/mobile/claim") {
      const s = await load(body.id);
      if (!equal(body.pairingToken, s.pairingHash)) fail(401, "Invalid pairing capability");
      if (s.status !== "pairing") fail(409, "Session already claimed");
      if (s.mode === "graded_read_aloud" && (s.inputDevice !== "phone" || s.pairingExpiresAt <= now()))
        fail(410, "Pairing expired; start a new practice");
      const token = secret();
      const next = await ensureQuestion(await save(s, { status: s.mode === "graded_read_aloud" ? "ready" : "generating_question",
        ...(s.mode === "graded_read_aloud" ? { inputDevice: "phone" } : {}),
        mobileHash: digest(token), pairingHash: null, approvedAt: now(), expiresAt: now() + 1200 }));
      return { ...await view(next, true), mobileToken: `${s.id}.${token}` };
    }
    const desktop = /^\/voice\/sessions\/([a-f0-9-]{36})(?:\/(approve|cancel|answer|transfer))?$/.exec(path ?? "");
    if (desktop) {
      const s = await ownerSession(event, desktop[1]);
      if (method === "GET" && !desktop[2]) return view(await poll(s));
      if (method === "POST" && desktop[2] === "answer") {
        if (s.mode !== "graded_read_aloud" || s.inputDevice !== "desktop") fail(409, "This session is not accepting desktop speech");
        validateSpeech(body);
        return submit(s, body.transcript.trim(), body.language ?? "en-US");
      }
      if (method === "POST" && desktop[2] === "transfer") {
        if (s.mode !== "graded_read_aloud" || s.status !== "ready" || s.inputDevice !== "desktop")
          fail(409, "Only a ready desktop practice can transfer to a phone");
        const pairingToken = secret();
        const next = await save(s, { status: "pairing", inputDevice: "phone", mobileHash: null,
          pairingHash: digest(pairingToken), pairingExpiresAt: now() + 300 });
        return { ...await view(next), pairingToken };
      }
      if (method === "POST" && desktop[2] === "cancel") return view(await save(s, { status: "cancelled", mobileHash: null, pairingHash: null }));
      if (method === "POST" && desktop[2] === "approve") {
        if (s.approvedAt) return view(s);
        if (s.status !== "claimed") fail(409, "No mobile claim to approve");
        return view(await ensureQuestion(await save(s, { approvedAt: now(), expiresAt: now() + 1200, status: "generating_question" })));
      }
    }
    if (path?.startsWith("/voice/mobile/")) {
      let s = await mobileSession(event);
      if (method === "GET" && path === "/voice/mobile/session") {
        s = await poll(s);
        return view(s, true);
      }
      if (method === "POST" && path === "/voice/mobile/answer") {
        if (s.mode === "graded_read_aloud" && s.inputDevice !== "phone") fail(409, "This session is not accepting phone speech");
        validateSpeech(body);
        if (s.mode === "read_aloud" && !isMeaningfulTranscript(body.transcript))
          fail(400, "A meaningful spoken transcript is required");
        return submit(s, body.transcript.trim(), body.language ?? "en-US");
      }
    }
    fail(404, "Route not found");
  }
  function validateSpeech(body) {
    if (body.source !== "browser" || body.speechCompleted !== true ||
        typeof body.transcript !== "string" || !body.transcript.trim() || body.transcript.length > 6000)
      fail(400, "A completed browser speech transcript is required");
  }
  async function poll(session) {
    let s = await ensureQuestion(session);
    if (s.status === "transcribing") {
      const a = await store.get(attemptKey(s.id, s.attemptHash));
      await failAttempt(s, a);
      s = await load(s.id);
    }
    if (s.status === "evaluating") {
      const a = await store.get(attemptKey(s.id, s.attemptHash));
      if (now() - s.workerStarted > 600 && !a.grade) { await failAttempt(s, a); s = await load(s.id); }
      else if (now() - s.lastDispatch >= 4 && (a.leaseUntil ?? 0) <= now()) {
        s = await save(s, { lastDispatch: now() }); await dispatchAttempt(s, a);
      }
    }
    return s;
  }
  return { route, worker };
}
