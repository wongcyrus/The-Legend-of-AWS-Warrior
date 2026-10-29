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
  Tree: { ...ordinary, label: "Whispering treant", health: 145, damage: 13,
    acceleration: 26, scale: 0.03, range: 6.5, reach: 6.2, windup: 1, cooldown: 1.7 },
  Crab: { ...ordinary, label: "Mirrorwater crab", health: 110, damage: 9,
    acceleration: 35, scale: 0.025, windup: 0.75, cooldown: 1.3 },
  Bee: { ...ordinary, label: "Cloud hornet", health: 55, damage: 7,
    acceleration: 60, scale: 0.022, windup: 0.55, cooldown: 1, hover: 2 },
  Demon: { ...ordinary, label: "Crimson demon", health: 130, damage: 15,
    acceleration: 42, scale: 0.028, range: 6.5, reach: 6, windup: 0.85, cooldown: 1.5 },
  YellowDragon: { ...ordinary, label: "Sunspire wyvern", health: 160, damage: 17,
    acceleration: 46, scale: 0.028, range: 6.5, reach: 6.2, windup: 0.9, cooldown: 1.6, hover: 1.8 },
  Alien: { ...ordinary, label: "Void stalker", health: 95, damage: 11,
    acceleration: 52, scale: 0.025, windup: 0.65, cooldown: 1.2 },
  Alien_Tall: { ...ordinary, label: "Vault sentinel", health: 125, damage: 14,
    acceleration: 36, scale: 0.028, range: 6.5, reach: 6.2, windup: 0.85, cooldown: 1.5 },
  Deer: { ...ordinary, label: "Highland stag", health: 90, damage: 10,
    acceleration: 54, scale: 0.026, windup: 0.7, cooldown: 1.3 },
  Panda: { ...ordinary, label: "Bamboo guardian", health: 140, damage: 14,
    acceleration: 30, scale: 0.029, range: 6.2, reach: 6, windup: 0.95, cooldown: 1.6 },
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
  village: ["Ghost", "GreenDemon", "Cyclops", "Skull",
    "Tree", "Crab", "Bee", "Demon", "Panda", "Deer", "YellowDragon", "Alien",
    "Tree", "Crab", "Bee", "Demon", "Panda", "Deer", "Alien_Tall", "Ghost",
    "GreenDemon", "Cyclops", "Skull", "Tree"],
  mountains: ["Yeti", "Yeti", "Deer", "Yeti", "Panda", "Yeti", "YellowDragon",
    "Yeti", "Deer", "Panda", "Cyclops", "YellowDragon", "Ghost", "Tree", "Yeti"],
  desert: ["Cactus", "YellowDragon", "Cactus", "Cactus", "Bee", "Cactus", "Crab",
    "Cactus", "Demon", "Skull", "YellowDragon", "GreenDemon", "Bee", "Crab", "Cactus"],
  dungeon: ["Bat", "Bat", "Alien", "Bat", "Alien_Tall", "Bat", "Demon",
    "Bat", "Alien", "Alien_Tall", "Demon", "Ghost", "Skull", "GreenDemon", "Bat"],
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

  fireFan(from, target, damage, attacker, angles = [-0.26, 0, 0.26]) {
    const length = Math.hypot(target.x - from.x, target.z - from.z);
    if (!length) return false;
    const baseAngle = Math.atan2(target.x - from.x, target.z - from.z);
    let fired = false;
    for (const offset of angles) {
      const angle = baseAngle + offset;
      const aim = { x: from.x + Math.sin(angle) * length, z: from.z + Math.cos(angle) * length };
      if (this.fire(from, aim, damage, attacker)) fired = true;
    }
    return fired;
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
