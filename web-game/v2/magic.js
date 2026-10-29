// Keep persisted spell IDs so existing equipment saves remain valid.
export const SPELLS = {
  lightning: { label: "瞬式・事件雷切", englishLabel: "Event-Driven λ", service: "AWS Lambda", color: 0xff9900, cost: 12,
    damage: 320, range: 40, cooldown: 12,
    bestFor: "A distant target and nearby followers", tradeoff: "Aim forward; up to three hits, each bounce halves damage." },
  fireball: { label: "影分身・彈性軍勢", englishLabel: "Auto Scaling Army", service: "EC2 Auto Scaling", color: 0xed7100, cost: 15,
    damage: 180, range: 28, cooldown: 20,
    bestFor: "Sweeping enemies ahead", tradeoff: "Five character shadows advance and attack three times each; walls stop their advance. Each shadow deals its listed damage across three hits." },
  frost: { label: "領域展開・無量儲存", englishLabel: "Domain: Infinite Storage", service: "Amazon S3", color: 0x7aa116, cost: 20,
    damage: 600, range: 16, cooldown: 45,
    bestFor: "Holding a crowded position", tradeoff: "Six-second stationary domain: six pulses and a final burst. Boss slow is reduced." },
  storm: { label: "結界術・私有雲界", englishLabel: "Private Cloud Barrier", service: "Amazon VPC", color: 0x8c4fff, cost: 15,
    damage: 120, range: 12, cooldown: 25,
    bestFor: "Defending a position", tradeoff: "Eight-second ward halves incoming damage inside it and repels each intruder once." },
  shockwave: { label: "終式・跨區復甦", englishLabel: "Cross-Region Recovery", service: "Cross-Region recovery", color: 0x7dffd0, cost: 25,
    damage: 0, range: 0, cooldown: 60,
    bestFor: "Preparing for a dangerous fight", tradeoff: "After a one-second windup, a 12-second anchor catches one hit taking HP to 25% or below, returns you and restores 35% HP." },
};

export function spellDamage(id, level, power) {
  return Math.round(SPELLS[id].damage * power / 50);
}

export function validSpellSelection(ids) {
  return Array.isArray(ids) && ids.length > 0 && ids.length <= 5 &&
    new Set(ids).size === ids.length && ids.every(id => Object.hasOwn(SPELLS, id));
}

