export const SPELLS = {
  lightning: { label: "Lightning", color: 0x9bdcff, damage: 320, range: 40, cooldown: 6,
    bestFor: "Distant tough enemies", tradeoff: "Precise aim; each chain bounce halves damage; slower recovery." },
  fireball: { label: "Fireball", color: 0xff893b, damage: 260, range: 36, cooldown: 5,
    bestFor: "Tightly packed groups", tradeoff: "Full damage across the blast, but the projectile takes time and can hit walls." },
  frost: { label: "Frost wave", color: 0x86eeff, damage: 160, range: 18, cooldown: 4,
    bestFor: "Slowing an approaching group", tradeoff: "Longer cone and slow, but lowest damage; enemies behind you are unaffected." },
  storm: { label: "Thunderstorm", color: 0xc3a3ff, damage: 220, range: 15, cooldown: 9,
    bestFor: "Being surrounded by spread-out enemies", tradeoff: "Instant full-circle damage, but the longest cooldown and no crowd control." },
  shockwave: { label: "Shockwave", color: 0xffdc83, damage: 180, range: 10, cooldown: 2,
    bestFor: "Escaping nearby enemies", tradeoff: "Fast recovery and full-circle knockback, but shortest range; walls limit the push." },
};

export function spellDamage(id, level, power) {
  return Math.round(SPELLS[id].damage * power / 50 * level);
}

export function validWallet(wallet) {
  return wallet?.max === 100 &&
    ["balance", "earned", "spent", "revision"].every(name =>
      Number.isSafeInteger(wallet[name]) && wallet[name] >= 0) && wallet.balance <= wallet.max;
}

