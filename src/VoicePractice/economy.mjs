import { activities as authoredActivities, rewardFor } from "./activities.mjs";

export const walletKey = owner => ({ PK: `PLAYER#${owner}`, SK: "WALLET" });
export const activityKey = (owner, id) => ({ PK: `PLAYER#${owner}`, SK: `ACTIVITY#${id}` });
export const gradeKey = (owner, session, hash) => ({ PK: `PLAYER#${owner}`, SK: `GRADE#${session}#${hash}` });
export const castKey = (owner, id) => ({ PK: `PLAYER#${owner}`, SK: `CAST#${id}` });
export const walletView = row => ({
  balance: row?.balance ?? 0, max: 100, earned: row?.earned ?? 0,
  spent: row?.spent ?? 0, revision: row?.revision ?? 0,
});
const cooldowns = { lightning: 6, fireball: 5, frost: 4, storm: 9, shockwave: 2 };
const uuid = value => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function createEconomy({ store, now, fail, completionKey, sessionKey, attemptKey, activities = authoredActivities }) {
  const wallet = async owner => walletView(await store.get(walletKey(owner)));
  const summaries = async (owner, extraActivities = []) => {
    const catalog = [...activities, ...extraActivities];
    const savedRows = store.listActivities ? await store.listActivities(owner) :
      await Promise.all(catalog.map(activity => store.get(activityKey(owner, activity.activityId))));
    const rows = new Map(savedRows.filter(Boolean).map(row => [row.activityId, row]));
    const ids = new Set(catalog.map(activity => activity.activityId));
    for (const row of rows.values()) {
      if (row.type === "question_answer" && !ids.has(row.activityId))
        catalog.push({ ...row, available: false });
    }
    return catalog.map(activity => {
      const saved = rows.get(activity.activityId);
      return { activityId: activity.activityId, serviceId: activity.serviceId, label: activity.label,
        type: activity.type ?? "read_aloud",
        ...(activity.type === "question_answer" ? { title: activity.title, questionId: activity.questionId,
          languages: activity.languages ?? [], available: activity.available !== false } : {}),
        round: activity.round, completed: saved?.completed === true,
        bestScore: saved?.bestScore ?? null, latestScore: saved?.latestScore ?? null,
        feedback: saved?.feedback ?? null, mpAwarded: saved?.mpAwarded ?? 0,
        completedAt: saved?.completedAt ?? null };
    });
  };
  const choose = async (owner, requested) => {
    const unfinished = (await summaries(owner)).filter(a => a.type === "read_aloud" && !a.completed);
    if (!unfinished.length) fail(409, "All authored reading activities are complete. No further MP rewards are available.");
    const round = Math.min(...unfinished.map(a => a.round));
    const eligible = unfinished.filter(a => a.round === round);
    const selected = eligible.find(a => a.serviceId === requested) ?? eligible[0];
    return activities.find(a => a.activityId === selected.activityId);
  };
  const cast = async (owner, body) => {
    if (!uuid(body.requestId) || !Object.hasOwn(cooldowns, body.spell) ||
        !Number.isInteger(body.level) || body.level < 1 || body.level > 3) {
      fail(400, "A UUID requestId, supported spell and level from 1 to 3 are required");
    }
    const key = castKey(owner, body.requestId.toLowerCase());
    for (let retry = 0; retry < 6; retry++) {
      const old = await store.get(key);
      if (old) {
        if (old.spell !== body.spell || old.level !== body.level) fail(409, "requestId was already used with a different spell or level");
        return old.response;
      }
      const before = await store.get(walletKey(owner));
      const current = walletView(before);
      if (current.balance < body.level) fail(409, "Insufficient MP");
      if ((before?.cooldownUntil ?? 0) > now()) fail(409, "Spell cooldown is active; wait before casting again");
      const next = { ...before, ...walletKey(owner), ...current,
        balance: current.balance - body.level, spent: current.spent + body.level,
        revision: current.revision + 1, cooldownUntil: now() + cooldowns[body.spell] };
      const response = { requestId: body.requestId.toLowerCase(), spell: body.spell, level: body.level,
        cost: body.level, cooldownUntil: next.cooldownUntil, wallet: walletView(next) };
      try {
        await store.atomic([{ item: next, previous: before?.revision },
          { item: { ...key, spell: body.spell, level: body.level, response, createdAt: now() } }]);
        return response;
      } catch (e) { if (!store.isConflict(e)) throw e; }
    }
    fail(503, "Wallet is busy; retry the same requestId");
  };
  const finish = async (session, attempt, grade) => {
    // The immutable saved grade survives contention; only crediting is retried.
    for (let retry = 0; retry < 8; retry++) {
      const s = await store.get(sessionKey(session.id));
      const a = await store.get(attemptKey(session.id, attempt.hash));
      if (a?.state === "done" || s?.attemptHash !== attempt.hash || s?.status !== "evaluating" ||
          s.expiresAt <= now()) return;
      const key = activityKey(s.owner, s.activityId);
      const before = await store.get(key);
      const beforeWallet = await store.get(walletKey(s.owner));
      const w = walletView(beforeWallet);
      const firstPass = grade.passed && !before?.completed;
      const type = s.mode === "graded_question_answer" ? "question_answer" : "read_aloud";
      const credited = firstPass ? Math.min(rewardFor(grade.score, type), 100 - w.balance) : 0;
      const result = { ...grade, activityId: s.activityId, ...(type === "question_answer" ? { type } : {}), mpAwarded: credited };
      const activity = { ...before, ...key, activityId: s.activityId, serviceId: s.serviceId,
        type, label: s.serviceLabel ?? s.serviceId,
        ...(type === "question_answer" ? { title: s.questionTitle, questionId: s.questionId, version: s.bankVersion,
          languages: s.languages.map(language => language.id) } : {}),
        round: s.round, revision: (before?.revision ?? -1) + 1,
        completed: Boolean(before?.completed || grade.passed),
        bestScore: Math.max(before?.bestScore ?? 0, grade.score), latestScore: grade.score,
        feedback: grade.feedback, mpAwarded: (before?.mpAwarded ?? 0) + credited,
        ...(firstPass ? { completedAt: now(), rewardClaimed: true, rewardScore: grade.score } : {}) };
      const writes = [
        { item: { ...s, result, status: grade.passed ? "completed" : s.attempts >= 6 ? "failed" : "ready",
          revision: s.revision + 1 }, previous: s.revision },
        { item: { ...a, state: "done", result, revision: a.revision + 1 }, previous: a.revision },
        { item: activity, previous: before?.revision },
        { item: { ...gradeKey(s.owner, s.id, a.hash), activityId: s.activityId, serviceId: s.serviceId,
          type, version: s.bankVersion, result, createdAt: now() } },
      ];
      if (firstPass) writes.push({ item: { ...beforeWallet, ...walletKey(s.owner), ...w,
        balance: w.balance + credited, earned: w.earned + credited, revision: w.revision + 1 },
      previous: beforeWallet?.revision });
      const completion = await store.get(completionKey(s.owner, s.serviceId));
      // Existing ungraded completions are deliberately not rewritten or converted.
      if (type === "read_aloud" && ((!completion && grade.passed) || completion?.mode === "graded_read_aloud")) {
        writes.push({ item: { ...completion, ...completionKey(s.owner, s.serviceId),
          revision: (completion?.revision ?? -1) + 1, mode: "graded_read_aloud",
          serviceId: s.serviceId, verified: Boolean(completion?.verified || grade.passed),
          bestScore: Math.max(completion?.bestScore ?? 0, grade.score), latestScore: grade.score,
          feedback: grade.feedback, mpAwarded: (completion?.mpAwarded ?? 0) + credited,
          ...(grade.passed && !completion?.verified ? { completedAt: now(), sessionId: s.id } : {}) },
        previous: completion?.revision });
      }
      try { await store.atomic(writes); return; }
      catch (e) { if (!store.isConflict(e)) throw e; }
    }
    throw new Error("Grade credit contention");
  };
  return { wallet, summaries, choose, cast, finish };
}
