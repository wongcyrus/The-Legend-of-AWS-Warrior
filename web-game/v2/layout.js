export const WORLD_LIMIT = 165;
export const PLAYER_SPAWN = [0, 20];
export const LAKE = { x: 78, z: 56, rx: 29, rz: 22 };
export const BUILDINGS = [
  { x: -27, z: -25, rotation: 0, timber: false },
  { x: -49, z: 5, rotation: Math.PI / 2, timber: true },
  { x: -28, z: 32, rotation: Math.PI, timber: false },
  { x: 28, z: 32, rotation: Math.PI, timber: true },
  { x: 47, z: 4, rotation: -Math.PI / 2, timber: false },
  { x: 26, z: -30, rotation: 0, timber: true },
];
export const GUIDES = [
  { x: 10, z: 3, name: "Village keeper" },
  { x: -67, z: -48, name: "Forest watcher" },
  { x: 63, z: 27, name: "Lake guardian" },
  { x: 69, z: -72, name: "Ruins scholar" },
];
export const ENEMY_SPAWNS = [
  [-90, -65], [-112, -90], [-68, -102], [-115, 28],
  [-90, 76], [99, -70], [113, -93], [81, -113],
  [123, 89], [46, 108], [-34, 114], [116, -28],
];
export const RUIN_WALLS = [
  { x: 90, z: -96, rotation: 0 },
  { x: 100, z: -96, rotation: 0 },
  { x: 110, z: -86, rotation: Math.PI / 2 },
  { x: 110, z: -76, rotation: Math.PI / 2 },
];

export function seededRandom(seed = 71829) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function onBridge(x, z, margin = 0) {
  return Math.abs(x - LAKE.x) < 3 - margin &&
    Math.abs(z - LAKE.z) < LAKE.rz + 5;
}

export function isWalkable(x, z, margin = 1.5, trees = []) {
  if (Math.abs(x) > WORLD_LIMIT - margin || Math.abs(z) > WORLD_LIMIT - margin) {
    return false;
  }
  if (BUILDINGS.some(b => Math.abs(x - b.x) < 8 + margin &&
      Math.abs(z - b.z) < 8 + margin)) {
    return false;
  }
  if (Math.hypot(x, z + 7) < 4.5 + margin) return false;
  const inLake = ((x - LAKE.x) / (LAKE.rx + margin)) ** 2 +
    ((z - LAKE.z) / (LAKE.rz + margin)) ** 2 < 1;
  if (inLake && !onBridge(x, z, margin)) return false;
  if (trees.some(tree => Math.hypot(x - tree.x, z - tree.z) < margin + tree.scale)) {
    return false;
  }
  return !RUIN_WALLS.some(wall => {
    const dx = Math.abs(x - wall.x);
    const dz = Math.abs(z - wall.z);
    return wall.rotation === 0
      ? dx < 5 + margin && dz < 0.8 + margin
      : dx < 0.8 + margin && dz < 5 + margin;
  });
}

export function isPath(x, z, width = 6) {
  return Math.abs(x) < width ||
    (Math.abs(z) < width && Math.abs(x) < 72) ||
    (Math.abs(z - x * 0.75) < width && x < 0) ||
    (Math.abs(z + x * 0.85) < width && x > 0);
}

export function createScenery(seed = 71829) {
  const random = seededRandom(seed);
  const groups = { trees: [], rocks: [], grass: [], flowers: [], bushes: [] };
  const occupied = [...GUIDES, ...ENEMY_SPAWNS.map(([x, z]) => ({ x, z }))];
  for (let i = 0; i < 3400; i++) {
    const x = (random() * 2 - 1) * 153;
    const z = (random() * 2 - 1) * 153;
    if (!isWalkable(x, z, 5) || isPath(x, z, 9) ||
        occupied.some(p => Math.hypot(p.x - x, p.z - z) < 8)) continue;
    const inVillage = Math.abs(x) < 61 && Math.abs(z) < 48;
    const kind = i % 11 === 0 ? "rocks" : i % 5 === 0 ? "bushes" :
      i % 3 === 0 ? "flowers" : i % 2 === 0 && !inVillage ? "trees" : "grass";
    const limits = { trees: 200, rocks: 85, grass: 650, flowers: 260, bushes: 100 };
    if (groups[kind].length >= limits[kind]) continue;
    groups[kind].push({ x, z, rotation: random() * Math.PI * 2, scale: 0.7 + random() * 0.6 });
  }
  return groups;
}

export function regionAt(x, z) {
  if (Math.abs(x) < 60 && Math.abs(z) < 48) return "Cloudhaven Village";
  if (x > 55 && z < -48) return "The Crystal Ruins";
  if (x > 38 && z > 20) return "Mirrorwater Lake";
  return "Whispering Forest";
}