// Only MP accounting is server-authoritative; combat and its effects still run locally.
export class MagicWallet {
  constructor({ baseUrl, readKey, fetcher = (...args) => globalThis.fetch(...args),
    uuid = () => globalThis.crypto.randomUUID(), changed = () => {} }) {
    Object.assign(this, { baseUrl, readKey, fetcher, uuid, changed });
    this.epoch = 0;
    this.key = "";
    this.reset();
  }
  reset() {
    this.epoch++;
    this.wallet = null;
    this.pending = null;
    this.applied = new Set();
    this.checking = 0;
    this.busy = false;
    this.error = "";
  }
  syncKey() {
    let key = "";
    try { key = this.readKey()?.trim() || ""; } catch { /* Fail closed without a key. */ }
    if (key !== this.key) {
      this.key = key;
      this.reset();
      this.changed();
    }
    return key;
  }
  current(epoch) {
    this.syncKey();
    return epoch === this.epoch;
  }
  accept(wallet) {
    if (!validWallet(wallet)) throw new Error("The server returned an invalid MP wallet. Please retry.");
    if (!this.wallet || wallet.revision >= this.wallet.revision) this.wallet = { ...wallet };
  }
  async request(path, body) {
    return this.fetcher(new URL(path, this.baseUrl), {
      method: body ? "POST" : "GET",
      headers: { "x-api-key": this.key, ...(body ? { "Content-Type": "application/json" } : {}) },
      cache: "no-store", signal: AbortSignal.timeout(20000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async refresh() {
    this.syncKey();
    if (!this.key) { this.error = "Save your API key to load MP."; this.changed(); return false; }
    const epoch = this.epoch, before = this.wallet;
    this.checking++;
    this.error = "";
    this.changed();
    try {
      const response = await this.request("voice/wallet");
      if (!this.current(epoch)) return false;
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403
        ? "Your API key was rejected. Check your key to load MP." : "Could not load MP. Please retry.");
      const wallet = await response.json();
      if (!this.current(epoch)) return false;
      this.accept(wallet);
      return true;
    } catch (error) {
      if (!this.current(epoch)) return false;
      if (this.wallet === before) {
        this.wallet = null;
        this.error = error instanceof TypeError ? "Could not connect to load MP. Please retry." :
          error.name === "TimeoutError" || error.name === "AbortError" ? "MP checking timed out. Please retry." : error.message;
      }
      return false;
    } finally {
      if (this.current(epoch)) { this.checking--; this.changed(); }
    }
  }
  async cast({ spell, level, valid, execute }) {
    this.syncKey();
    if (this.busy || this.checking) return false;
    if (!Object.hasOwn(SPELLS, spell) || !Number.isInteger(level) || level < 1 || level > 3 || !valid()) return false;
    if (!this.key || (!this.wallet && !this.pending)) {
      this.error = "Load your server MP wallet before casting."; this.changed(); return false;
    }
    if (this.pending && (this.pending.spell !== spell || this.pending.level !== level)) {
      this.error = `Retry ${SPELLS[this.pending.spell].label} ${this.pending.level} first to resolve its MP reservation.`;
      this.changed(); return false;
    }
    if (!this.pending && this.wallet.balance < level) {
      this.error = `Need ${level} MP. Complete graded voice activities to earn MP.`; this.changed(); return false;
    }
    const epoch = this.epoch;
    this.busy = true;
    this.error = "";
    this.changed();
    try {
      this.pending ||= { requestId: this.uuid(), spell, level, authorized: false };
      const pending = this.pending;
      if (!pending.authorized) {
        const response = await this.request("voice/casts", {
          requestId: pending.requestId, spell, level,
        });
        if (!this.current(epoch)) return false;
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500) this.pending = null;
          if (response.status === 409) {
            await this.refresh();
            if (!this.current(epoch)) return false;
          }
          throw new Error(response.status === 401 || response.status === 403
            ? "Your API key was rejected. Check your key before casting."
            : response.status === 429 ? "The server cooldown is active. Wait before retrying."
            : response.status === 409 ? "The server rejected this cast: check MP and wait for the shared cooldown before retrying."
            : "MP reservation failed. Retry the same spell and level.");
        }
        const result = await response.json();
        if (!this.current(epoch)) return false;
        if (result.requestId !== pending.requestId || result.spell !== spell ||
            result.level !== level || result.cost !== level) {
          throw new Error("The server returned an invalid cast authorization.");
        }
        this.accept(result.wallet);
        pending.authorized = true;
      }
      if (this.applied.has(pending.requestId)) { this.pending = null; return false; }
      if (!valid()) {
        this.error = "MP reserved. Return to gameplay and retry the same spell and level to cast.";
        return false;
      }
      // Mark before invoking local effects so an exception cannot replay a paid cast.
      this.applied.add(pending.requestId);
      this.pending = null;
      let paid = false;
      return execute(cost => {
        if (paid || cost !== level) return false;
        paid = true;
        return true;
      }) === true;
    } catch (error) {
      if (!this.current(epoch)) return false;
      this.error = this.pending
        ? "MP reservation is unresolved. Retry the same spell and level; its request ID is kept to avoid paying twice."
        : error.message;
      return false;
    } finally {
      if (this.current(epoch)) { this.busy = false; this.changed(); }
    }
  }
}

export class MagicCombat {
  constructor({ targets, canWalk, clear, damage, slow, push, effect, power = () => 50 }) {
    Object.assign(this, { targets, canWalk, clear, damage, slow, push, effect, power });
    this.cooldown = 0;
    this.projectiles = [];
  }
  enemies(from, range) {
    return this.targets().filter(target => Math.hypot(target.x - from.x, target.z - from.z) <= range &&
      this.clear(from, target)).sort((a, b) =>
      Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
  }
  canCast(id, level, origin, direction) {
    const spell = Object.hasOwn(SPELLS, id) ? SPELLS[id] : null;
    const length = Math.hypot(direction?.x, direction?.z);
    if (!spell || !Number.isInteger(level) || level < 1 || level > 3 || this.cooldown > 0 ||
        !length || !Number.isFinite(length) || !Number.isFinite(origin?.x) || !Number.isFinite(origin?.z)) return false;
    return true;
  }
  cast(id, level, origin, direction, pay) {
    if (!this.canCast(id, level, origin, direction) || typeof pay !== "function" || pay(level) !== true) return false;
    const spell = SPELLS[id], length = Math.hypot(direction.x, direction.z);
    const forward = { x: direction.x / length, z: direction.z / length };
    const range = spell.range + (level - 1) * 4, damage = spellDamage(id, level, this.power());
    this.cooldown = spell.cooldown;
    this.effect("cast", origin, { color: spell.color }, level);
    const inFront = target => {
      const dx = target.x - origin.x, dz = target.z - origin.z, distance = Math.hypot(dx, dz);
      return !distance || (dx * forward.x + dz * forward.z) / distance >= (id === "frost" ? 0.5 : 0.94);
    };
    const enemies = this.enemies(origin, range);
    if (id === "fireball") {
      const shot = { x: origin.x, z: origin.z, dx: forward.x, dz: forward.z, remaining: range, level, damage };
      this.projectiles.push(shot);
      this.effect("fireball", shot, null, level);
    } else if (id === "lightning") {
      let target = enemies.find(inFront), from = origin;
      const hit = new Set();
      for (let i = 0; target && i < level; i++) {
        hit.add(target.id);
        this.effect("lightning", from, target, level);
        this.damage(target, Math.round(damage * 0.5 ** i));
        from = target;
        target = this.enemies(from, 8 + level * 2).find(enemy => !hit.has(enemy.id));
      }
      if (!hit.size) this.effect("lightning", origin,
        { x: origin.x + forward.x * range, z: origin.z + forward.z * range }, level);
    } else {
      this.effect(id, origin, { x: forward.x, z: forward.z, range }, level);
      for (const target of enemies.filter(target => id !== "frost" || inFront(target))) {
        if (id === "storm") this.effect("lightning", { x: target.x, z: target.z, y: 20 }, target, level);
        this.damage(target, damage);
        if (id === "frost") this.slow(target, 3 + level);
        if (id === "shockwave") this.push(target, origin, 3 + level * 2);
      }
    }
    return true;
  }
  update(dt) {
    if (!Number.isFinite(dt) || dt < 0) return;
    this.cooldown = Math.max(0, this.cooldown - dt);
    for (const shot of [...this.projectiles]) {
      const distance = Math.min(shot.remaining, dt * 30), steps = Math.max(1, Math.ceil(distance / 0.4));
      let impact = false;
      for (let step = 0; step < steps; step++) {
        const x = shot.x + shot.dx * distance / steps, z = shot.z + shot.dz * distance / steps;
        if (!this.canWalk(x, z)) { impact = true; break; }
        shot.x = x; shot.z = z;
        if (this.targets().some(target => Math.hypot(target.x - x, target.z - z) < 2)) {
          impact = true; break;
        }
      }
      shot.remaining -= distance;
      if (impact || shot.remaining <= 0) {
        for (const target of this.enemies(shot, 4 + shot.level * 2)) this.damage(target, shot.damage);
        this.effect("explosion", shot, null, shot.level);
        this.projectiles.splice(this.projectiles.indexOf(shot), 1);
        shot.done = true;
      }
    }
  }
  clearProjectiles() {
    this.projectiles.forEach(shot => { shot.done = true; });
    this.projectiles.length = 0;
  }
}
