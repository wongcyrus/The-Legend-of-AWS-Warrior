const ordinary = { health: 80, damage: 6, acceleration: 40, scale: 0.025,
  range: 6, reach: 5.5, windup: 0.8, cooldown: 1.4, hover: 0.35 };

export const MONSTERS = {
  Ghost: { ...ordinary, label: "Ghost" },
  GreenDemon: { ...ordinary, label: "Green demon" },
  Cyclops: { ...ordinary, label: "Cyclops" },
  Skull: { ...ordinary, label: "Skull" },
  Yeti: { ...ordinary, label: "Frostpeak yeti", health: 180, damage: 22,
    acceleration: 20, scale: 0.034, range: 7, reach: 7, windup: 1.3, cooldown: 2 },
  Cactus: { ...ordinary, label: "Sunspire cactus", health: 100, damage: 12,
    acceleration: 0, range: 38, reach: 38, windup: 1, cooldown: 2.4, ranged: true },
  Bat: { ...ordinary, label: "Vault bat", health: 45, damage: 5,
    acceleration: 65, scale: 0.022, windup: 0.5, cooldown: 0.9, hover: 2.2 },
};

export const SUPER_MONSTERS = {
  mountains: { label: "Frostpeak Titan", health: 540, damage: 30, color: 0x7ddaff },
  desert: { label: "Sunspire Overlord", health: 360, damage: 22, color: 0xff9b54 },
  dungeon: { label: "Vault Nightlord", health: 270, damage: 18, color: 0xc98bff },
};

export function superMonsterProfile(name, map) {
  const elite = SUPER_MONSTERS[map];
  if (!elite || !Object.hasOwn(MONSTERS, name)) return null;
  const base = MONSTERS[name];
  return { ...base, ...elite, scale: base.scale * 3.3,
    windup: base.windup + 0.5, cooldown: base.cooldown + 0.3,
    range: base.ranged ? base.range : base.range + 2,
    reach: base.ranged ? base.reach : base.reach + 2 };
}

const rosters = {
  village: ["Ghost", "GreenDemon", "Cyclops", "Skull"],
  mountains: ["Yeti", "Yeti", "Ghost", "Yeti", "Cyclops", "Yeti", "Ghost",
    "Yeti", "Yeti", "Ghost", "Yeti", "Cyclops", "Yeti", "Ghost", "Yeti"],
  desert: ["Cactus", "Skull", "Cactus", "Cactus", "GreenDemon", "Cactus", "Skull",
    "Cactus", "Skull", "Cactus", "Cactus", "GreenDemon", "Cactus", "Skull", "Cactus"],
  dungeon: ["Bat", "Bat", "Ghost", "Bat", "Skull", "Bat", "Ghost",
    "Bat", "Bat", "Ghost", "Bat", "Skull", "Bat", "Ghost", "Bat"],
};

export function monsterFor(map, index) {
  const roster = rosters[map] || rosters.village;
  return roster[index % roster.length];
}

export function monsterAnimations(clips) {
  const find = pattern => clips.find(clip => pattern.test(clip.name));
  const idle = find(/idle/i) || clips[0];
  if (!idle) throw new Error("Monster has no animation clips.");
  return {
    idle,
    walk: find(/walk/i) || find(/fly|run/i) || idle,
    attack: find(/bite_front/i) || find(/attack|punch|bite/i) || idle,
    death: find(/death|die/i) || idle,
  };
}

export function clearShot(from, to, canWalk) {
  const distance = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.max(1, Math.ceil(distance / 0.5));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!canWalk(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t)) return false;
  }
  return true;
}

export class SpikeShots {
  constructor({ spawn = () => {}, remove = () => {} } = {}) {
    this.active = [];
    this.spawn = spawn;
    this.remove = remove;
  }

  fire(from, target, damage, attacker) {
    const length = Math.hypot(target.x - from.x, target.z - from.z);
    if (!length || this.active.length >= 24) return false;
    const dx = (target.x - from.x) / length, dz = (target.z - from.z) / length;
    const shot = { x: from.x + dx * 2, z: from.z + dz * 2,
      vx: dx * 24, vz: dz * 24, remaining: 2, damage, attacker };
    this.active.push(shot);
    this.spawn(shot);
    return true;
  }

  update(dt, { player, canWalk, isSafe, hit }) {
    for (const shot of [...this.active]) {
      let alive = true;
      const time = Math.min(Math.max(dt, 0), shot.remaining);
      const steps = Math.max(1, Math.ceil(time * 24 / 0.4));
      for (let i = 0; i < steps; i++) {
        shot.x += shot.vx * time / steps;
        shot.z += shot.vz * time / steps;
        if (!canWalk(shot.x, shot.z) || isSafe(shot.x, shot.z)) { alive = false; break; }
        if (Math.hypot(shot.x - player.x, shot.z - player.z) < 1.8) {
          hit(shot);
          alive = false;
          break;
        }
      }
      shot.remaining -= time;
      if (!alive || shot.remaining <= 0) {
        this.active.splice(this.active.indexOf(shot), 1);
        this.remove(shot);
      }
    }
  }

  clear() {
    this.active.forEach(shot => this.remove(shot));
    this.active.length = 0;
  }
}
