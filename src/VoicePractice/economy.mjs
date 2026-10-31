import { activities as authoredActivities, rewardFor } from "./activities.mjs";

export const walletKey = owner => ({ PK: `PLAYER#${owner}`, SK: "WALLET" });
export const activityKey = (owner, id) => ({ PK: `PLAYER#${owner}`, SK: `ACTIVITY#${id}` });
export const VOICE_TASK_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
export const taskAvailableAt = row => row?.completed
  ? (row.lastPassedAt ?? row.completedAt ?? 0) + VOICE_TASK_COOLDOWN_SECONDS : 0;
export const gradeKey = (owner, session, hash) => ({ PK: `PLAYER#${owner}`, SK: `GRADE#${session}#${hash}` });
export const castKey = (owner, id) => ({ PK: `PLAYER#${owner}`, SK: `CAST#${id}` });
export const walletView = row => ({
  balance: row?.balance ?? 0, max: 100, earned: row?.earned ?? 0,
  spent: row?.spent ?? 0, revision: row?.revision ?? 0,
});
// IDs remain compatible with existing equipment saves; levels no longer alter cloud arts.
const arts = {
  lightning: { cost: 12, cooldown: 12 }, fireball: { cost: 15, cooldown: 20 },
  frost: { cost: 20, cooldown: 45 }, storm: { cost: 15, cooldown: 25 },
  shockwave: { cost: 25, cooldown: 60 },
};
const uuid = value => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function createEconomy({ store, now, fail, completionKey, sessionKey, attemptKey, activities = authoredActivities }) {
  const wallet = async owner => walletView(await store.get(walletKey(owner)));
  const servicePrefix = serviceId =>
    activities.filter(a => a.serviceId === serviceId).every(a => a.activityId.startsWith(`${serviceId}-`))
      ? `${serviceId}-` : "";
  const savedActivities = (owner, prefix = "") => store.listActivities ? store.listActivities(owner, prefix) :
    Promise.all(activities.filter(a => !prefix || a.activityId.startsWith(prefix))
      .map(activity => store.get(activityKey(owner, activity.activityId))));
  const readingCooldowns = rows => {
    const cooldowns = new Map();
    for (const row of rows.filter(Boolean)) {
      if (row.type === "question_answer") continue;
      cooldowns.set(row.serviceId, Math.max(cooldowns.get(row.serviceId) ?? 0, taskAvailableAt(row)));
    }
    return cooldowns;
  };
  const readingAvailableAt = async (owner, serviceId) =>
    readingCooldowns(await savedActivities(owner, servicePrefix(serviceId))).get(serviceId) ?? 0;
  const summaries = async (owner, extraActivities = [], preloadedRows) => {
    const probes = [...activities, ...extraActivities];
    const savedRows = preloadedRows ?? (store.listActivities ? await store.listActivities(owner) :
      await Promise.all(probes.map(activity => store.get(activityKey(owner, activity.activityId)))));
    const rows = new Map(savedRows.filter(Boolean).map(row => [row.activityId, row]));
    const readingLocks = readingCooldowns(savedRows);
    const qaByService = new Map();
    for (const activity of extraActivities) {
      if (activity.type !== "question_answer") continue;
      const group = qaByService.get(activity.serviceId) ?? {
        label: activity.label, approved: [], attempted: [], unattempted: [],
      };
      group.approved.push(activity);
      if (rows.has(activity.activityId)) group.attempted.push(activity);
      else group.unattempted.push(activity);
      qaByService.set(activity.serviceId, group);
    }
    const catalog = [...activities];
    const qaCounts = new Map();
    for (const [serviceId, group] of qaByService) {
      const hasInProgress = group.attempted.some(a => !rows.get(a.activityId)?.completed);
      const totalCount = group.approved.length;
      const completedCount = group.approved.filter(a => rows.get(a.activityId)?.completed === true).length;
      const availableCount = group.unattempted.length +
        group.attempted.filter(a => taskAvailableAt(rows.get(a.activityId)) <= now()).length;
      const exhausted = totalCount > 0 && group.unattempted.length === 0 && completedCount === totalCount;
      qaCounts.set(serviceId, { availableCount, completedCount, totalCount, exhausted });
      for (const activity of group.attempted) {
        catalog.push({ ...activity, availableCount, completedCount, totalCount, exhausted });
      }
      if (group.unattempted.length > 0 && !hasInProgress) {
        catalog.push({
          activityId: `qa:${serviceId}`,
          serviceId,
          label: group.label,
          type: "question_answer",
          languages: [...new Set(group.unattempted.flatMap(a => a.languages ?? []))],
          available: true,
          availableCount,
          completedCount,
          totalCount,
          exhausted: false,
          round: 1,
        });
      }
    }
    const ids = new Set(catalog.map(activity => activity.activityId));
    for (const row of rows.values()) {
      if (row.type === "question_answer" && !ids.has(row.activityId)) {
        const counts = qaCounts.get(row.serviceId) ?? {
          availableCount: 0, completedCount: row.completed ? 1 : 0, totalCount: 1, exhausted: row.completed === true,
        };
        catalog.push({ ...row, available: false, ...counts });
      }
    }
    return catalog.map(activity => {
      const saved = rows.get(activity.activityId);
      const availableAt = activity.type === "question_answer" ? taskAvailableAt(saved)
        : readingLocks.get(activity.serviceId) ?? 0;
      return { activityId: activity.activityId, serviceId: activity.serviceId, label: activity.label,
        type: activity.type ?? "read_aloud",
        ...(activity.type === "question_answer" ? {
          ...(activity.title !== undefined ? { title: activity.title } : {}),
          ...(activity.questionId !== undefined ? { questionId: activity.questionId } : {}),
          languages: activity.languages ?? [], available: activity.available !== false,
          availableCount: activity.availableCount ?? 0,
          completedCount: activity.completedCount ?? (saved?.completed ? 1 : 0),
          totalCount: activity.totalCount ?? 1,
          exhausted: Boolean(activity.exhausted),
        } : {}),
        round: activity.round, completed: saved?.completed === true,
        bestScore: saved?.bestScore ?? null, latestScore: saved?.latestScore ?? null,
        feedback: saved?.feedback ?? null, mpAwarded: saved?.mpAwarded ?? 0,
        completedAt: saved?.completedAt ?? null,
        availableAt, onCooldown: availableAt > now() };
    });
  };
  const choose = async (owner, requested) => {
    const savedRows = await savedActivities(owner, servicePrefix(requested));
    const readingUnlockAt = readingCooldowns(savedRows).get(requested) ?? 0;
    const serviceTasks = activities.filter(a => (a.type ?? "read_aloud") === "read_aloud" && a.serviceId === requested);
    if (!serviceTasks.length || readingUnlockAt > now()) fail(409, `All reading tasks for this service are on a one-week cooldown. Available again ${new Date(readingUnlockAt * 1000).toISOString()}. Return to the game to discover another service.`);
    const rows = new Map(savedRows.filter(Boolean).map(row => [row.activityId, row]));
    const unfinished = serviceTasks.map(a => ({ ...a, completed: rows.get(a.activityId)?.completed === true }));
    unfinished.sort((a, b) => Number(a.completed) - Number(b.completed));
    const pending = unfinished.filter(a => a.completed === unfinished[0].completed);
    const round = Math.min(...pending.map(a => a.round));
    const eligible = pending.filter(a => a.round === round);
    const selected = eligible[0];
    return activities.find(a => a.activityId === selected.activityId);
  };
  const cast = async (owner, body) => {
    const combined = body.spells !== undefined;
    const spells = combined ? body.spells : [body.spell];
    if (!uuid(body.requestId) || !Array.isArray(spells) || spells.length < 1 || spells.length > 5 ||
        new Set(spells).size !== spells.length || spells.some(spell => !Object.hasOwn(arts, spell)) ||
        (combined ? body.spell !== undefined || body.level !== undefined :
          !Number.isInteger(body.level) || body.level < 1 || body.level > 3)) {
      fail(400, "Supply a UUID requestId and 1-5 unique supported spells, or a single spell with level 1-3");
    }
    const ids = [...spells].sort();
    const selection = combined ? { spells: ids } : { spell: body.spell, level: body.level };
    const key = castKey(owner, body.requestId.toLowerCase());
    const cost = ids.reduce((sum, id) => sum + arts[id].cost, 0);
    const cooldown = Math.max(...ids.map(id => arts[id].cooldown));
    for (let retry = 0; retry < 6; retry++) {
      const old = await store.get(key);
      if (old) {
        if (combined ? JSON.stringify(old.spells) !== JSON.stringify(ids) :
          old.spell !== body.spell || old.level !== body.level || old.spells)
          fail(409, "requestId was already used with a different spell selection");
        return old.response;
      }
      const before = await store.get(walletKey(owner));
      const current = walletView(before);
      if (current.balance < cost) fail(409, "Insufficient MP");
      if ((before?.cooldownUntil ?? 0) > now()) fail(409, "Spell cooldown is active; wait before casting again");
      const next = { ...before, ...walletKey(owner), ...current,
        balance: current.balance - cost, spent: current.spent + cost,
        revision: current.revision + 1, cooldownUntil: now() + cooldown };
      const response = { requestId: body.requestId.toLowerCase(), ...selection,
        cost, cooldownUntil: next.cooldownUntil, wallet: walletView(next) };
      try {
        await store.atomic([{ item: next, previous: before?.revision },
          { item: { ...key, ...selection, response, createdAt: now() } }]);
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
        ...(grade.passed ? { lastPassedAt: now() } : {}),
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
  return { wallet, summaries, choose, cast, finish, readingAvailableAt };
}
