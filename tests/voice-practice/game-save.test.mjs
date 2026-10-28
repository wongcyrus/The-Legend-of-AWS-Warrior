import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createHandler } from "../../src/VoicePractice/index.mjs";
import { HttpError } from "../../src/VoicePractice/domain.mjs";
import { defaultSave, gameSaveKey, saveConfig, normalizeSave } from "../../src/VoicePractice/game-save.mjs";
import { awsDependencies } from "../../src/VoicePractice/aws.mjs";
import { WEAPONS, FINISHES } from "../../web-game/v2/adventure.js";
import { SHIELDS } from "../../web-game/v2/shields.js";
import { SPELLS } from "../../web-game/v2/magic.js";
import { MAPS } from "../../web-game/v2/maps.js";
import { CHESTS } from "../../web-game/v2/layout.js";

const fail = (status, message) => { throw new HttpError(status, message); };
function fixture() {
  const rows = new Map(), passed = new Map();
  const key = row => `${row.PK}/${row.SK}`;
  const deps = {
    now: () => 1700000000000,
    ownerFor: async event => {
      const owner = event.requestContext?.identity?.apiKeyId;
      if (!owner) fail(401, "API key required");
      return owner;
    },
    passedTestsFor: async event => passed.get(event.requestContext.identity.apiKeyId) ?? [],
    store: {
      get: async id => structuredClone(rows.get(key(id))),
      isConflict: error => error.conflict === true,
      async atomic(writes) {
        for (const { item, previous } of writes) {
          if (rows.get(key(item))?.revision !== previous) throw Object.assign(new Error("conflict"), { conflict: true });
        }
        for (const { item } of writes) rows.set(key(item), structuredClone(item));
      },
    },
  };
  const handler = createHandler(deps);
  const request = (state = defaultSave(), revision = 0) => ({ state, revision, requestId: randomUUID() });
  const req = async (body, owner = "alice", extra = {}) => {
    const response = await handler({ httpMethod: body === undefined ? "GET" : "POST", path: "/game/save",
      requestContext: { identity: { apiKeyId: owner } },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extra });
    return { status: response.statusCode, ...JSON.parse(response.body) };
  };
  return { rows, passed, key, deps, req, request };
}

