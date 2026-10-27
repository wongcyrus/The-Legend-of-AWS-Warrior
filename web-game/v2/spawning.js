export function findMonsterSpawn({ canWalk, player, occupied, random = Math.random,
  extent = 145, isSafe = (x, z) => Math.abs(x) < 62 && Math.abs(z) < 50 }) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const x = (random() * 2 - 1) * extent, z = (random() * 2 - 1) * extent;
    if (isSafe(x, z)) continue;
    if (Math.hypot(x - player.x, z - player.z) < 45) continue;
    if (occupied.some(actor => Math.hypot(x - actor.x, z - actor.z) < 10)) continue;
    if (canWalk(x, z)) return { x, z };
  }
  return null;
}

export class MonsterRespawns {
  constructor(random = Math.random) {
    this.random = random;
    this.pending = new Map();
  }

  schedule(monster) {
    if (!this.pending.has(monster)) this.pending.set(monster, 8 + this.random() * 7);
  }

  update(dt, respawn) {
    for (const [monster, remaining] of this.pending) {
      if (remaining > dt) this.pending.set(monster, remaining - dt);
      else if (respawn(monster)) this.pending.delete(monster);
      else this.pending.set(monster, 1);
    }
  }
}
