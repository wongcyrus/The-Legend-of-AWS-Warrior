import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const saveConfig = JSON.parse(readFileSync(new URL("./game-save.json", import.meta.url), "utf8"));
export const gameSaveKey = owner => ({ PK: `PLAYER#${owner}`, SK: "GAME_SAVE" });
export const defaultSave = () => ({
  schemaVersion: 2, checkpoint: "village",
  equipment: { weapon: "Sword", shield: "Shield_Round", finish: "plain", spell: "lightning", level: 1 },
  adventure: { chests: [], boss: false }, missions: [],
});
const object = value => value && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function missionTests(filter) {
  if (typeof filter !== "string" || filter.length > 4000) return [];
  const parts = filter.split("||");
  const names = parts.map(part => /^test=(ProjectTestsLib\.[\w.]+)$/.exec(part)?.[1] ??
    /^test=="(ProjectTestsLib\.[\w.]+)"$/.exec(part)?.[1]);
  return names.length <= 50 && names.every(Boolean) ? names : [];
}

export function normalizeSave(value, fail, { stored = false } = {}) {
  if (!object(value) || ![1, 2].includes(value.schemaVersion)) fail(409, "Unsupported save version; reload the game");
  if (value.schemaVersion === 1) {
    if (!only(value, ["schemaVersion", "checkpoint", "weapon", "shield"])) fail(400, "Invalid saved state");
    value = { ...defaultSave(), checkpoint: value.checkpoint,
      equipment: { ...defaultSave().equipment, weapon: value.weapon, shield: value.shield } };
  }
  if (!only(value, ["schemaVersion", "checkpoint", "equipment", "adventure", "missions"]) ||
      !only(value.equipment, ["weapon", "shield", "finish", "spell", "level"]) ||
      !only(value.adventure, ["chests", "boss"]) || !Array.isArray(value.adventure.chests) ||
      value.adventure.chests.length > saveConfig.chests.length || typeof value.adventure.boss !== "boolean" ||
      !Array.isArray(value.missions) || value.missions.length > 100 ||
      value.missions.some(filter => !missionTests(filter).length))
    fail(400, "Invalid saved state");
  const e = value.equipment;
  if (!saveConfig.weapons.includes(e.weapon) || !saveConfig.shields.includes(e.shield) ||
      !saveConfig.finishes.includes(e.finish) || !saveConfig.spells.includes(e.spell) ||
      !Number.isInteger(e.level) || e.level < 1 || e.level > 3 ||
      value.adventure.chests.some(id => !saveConfig.chests.includes(id)) ||
      (!stored && !saveConfig.maps.includes(value.checkpoint))) fail(400, "Invalid saved equipment or checkpoint");
  return {
    schemaVersion: 2, checkpoint: saveConfig.maps.includes(value.checkpoint) ? value.checkpoint : "village",
    equipment: { weapon: e.weapon, shield: e.shield, finish: e.finish, spell: e.spell, level: e.level },
    adventure: { chests: [...new Set(value.adventure.chests)].sort(), boss: value.adventure.boss },
    missions: [...new Set(value.missions)].sort(),
  };
}

export function createGameSaves({ store, fail, now, passedTestsFor }) {
  const verified = async (state, event) => {
    const tests = new Set(await passedTestsFor(event));
    state.missions = state.missions.filter(filter => missionTests(filter).every(test => tests.has(test)));
    const finish = state.equipment.finish;
    const unlocked = finish === "plain" ||
      (finish === "verdant" && (state.adventure.chests.length > 0 || state.missions.length > 0)) ||
      (finish === "gold" && state.missions.length >= 3) ||
      (finish === "crystal" && (state.missions.length >= 6 || state.adventure.boss));
    if (!unlocked) state.equipment.finish = "plain";
    return state;
  };
  const view = async (row, event) => ({
    revision: row?.revision ?? 0, updatedAt: row?.updatedAt ?? null,
    requestId: row?.requestId ?? null,
    state: await verified(row ? normalizeSave(row.state, fail, { stored: true }) : defaultSave(), event),
  });
  return {
    async get(owner, event) { return view(await store.get(gameSaveKey(owner)), event); },
    async put(owner, body, event) {
      if (!only(body, ["revision", "requestId", "state"]) || !uuid(body.requestId) ||
          !Number.isSafeInteger(body.revision) || body.revision < 0) fail(400, "Invalid save request");
      const state = normalizeSave(body.state, fail);
      const hash = createHash("sha256").update(JSON.stringify({ revision: body.revision, state })).digest("hex");
      const key = gameSaveKey(owner), row = await store.get(key);
      if (row?.requestId === body.requestId) {
        if (row.requestHash !== hash) fail(409, "Save request ID already used");
        return view(row, event);
      }
      if ((row?.revision ?? 0) !== body.revision) fail(409, "Another tab or device saved newer progress; load the latest save");
      // Loading a future-version row must never allow an older client to overwrite it.
      if (row) normalizeSave(row.state, fail, { stored: true });
      const next = { ...key, revision: body.revision + 1, requestId: body.requestId,
        requestHash: hash, updatedAt: now(), state: await verified(state, event) };
      try { await store.atomic([{ item: next, previous: row?.revision }]); }
      catch (error) {
        if (!store.isConflict(error)) throw error;
        const current = await store.get(key);
        if (current?.requestId === body.requestId && current.requestHash === hash) return view(current, event);
        fail(409, "Another tab or device saved newer progress; load the latest save");
      }
      return view(next, event);
    },
  };
}