test("save catalog matches every playable checkpoint and equipment option", () => {
  for (const [field, expected] of [["maps", Object.keys(MAPS)], ["weapons", Object.keys(WEAPONS)],
    ["shields", ["None", ...Object.keys(SHIELDS)]], ["finishes", Object.keys(FINISHES)],
    ["spells", Object.keys(SPELLS)], ["chests", CHESTS.map(chest => chest.id)]]) {
    assert.deepEqual([...saveConfig[field]].sort(), expected.sort());
  }
});
test("first load/save, next revision and cross-account isolation", async () => {
  const f = fixture();
  assert.deepEqual((await f.req()).state, defaultSave());
  const state = defaultSave();
  state.checkpoint = "dungeon"; state.equipment.weapon = "Spear";
  const first = await f.req(f.request(state));
  assert.equal(first.status, 200); assert.equal(first.revision, 1);
  assert.deepEqual((await f.req()).state, state);
  assert.equal((await f.req(f.request(state, 1))).revision, 2);
  assert.equal((await f.req(undefined, "bob")).revision, 0);
  assert.equal((await f.req(undefined, "")).status, 401);
  assert.equal(f.rows.size, 1);
});
test("same-request replay is idempotent, changed payload is rejected", async () => {
  const f = fixture(), request = f.request();
  const first = await f.req(request);
  assert.deepEqual(await f.req(request), first);
  assert.equal((await f.req({ ...request, state: { ...request.state, checkpoint: "desert" } })).status, 409);
  assert.equal(f.rows.size, 1);
});
test("concurrent devices have one winner; old retries cannot overwrite newer saves", async () => {
  const f = fixture(), a = f.request(), b = f.request();
  const results = await Promise.all([f.req(a), f.req(b)]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  const winner = results[0].status === 200 ? a : b;
  assert.equal((await f.req(f.request(defaultSave(), 1))).revision, 2);
  assert.equal((await f.req(winner)).status, 409);
});
test("simultaneous retries of the same request succeed once", async () => {
  const f = fixture(), request = f.request();
  const results = await Promise.all([f.req(request), f.req(request)]);
  assert.ok(results.every(row => row.status === 200 && row.revision === 1));
});
test("save verification cannot award MP, marks, grades, or unearned missions", async () => {
  const f = fixture(), state = defaultSave();
  state.missions = ["test=ProjectTestsLib.S3.Pass", 'test=="ProjectTestsLib.S3.Pass"||test=="ProjectTestsLib.S3.Fail"'];
  state.equipment.finish = "gold";
  f.passed.set("alice", ["ProjectTestsLib.S3.Pass"]);
  const result = await f.req(f.request(state));
  assert.deepEqual(result.state.missions, [state.missions[0]]);
  assert.equal(result.state.equipment.finish, "plain");
  assert.equal(f.rows.size, 1);
  assert.equal([...f.rows.values()][0].SK, "GAME_SAVE");
  f.passed.set("alice", []);
  assert.deepEqual((await f.req()).state.missions, []);
});
test("cosmetic exploration persists but has no server reward side effect", async () => {
  const f = fixture(), state = defaultSave();
  state.adventure = { chests: ["lake-cache", "forest-cache", "lake-cache"], boss: true };
  state.equipment.finish = "crystal";
  const result = await f.req(f.request(state));
  assert.deepEqual(result.state.adventure, { chests: ["forest-cache", "lake-cache"], boss: true });
  assert.equal(result.state.equipment.finish, "crystal");
  assert.equal(f.rows.size, 1);
});
for (const [name, mutate] of Object.entries({
  owner: body => { body.owner = "bob"; },
  balance: body => { body.state.balance = 100; },
  position: body => { body.state.position = { x: 99999 }; },
  unknownMap: body => { body.state.checkpoint = "admin"; },
  weapon: body => { body.state.equipment.weapon = "__proto__"; },
  magicLevel: body => { body.state.equipment.level = 100; },
  chest: body => { body.state.adventure.chests = ["fake"]; },
  boss: body => { body.state.adventure.boss = "true"; },
  queryFilter: body => { body.state.missions = ["test=anything or true"]; },
  tooManyMissions: body => { body.state.missions = Array(101).fill("test=ProjectTestsLib.S3.Pass"); },
  revision: body => { body.revision = -1; },
  fractionalRevision: body => { body.revision = 1.5; },
  requestId: body => { body.requestId = "not-a-uuid"; },
})) test(`save rejects ${name}`, async () => {
  const f = fixture(), body = f.request();
  mutate(body);
  assert.equal((await f.req(body)).status, 400);
  assert.equal(f.rows.size, 0);
});
test("unknown versions are protected, version 1 migrates, removed checkpoints resume at village", async () => {
  const f = fixture(), key = gameSaveKey("alice");
  f.rows.set(f.key(key), { ...key, revision: 3, state: { schemaVersion: 99 } });
  assert.equal((await f.req()).status, 409);
  assert.equal((await f.req(f.request(defaultSave(), 3))).status, 409);
  assert.equal(f.rows.get(f.key(key)).state.schemaVersion, 99);
  const old = { schemaVersion: 1, checkpoint: "mountains", weapon: "Axe", shield: "None" };
  const migrated = normalizeSave(old, fail);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.equipment.weapon, "Axe");
  assert.equal(normalizeSave({ ...migrated, checkpoint: "removed" }, fail, { stored: true }).checkpoint, "village");
  f.rows.set(f.key(key), { ...key, revision: 3, state: old });
  assert.equal((await f.req()).state.schemaVersion, 2);
  assert.equal((await f.req(f.request(migrated, 3))).revision, 4);
});
test("credentials in URLs and oversized bodies remain rejected", async () => {
  const f = fixture();
  assert.equal((await f.req(undefined, "alice", { queryStringParameters: { apiKey: "bad" } })).status, 400);
  assert.equal((await f.req(undefined, "alice", { body: " ".repeat(65537) })).status, 400);
});
test("authoritative passed tests use paginated consistent owner query, excluding zero marks", async () => {
  const require = createRequire(new URL("../../src/VoicePractice/package.json", import.meta.url));
  const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
  const calls = [];
  client.send = async command => {
    calls.push(command.input);
    if (command.constructor.name === "GetCommand") return { Item: { Email: "player@example.com" } };
    return command.input.ExclusiveStartKey ? { Items: [{ Test: "ProjectTestsLib.B", Marks: 2 }] } :
      { Items: [{ Test: "ProjectTestsLib.A", Marks: 1 }, { Test: "ProjectTestsLib.Fail", Marks: 0 }],
        LastEvaluatedKey: { User: "player@example.com", Test: "ProjectTestsLib.A" } };
  };
  const deps = awsDependencies({ VOICE_TABLE: "voice", API_KEY_LOOKUP_TABLE: "keys", PASSED_TEST_TABLE: "passed" },
    { dynamo: client });
  const tests = await deps.passedTestsFor({ requestContext: { identity: { apiKeyId: "id", apiKey: "test-key" } } });
  assert.deepEqual(tests, ["ProjectTestsLib.A", "ProjectTestsLib.B"]);
  assert.ok(calls.slice(1).every(call => call.TableName === "passed" && call.ConsistentRead &&
    call.ExpressionAttributeValues[":user"] === "player@example.com"));
  assert.deepEqual(calls[2].ExclusiveStartKey, { User: "player@example.com", Test: "ProjectTestsLib.A" });
  client.destroy();
});
