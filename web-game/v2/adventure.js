export const WEAPONS = {
  Sword: { damage: 1.2, speed: 1.35, label: "Sword", style: "fast" },
  Axe: { damage: 2.2, speed: 0.8, label: "Axe", style: "heavy" },
  Unarmed: { damage: 0.6, speed: 1.55, label: "Unarmed", style: "light" },
  Sword_2: { damage: 1.3, speed: 1.2, label: "Knight sword", style: "balanced" },
  Sword_Golden: { damage: 1.2, speed: 1.35, label: "Golden sword", style: "fast" },
  Sword_Big: { damage: 2.4, speed: 0.7, reach: 6.5, label: "Greatsword", style: "heavy", sound: "axe" },
  Claymore: { damage: 2.6, speed: 0.65, reach: 7, label: "Claymore", style: "heavy", sound: "axe" },
  Dagger: { damage: 0.9, speed: 1.9, reach: 4.5, label: "Dagger", style: "quick" },
  Dagger_2: { damage: 1, speed: 1.75, reach: 4.5, label: "Curved dagger", style: "quick" },
  Axe_Small: { damage: 1.5, speed: 1.3, label: "Hatchet", style: "fast", sound: "axe" },
  Axe_Double: { damage: 2.8, speed: 0.6, reach: 6, label: "Double axe", style: "heavy", sound: "axe" },
  Hammer_Small: { damage: 1.8, speed: 1.05, label: "War hammer", style: "balanced", sound: "hammer" },
  Hammer_Double: { damage: 3, speed: 0.55, reach: 6, label: "Double hammer", style: "heavy", sound: "hammer" },
  Spear: { damage: 1.6, speed: 1.05, reach: 8.5, label: "Spear", style: "long reach" },
  Scythe: { damage: 2, speed: 0.85, reach: 6.5, label: "Scythe", style: "long reach" },
};
export const FINISHES = {
  plain: { label: "Original", color: null },
  verdant: { label: "Forest emerald", color: 0x78d99a },
  gold: { label: "Cloudhaven gold", color: 0xffd16a },
  crystal: { label: "Warden crystal", color: 0x86dfff },
};

const empty = reset => ({ reset, passed: [], chests: [], boss: false, finish: "plain" });

export class AdventureProgress {
  constructor({ storage = globalThis.localStorage, digest = async key => {
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
  } } = {}) {
    this.storage = storage;
    this.digest = digest;
    this.version = 0;
    this.scope = null;
    this.data = empty(null);
  }

  async selectAccount(key, reset = null) {
    const version = ++this.version;
    this.scope = null;
    this.data = empty(reset);
    let owner;
    try { owner = key ? await this.digest(key) : "guest"; } catch {
      return version === this.version;
    }
    if (version !== this.version) return false;
    this.scope = "aws-warrior:v2:adventure:" + owner;
    let saved;
    try { saved = JSON.parse(this.storage?.getItem(this.scope)); } catch { /* Start a fresh local adventure. */ }
    let resetOwner;
    try { resetOwner = JSON.parse(reset)?.owner; } catch { /* Older reset markers are timestamps. */ }
    if (resetOwner && resetOwner !== owner) reset = saved?.reset ?? null;
    this.data = saved?.reset === reset ? {
      reset,
      passed: [...new Set((Array.isArray(saved.passed) ? saved.passed : []).filter(v => typeof v === "string"))],
      chests: [...new Set((Array.isArray(saved.chests) ? saved.chests : []).filter(v => typeof v === "string"))],
      boss: saved.boss === true,
      finish: Object.hasOwn(FINISHES, saved.finish) ? saved.finish : "plain",
    } : empty(reset);
    if (!this.unlocked(this.data.finish)) this.data.finish = "plain";
    this.save();
    return true;
  }

  save() {
    if (!this.scope) return;
    try { this.storage?.setItem(this.scope, JSON.stringify(this.data)); } catch { /* Rewards still work for this session. */ }
  }

  pass(filter) {
    if (!filter || this.data.passed.includes(filter)) return false;
    this.data.passed.push(filter);
    this.save();
    return true;
  }

  openChest(id) {
    if (!id || this.data.chests.includes(id)) return false;
    this.data.chests.push(id);
    this.save();
    return true;
  }

  defeatBoss() {
    if (this.data.boss) return false;
    this.data.boss = true;
    this.save();
    return true;
  }

  unlocked(finish) {
    return finish === "plain" ||
      (finish === "verdant" && (this.data.chests.length > 0 || this.data.passed.length > 0)) ||
      (finish === "gold" && this.data.passed.length >= 3) ||
      (finish === "crystal" && (this.data.passed.length >= 6 || this.data.boss));
  }

  selectFinish(finish) {
    if (!Object.hasOwn(FINISHES, finish) || !this.unlocked(finish)) return false;
    this.data.finish = finish;
    this.save();
    return true;
  }
}

export class DodgeMotion {
  constructor() { this.remaining = 0; this.cooldown = 0; this.direction = { x: 0, z: 0 }; }
  get active() { return this.remaining > 0; }

  start(direction) {
    const length = Math.hypot(direction.x, direction.z);
    if (this.cooldown > 0 || !Number.isFinite(length) || length === 0) return false;
    this.direction = { x: direction.x / length, z: direction.z / length };
    this.remaining = 0.25;
    this.cooldown = 1.8;
    return true;
  }

  update(dt, position, canStep) {
    const time = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.1));
    this.cooldown = Math.max(0, this.cooldown - time);
    const distance = Math.min(this.remaining, time) * 28;
    this.remaining = Math.max(0, this.remaining - time);
    let { x, z } = position;
    for (let travelled = 0; travelled < distance;) {
      const step = Math.min(0.4, distance - travelled);
      const nextX = x + this.direction.x * step, nextZ = z + this.direction.z * step;
      if (!canStep(nextX, nextZ, { x, z })) break;
      x = nextX; z = nextZ;
      travelled += step;
    }
    return { x, z };
  }
}
