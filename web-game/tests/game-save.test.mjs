import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GameSave, initialGameSave, safeGameSave } from "../v2/game-save.js";
import { MAPS, isMapWalkable, isSafePosition } from "../v2/maps.js";

const clone = value => structuredClone(value);
function fixture({ storage = new Map(), backend = { revision: 0, state: initialGameSave() }, ...overrides } = {}) {
  const calls = [], restored = [], statuses = [], tasks = new Map();
  let id = 0;
  const options = {
    baseUrl: "https://game.example/Prod/",
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    digest: async key => `hash-${key}`,
    uuid: randomUUID,
    schedule: (callback, delay) => { const task = ++id; tasks.set(task, { callback, delay }); return task; },
    cancel: task => tasks.delete(task),
    restored: state => restored.push(state), changed: save => statuses.push(save.status),
    fetcher: async (url, options) => {
      calls.push({ url: String(url), ...options });
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        if (backend.requestId === body.requestId) return { ok: true, json: async () => clone(backend) };
        if (body.revision !== backend.revision) return { ok: false, status: 409 };
        Object.assign(backend, { revision: body.revision + 1, requestId: body.requestId, state: body.state });
      }
      return { ok: true, json: async () => clone(backend) };
    },
    ...overrides,
  };
  const save = new GameSave(options);
  return { save, calls, restored, statuses, storage, backend, options, tasks };
}
const equip = (weapon = "Axe") => {
  const state = initialGameSave();
  state.equipment.weapon = weapon;
  return state;
};
test("checkpoint schema removes raw positions and unsupported equipment; known spawns are safe", () => {
  const state = safeGameSave({ ...equip(), checkpoint: "missing", position: { x: 9999 } });
  assert.equal(state.checkpoint, "village");
  assert.equal(state.position, undefined);
  for (const map of Object.values(MAPS)) {
    assert.ok(isMapWalkable(map, ...map.spawn));
    assert.ok(isSafePosition(map, ...map.spawn));
  }
  assert.throws(() => safeGameSave({ schemaVersion: 99 }), /Unsupported/);
  const old = safeGameSave({ schemaVersion: 1, checkpoint: "desert", weapon: "Spear", shield: "None" });
  assert.equal(old.equipment.weapon, "Spear");
  assert.equal(old.schemaVersion, 2);
});
test("guest never sends requests; keyed changes are event-driven and credentials are not cached", async () => {
  const f = fixture();
  await f.save.selectAccount(null);
  assert.equal(f.calls.length, 0);
  await f.save.selectAccount("secret-key");
  assert.equal(f.calls.length, 1);
  f.save.update(equip());
  assert.equal(f.calls.length, 1);
  assert.equal(f.save.status, "saving");
  await f.save.flush();
  assert.equal(f.backend.revision, 1);
  assert.equal(f.save.status, "saved");
  assert.ok([...f.storage.values()].every(value => !value.includes("secret-key")));
  assert.equal(f.calls[1].headers["x-api-key"], "secret-key");
  assert.equal(f.calls[1].url, "https://game.example/Prod/game/save");
});
test("offline retries keep one idempotent payload even when the response is lost", async () => {
  const f = fixture();
  await f.save.selectAccount("alice");
  const real = f.save.fetcher;
  let lost = true;
  f.save.fetcher = async (...args) => {
    const result = await real(...args);
    if (lost) { lost = false; throw new Error("offline after commit"); }
    return result;
  };
  f.save.update(equip());
  await f.save.flush();
  assert.equal(f.save.status, "offline");
  const pending = clone(f.save.pending);
  assert.ok([...f.tasks.values()].some(task => task.delay === 2000));
  await f.save.flush();
  assert.equal(f.backend.revision, 1);
  assert.equal(f.save.status, "saved");
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), pending);
});
test("refresh restores pending local changes then acknowledges an already committed request", async () => {
  const f = fixture();
  await f.save.selectAccount("alice");
  const real = f.save.fetcher;
  f.save.fetcher = async (...args) => { await real(...args); throw new Error("lost"); };
  f.save.update(equip("Spear"));
  await f.save.flush();
  const reload = fixture({ storage: f.storage, backend: f.backend });
  await reload.save.selectAccount("alice");
  assert.equal(reload.save.status, "saved");
  assert.equal(reload.save.desired.equipment.weapon, "Spear");
  assert.equal(reload.calls.length, 1);
  assert.equal(reload.save.pending, null);
});
test("reload replays uncommitted recovery, including edits made while offline", async () => {
  const f = fixture();
  await f.save.selectAccount("alice");
  f.save.fetcher = async () => { throw new Error("offline"); };
  f.save.update(equip("Axe")); await f.save.flush();
  f.save.update(equip("Spear"));
  const reload = fixture({ storage: f.storage, backend: f.backend });
  await reload.save.selectAccount("alice");
  await reload.save.flush();
  assert.equal(f.backend.state.equipment.weapon, "Spear");
  assert.equal(f.backend.revision, 2);
});
test("stale device conflicts never silently overwrite; explicit load abandons its draft", async () => {
  const backend = { revision: 0, state: initialGameSave() };
  const a = fixture({ backend }), b = fixture({ backend });
  await a.save.selectAccount("alice"); await b.save.selectAccount("alice");
  a.save.update(equip("Axe")); await a.save.flush();
  b.save.update(equip("Spear"));
  // Use a distinct ID just as real browser UUIDs do.
  b.save.pending.requestId = "00000000-0000-4000-8000-999999999999";
  await b.save.flush();
  assert.equal(b.save.status, "conflict");
  assert.equal(backend.state.equipment.weapon, "Axe");
  const count = b.calls.length;
  await b.save.flush();
  assert.equal(b.calls.length, count);
  await b.save.load({ discard: true });
  assert.equal(b.save.status, "saved");
  assert.equal(b.save.desired.equipment.weapon, "Axe");
});
test("another tab cannot overwrite an unacknowledged local recovery draft", async () => {
  const a = fixture(), b = fixture({ storage: a.storage });
  b.save.writer = "other-tab";
  await a.save.selectAccount("alice"); await b.save.selectAccount("alice");
  a.save.update(equip("Spear"));
  assert.equal(b.save.update(equip()), false);
  assert.equal(b.save.status, "conflict");
  assert.equal(JSON.parse([...a.storage.values()][0]).desired.equipment.weapon, "Spear");
});
test("account change ignores stale GET and POST results and isolates cached recovery", async () => {
  const f = fixture();
  let resolve;
  f.save.fetcher = () => new Promise(done => { resolve = done; });
  const loading = f.save.selectAccount("alice");
  await Promise.resolve(); await Promise.resolve();
  await f.save.selectAccount(null);
  resolve({ ok: true, json: async () => ({ revision: 4, state: equip("Spear") }) });
  await loading;
  assert.equal(f.save.status, "guest");
  assert.equal(f.restored.length, 0);
  f.save.fetcher = f.options.fetcher;
  await f.save.selectAccount("alice");
  f.save.update(equip());
  f.save.fetcher = () => new Promise(done => { resolve = done; });
  const posting = f.save.flush();
  f.save.fetcher = f.options.fetcher;
  await f.save.selectAccount("bob");
  resolve({ ok: true, json: async () => ({ revision: 1, state: equip("Axe") }) });
  await posting;
  assert.equal(f.save.desired.equipment.weapon, "Sword");
  assert.equal(f.save.key, "bob");
  assert.ok(f.storage.has("aws-warrior:v2:game-save:hash-alice"));
});
test("in-flight edits save after acknowledgement without mutating the original request", async () => {
  const f = fixture();
  await f.save.selectAccount("alice");
  const real = f.save.fetcher;
  let finish;
  f.save.fetcher = (...args) => new Promise(resolve => { finish = async () => resolve(await real(...args)); });
  f.save.update(equip());
  const posting = f.save.flush(), original = clone(f.save.pending);
  f.save.update(equip("Spear"));
  assert.deepEqual(f.save.pending, original);
  await finish(); await posting;
  f.save.fetcher = real;
  await f.save.flush();
  assert.equal(f.backend.revision, 2);
  assert.equal(f.backend.state.equipment.weapon, "Spear");
});
test("storage denial does not break cloud saves, auth/version failures never auto-retry", async () => {
  const f = fixture({ storage: new Map() });
  f.save.storage.setItem = () => { throw new Error("quota"); };
  await f.save.selectAccount("alice");
  assert.equal(f.save.cacheUnavailable, true);
  f.save.update(equip()); await f.save.flush();
  assert.equal(f.save.status, "saved");
  for (const status of [401, 403, 409]) {
    const denied = fixture({ fetcher: async () => ({ ok: false, status }) });
    await denied.save.selectAccount("alice");
    assert.equal(denied.save.status, status === 409 ? "conflict" : "blocked");
    assert.equal(denied.tasks.size, 0);
  }
});
test("cached offline startup retries GET instead of claiming an unverified save is current", async () => {
  const f = fixture();
  await f.save.selectAccount("alice");
  f.save.update(equip()); await f.save.flush();
  const reload = fixture({ storage: f.storage, backend: f.backend });
  const real = reload.save.fetcher;
  reload.save.fetcher = async () => { throw new Error("offline"); };
  await reload.save.selectAccount("alice");
  assert.equal(reload.save.status, "offline");
  assert.equal(reload.restored[0].equipment.weapon, "Axe");
  reload.save.fetcher = real;
  await reload.save.flush();
  assert.equal(reload.calls.at(-1).method, "GET");
  assert.equal(reload.save.status, "saved");
});
test("future server and cache versions stop saving and preserve the existing cache", async () => {
  const server = fixture({ backend: { revision: 5, state: { schemaVersion: 99 } } });
  await server.save.selectAccount("alice");
  assert.equal(server.save.status, "conflict");
  assert.equal(server.save.update(equip()), false);
  const storage = new Map([["aws-warrior:v2:game-save:hash-alice", JSON.stringify({
    document: { revision: 5, state: { schemaVersion: 99 } },
  })]]);
  const prior = [...storage.values()][0], f = fixture({ storage });
  await f.save.selectAccount("alice");
  assert.equal(f.save.status, "blocked");
  assert.equal([...storage.values()][0], prior);
  assert.equal(f.calls.length, 0);
});
