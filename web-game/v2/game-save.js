import { WEAPONS, FINISHES } from "./adventure.js";
import { SHIELDS } from "./shields.js";
import { SPELLS } from "./magic.js";
import { MAPS } from "./maps.js";
import { CHESTS } from "./layout.js";

export const initialGameSave = () => ({
  schemaVersion: 2, checkpoint: "village",
  equipment: { weapon: "Sword", shield: "Shield_Round", finish: "plain", spell: "lightning", level: 1 },
  adventure: { chests: [], boss: false }, missions: [],
});
export function safeGameSave(value) {
  if (!value || ![1, 2].includes(value.schemaVersion))
    throw Object.assign(new Error("Unsupported save version. Reload the game."), { status: 409 });
  if (value.schemaVersion === 1) value = { ...initialGameSave(), checkpoint: value.checkpoint,
    equipment: { ...initialGameSave().equipment, weapon: value.weapon, shield: value.shield } };
  const state = initialGameSave(), e = value.equipment ?? {}, a = value.adventure ?? {};
  if (Object.hasOwn(MAPS, value.checkpoint)) state.checkpoint = value.checkpoint;
  for (const [field, choices] of [["weapon", WEAPONS], ["finish", FINISHES], ["spell", SPELLS],
    ["shield", { None: true, ...SHIELDS }]]) {
    if (Object.hasOwn(choices, e[field])) state.equipment[field] = e[field];
  }
  if ([1, 2, 3].includes(e.level)) state.equipment.level = e.level;
  state.adventure.chests = [...new Set((Array.isArray(a.chests) ? a.chests : [])
    .filter(id => CHESTS.some(chest => chest.id === id)))].sort();
  state.adventure.boss = a.boss === true;
  state.missions = [...new Set((Array.isArray(value.missions) ? value.missions : [])
    .filter(filter => typeof filter === "string" && filter.length <= 4000 &&
      filter.split("||").every(part => /^test=(ProjectTestsLib\.[\w.]+)$|^test=="(ProjectTestsLib\.[\w.]+)"$/.test(part))))].sort().slice(0, 100);
  return state;
}
const copy = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class GameSave {
  constructor({ baseUrl, storage = globalThis.localStorage, fetcher = (...args) => fetch(...args),
    changed = () => {}, restored = () => {}, digest = async key => {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
      return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    }, uuid = () => crypto.randomUUID(), schedule = (...args) => setTimeout(...args), cancel = id => clearTimeout(id) } = {}) {
    Object.assign(this, { baseUrl, storage, fetcher, changed, restored, digest, uuid, schedule, cancel });
    this.writer = uuid();
    this.generation = 0;
    this.status = "guest";
    this.retryDelay = 2000;
  }
  notify(status) { this.status = status; this.changed(this); }
  read() {
    try { return JSON.parse(this.storage?.getItem(this.scope)); } catch { return null; }
  }
  persist() {
    const other = this.read();
    if (other?.writer !== this.writer && other?.pending && !same(other, this.recovery)) {
      this.notify("conflict");
      return false;
    }
    try {
      this.storage?.setItem(this.scope, JSON.stringify({ writer: this.writer, document: this.document,
        pending: this.pending, desired: this.desired }));
      this.cacheUnavailable = false;
    } catch { this.cacheUnavailable = true; }
    return true;
  }
  async request(method, key, body) {
    const abort = new AbortController(), timer = this.schedule(() => abort.abort(), 15000);
    try {
      const response = await this.fetcher(new URL("game/save", this.baseUrl), {
        method, headers: { "x-api-key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: abort.signal,
      });
      if (!response.ok) throw Object.assign(new Error("Game save unavailable"), { status: response.status });
      const data = await response.json();
      if (!Number.isSafeInteger(data?.revision) || data.revision < 0) throw Object.assign(new Error("Invalid save"), { status: 400 });
      return { ...data, state: safeGameSave(data.state) };
    } finally { this.cancel(timer); }
  }
  retry() {
    this.cancel(this.timer);
    if (["conflict", "blocked", "guest", "loading"].includes(this.status)) return;
    this.timer = this.schedule(() => {
      if (this.document) this.flush(); else this.load();
    }, this.retryDelay);
    this.retryDelay = Math.min(30000, this.retryDelay * 2);
  }
  fail(error) {
    this.notify(error.status === 409 ? "conflict" :
      (error.status >= 400 && error.status < 500 && error.status !== 429) ? "blocked" : "offline");
    if (this.status === "offline") this.retry();
  }
  async selectAccount(key, seed = initialGameSave()) {
    const generation = ++this.generation;
    this.cancel(this.timer);
    this.key = key; this.scope = null; this.document = null; this.pending = null;
    this.desired = safeGameSave(seed); this.busy = false;
    this.notify(key ? "loading" : "guest");
    if (!key) return;
    let digest;
    try { digest = await this.digest(key); } catch { this.notify("blocked"); return; }
    if (generation !== this.generation) return;
    this.scope = `aws-warrior:v2:game-save:${digest}`;
    const cached = this.read();
    this.recovery = cached;
    try {
      if (Number.isSafeInteger(cached?.document?.revision) && cached.document.revision >= 0) {
        this.document = { ...cached.document, state: safeGameSave(cached.document.state) };
        this.pending = cached.pending ?? null;
        this.desired = safeGameSave(cached.desired ?? this.document.state);
        this.restored(copy(this.desired));
      }
    } catch { this.notify("blocked"); return; }
    await this.load();
  }
  async load({ discard = false } = {}) {
    if (!this.key || this.busy) return;
    this.cancel(this.timer);
    const generation = this.generation, key = this.key;
    this.busy = true;
    this.notify("loading");
    try {
      const remote = await this.request("GET", key);
      if (generation !== this.generation) return;
      if (!discard && this.pending) {
        // A lost POST response can be acknowledged without replaying an older draft.
        if (remote.requestId === this.pending.requestId) {
          const unchanged = same(this.desired, this.pending.state);
          this.pending = null;
          if (unchanged) this.desired = remote.state;
        } else if (remote.revision !== this.pending.revision) {
          this.notify("conflict"); return;
        }
      } else {
        this.pending = null;
        if (remote.revision > 0 || discard) this.desired = remote.state;
      }
      this.document = remote;
      if (discard) {
        // Only the explicit "Load latest save" action abandons a conflicting local draft.
        try { this.storage?.removeItem(this.scope); } catch { /* Saving can continue in memory. */ }
      }
      if (!this.persist()) return;
      this.restored(copy(this.desired));
      this.notify("saved");
      this.retryDelay = 2000;
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    } finally {
      if (generation === this.generation) this.busy = false;
    }
    if (generation === this.generation && this.status === "saved" &&
        (this.pending || !same(this.desired, this.document.state))) await this.flush();
  }
  update(state) {
    if (!this.key || !this.scope || !this.document || ["guest", "loading", "blocked", "conflict"].includes(this.status)) return false;
    this.desired = safeGameSave(state);
    if (!this.pending && this.document && !same(this.desired, this.document.state))
      this.pending = { revision: this.document.revision, requestId: this.uuid(), state: copy(this.desired) };
    if (!this.persist()) return false;
    this.cancel(this.timer);
    this.notify(this.status === "offline" ? "offline" : "saving");
    this.timer = this.schedule(() => this.document ? this.flush() : this.load(), 750);
    return true;
  }
  async flush() {
    if (!this.key || this.busy || !this.document || ["conflict", "blocked", "loading"].includes(this.status)) return;
    if (this.status === "offline" && !this.pending && same(this.desired, this.document.state)) return this.load();
    this.cancel(this.timer);
    if (!this.pending && !same(this.desired, this.document.state))
      this.pending = { revision: this.document.revision, requestId: this.uuid(), state: copy(this.desired) };
    if (!this.pending) { this.notify("saved"); return; }
    if (!this.persist()) return;
    const generation = this.generation, key = this.key, pending = this.pending;
    this.busy = true;
    this.notify("saving");
    try {
      const remote = await this.request("POST", key, pending);
      if (generation !== this.generation) return;
      const unchanged = same(this.desired, pending.state);
      this.document = remote; this.pending = null;
      if (unchanged) this.desired = remote.state;
      if (!this.persist()) return;
      this.retryDelay = 2000;
      this.notify("saved");
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    } finally {
      if (generation === this.generation) this.busy = false;
    }
    if (generation === this.generation && this.status === "saved" && !same(this.desired, this.document.state)) {
      this.timer = this.schedule(() => this.flush(), 750);
    }
  }
}