export const FULL_RELEASE_RANGE = 128;

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
  async cast({ spell, level, spells, valid, execute }) {
    this.syncKey();
    if (this.busy || this.checking) return false;
    const combined = spells !== undefined;
    const ids = combined ? spells : [spell];
    if (!validSpellSelection(ids) || (!combined &&
        (!Number.isInteger(level) || level < 1 || level > 3)) || !valid()) return false;
    const selection = combined ? { spells: [...ids].sort() } : { spell, level };
    if (!this.key || (!this.wallet && !this.pending)) {
      this.error = "Load your server MP wallet before casting."; this.changed(); return false;
    }
    if (this.pending && (combined ? JSON.stringify(this.pending.spells) !== JSON.stringify(selection.spells) :
      this.pending.spell !== spell || this.pending.level !== level || this.pending.spells)) {
      this.error = "Retry the reserved art selection first to resolve its MP reservation.";
      this.changed(); return false;
    }
    const cost = ids.reduce((sum, id) => sum + SPELLS[id].cost, 0);
    if (!this.pending && this.wallet.balance < cost) {
      this.error = `Need ${cost} MP. Complete graded voice activities to earn MP.`; this.changed(); return false;
    }
    const epoch = this.epoch;
    this.busy = true;
    this.error = "";
    this.changed();
    try {
      this.pending ||= { requestId: this.uuid(), ...selection, authorized: false };
      const pending = this.pending;
      if (!pending.authorized) {
        const response = await this.request("voice/casts", {
          requestId: pending.requestId, ...selection,
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
        if (result.requestId !== pending.requestId || result.cost !== cost ||
            (combined ? JSON.stringify(result.spells) !== JSON.stringify(selection.spells) :
              result.spell !== spell || result.level !== level)) {
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
      return execute(amount => {
        if (paid || amount !== cost) return false;
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
  constructor({ targets, canWalk, clear, damage, slow, push, effect, power = () => 50,
    recover = () => false, defeat = (target, batch) => damage(target, Number.MAX_SAFE_INTEGER, batch),
    waveClear = clear }) {
    Object.assign(this, { targets, canWalk, clear, damage, slow, push, effect, power, recover, defeat, waveClear });
    this.cooldown = 0;
    this.fields = [];
    this.clones = [];
    this.anchor = null;
    this.release = null;
  }
  enemies(from, range, clear = this.clear) {
    return this.targets().filter(target => Math.hypot(target.x - from.x, target.z - from.z) <= range &&
      clear(from, target)).sort((a, b) =>
      Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
  }
  canCast(id, level, origin, direction) {
    const spell = Object.hasOwn(SPELLS, id) ? SPELLS[id] : null;
    const length = Math.hypot(direction?.x, direction?.z);
    if (!spell || !Number.isInteger(level) || level < 1 || level > 3 || this.cooldown > 0 ||
        !length || !Number.isFinite(length) || !Number.isFinite(origin?.x) || !Number.isFinite(origin?.z)) return false;
    return true;
  }
  castCombination(ids, level, origin, direction, pay) {
    if (!validSpellSelection(ids) || !ids.every(id => this.canCast(id, level, origin, direction)) ||
        typeof pay !== "function" || pay(ids.reduce((sum, id) => sum + SPELLS[id].cost, 0)) !== true) return false;
    const batch = {};
    try {
      for (const id of ids) {
        this.cooldown = 0;
        this.cast(id, level, origin, direction, () => true, batch);
      }
      if (Object.keys(SPELLS).every(id => ids.includes(id))) {
        if (this.release) {
          this.release.done = true;
          this.release.waves.forEach(wave => { wave.done = true; });
        }
        this.release = { x: origin.x, z: origin.z, age: 0, strikes: 0, batch, waves: [],
          heading: Math.atan2(direction.x, direction.z) };
        this.effect("release-boundary", this.release, { range: FULL_RELEASE_RANGE, duration: 6, color: SPELLS.storm.color }, 1);
      }
    } finally { this.cooldown = Math.max(...ids.map(id => SPELLS[id].cooldown)); }
    return true;
  }
  cast(id, level, origin, direction, pay, batch = {}) {
    if (!this.canCast(id, level, origin, direction) || typeof pay !== "function" || pay(SPELLS[id].cost) !== true) return false;
    const spell = SPELLS[id], length = Math.hypot(direction.x, direction.z);
    const forward = { x: direction.x / length, z: direction.z / length };
    const range = spell.range, damage = spellDamage(id, level, this.power());
    this.cooldown = spell.cooldown;
    this.effect("cast", origin, { color: spell.color }, level);
    const inFront = target => {
      const dx = target.x - origin.x, dz = target.z - origin.z, distance = Math.hypot(dx, dz);
      return !distance || (dx * forward.x + dz * forward.z) / distance >= 0.5;
    };
    const enemies = this.enemies(origin, range);
    if (id === "fireball") {
      this.clones.forEach(clone => { clone.done = true; });
      this.clones.length = 0;
      for (let index = 0; index < 5; index++) {
        const offset = (index - 2) * 2;
        const spawn = { x: origin.x + forward.z * offset, z: origin.z - forward.x * offset };
        const position = this.canWalk(spawn.x, spawn.z) && this.clear(origin, spawn) ? spawn : origin;
        const clone = { x: position.x, z: position.z, dx: forward.x, dz: forward.z,
          age: 0, strikes: 0, damage, batch };
        this.clones.push(clone);
        this.effect("clone", clone, { duration: 3.2 }, 1);
      }
    } else if (id === "lightning") {
      let target = enemies.find(inFront), from = origin;
      const hit = new Set();
      for (let i = 0; target && i < 3; i++) {
        hit.add(target.id);
        this.effect("lightning", from, target, level);
        this.damage(target, Math.round(damage * 0.5 ** i), batch);
        from = target;
        target = this.enemies(from, 12).find(enemy => !hit.has(enemy.id));
      }
      if (!hit.size) this.effect("lightning", origin,
        { x: origin.x + forward.x * range, z: origin.z + forward.z * range }, level);
    } else if (id === "shockwave") {
      if (this.anchor) this.anchor.done = true;
      this.anchor = { x: origin.x, z: origin.z, age: 0 };
      this.effect("anchor", this.anchor, { range: 3, duration: 13 }, 1);
    } else {
      for (const previous of this.fields.filter(field => field.id === id)) previous.done = true;
      this.fields = this.fields.filter(field => field.id !== id);
      const field = { id, x: origin.x, z: origin.z, age: 0, pulse: 0, damage, hit: new Set(), batch };
      this.fields.push(field);
      this.effect(id === "frost" ? "domain" : "ward", field, { range, duration: id === "frost" ? 6 : 8 }, 1);
    }
    return true;
  }
  update(dt) {
    if (!Number.isFinite(dt) || dt < 0) return;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.release) {
      const release = this.release;
      release.age += dt;
      while (release.strikes < 3 && release.age + 1e-8 >= 0.7 + release.strikes * 1.6) {
        const wave = { x: release.x, z: release.z, startedAt: 0.7 + release.strikes * 1.6,
          age: 0, radius: 0, hit: new Set() };
        release.waves.push(wave);
        release.strikes++;
        for (let i = 0; i < 4; i++) this.effect("release-wave", wave, {
          range: FULL_RELEASE_RANGE, heading: release.heading + i * Math.PI / 2,
          color: i % 2 ? SPELLS.storm.color : SPELLS.lightning.color, duration: 1.4,
        }, 1);
      }
      for (const wave of release.waves) {
        if (wave.done) continue;
        const previousRadius = wave.radius;
        wave.age = Math.max(0, release.age - wave.startedAt);
        wave.radius = FULL_RELEASE_RANGE * Math.min(1, wave.age / 1.2);
        for (const target of this.enemies(wave, wave.radius, this.waveClear)) {
          if (wave.hit.has(target.id) || Math.hypot(target.x - wave.x, target.z - wave.z) < previousRadius * 0.88) continue;
          wave.hit.add(target.id);
          this.defeat(target, release.batch);
        }
        if (wave.age >= 1.4) wave.done = true;
      }
      if (release.strikes === 3 && release.waves.every(wave => wave.done)) {
        release.done = true;
        this.release = null;
      }
    }
    for (const clone of [...this.clones]) {
      let remaining = Math.min(dt, 3.2 - clone.age);
      while (remaining > 0) {
        const step = Math.min(remaining, 0.05);
        remaining -= step;
        clone.age += step;
        const next = { x: clone.x + clone.dx * step * 7, z: clone.z + clone.dz * step * 7 };
        if (this.canWalk(next.x, next.z) && this.clear(clone, next)) {
          clone.x = next.x; clone.z = next.z;
        }
        if (clone.strikes < 3 && clone.age + 1e-8 >= 0.9 + clone.strikes * 0.8) {
          clone.strikes++;
          const target = this.enemies(clone, 4).find(target => {
            const dx = target.x - clone.x, dz = target.z - clone.z;
            return dx * clone.dx + dz * clone.dz >= -0.5;
          });
          this.effect("seal", clone, { color: SPELLS.fireball.color, range: 3 }, 1);
          if (target) this.damage(target, Math.round(clone.damage / 3), clone.batch);
        }
      }
      if (clone.age < 3.2 - 1e-8) continue;
      clone.done = true;
      this.clones.splice(this.clones.indexOf(clone), 1);
    }
    for (const field of [...this.fields]) {
      field.age += dt;
      const targets = this.enemies(field, SPELLS[field.id].range);
      if (field.id === "frost") {
        const pulses = Math.min(6, Math.floor(field.age));
        while (field.pulse < pulses) {
          field.pulse++;
          for (const target of targets) {
            this.damage(target, Math.round(field.damage / 10), field.batch);
            this.slow(target, target.boss ? 0.25 : 1.2);
          }
        }
        if (field.age >= 6) {
          for (const target of targets) this.damage(target, Math.round(field.damage * 0.4), field.batch);
          this.effect("seal", field, { range: SPELLS.frost.range, color: SPELLS.frost.color }, 1);
        }
      } else {
        for (const target of targets) {
          if (field.hit.has(target.id)) continue;
          field.hit.add(target.id);
          this.damage(target, field.damage, field.batch);
          this.push(target, field, target.boss ? 1 : 6);
        }
      }
      if (field.age >= (field.id === "frost" ? 6 : 8)) {
        field.done = true;
        this.fields.splice(this.fields.indexOf(field), 1);
      }
    }
    if (this.anchor && (this.anchor.age += dt) >= 13) {
      this.anchor.done = true;
      this.anchor = null;
    }
  }
  incomingDamage(value, position, health, maxHealth) {
    if (this.fields.some(field => field.id === "storm" && field.age < 8 &&
        Math.hypot(position.x - field.x, position.z - field.z) <= SPELLS.storm.range &&
        this.clear(field, position))) value = Math.ceil(value / 2);
    const anchor = this.anchor;
    if (anchor && anchor.age >= 1 && anchor.age < 13 && health - value <= maxHealth * 0.25 &&
        this.canWalk(anchor.x, anchor.z) && this.recover(anchor, maxHealth * 0.35)) {
      this.anchor = null;
      anchor.done = true;
      this.effect("recall", anchor, { range: 6, color: SPELLS.shockwave.color }, 1);
      return 0;
    }
    return value;
  }
  clearProjectiles() {
    if (this.release) {
      this.release.done = true;
      this.release.waves.forEach(wave => { wave.done = true; });
    }
    this.release = null;
    if (this.anchor) this.anchor.done = true;
    this.fields.forEach(field => { field.done = true; });
    this.clones.forEach(clone => { clone.done = true; });
    this.fields.length = 0;
    this.clones.length = 0;
    this.anchor = null;
  }
}
