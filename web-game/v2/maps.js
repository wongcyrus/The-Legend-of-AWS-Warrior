import { BUILDINGS, GUIDES, ENEMY_SPAWNS, PLAYER_SPAWN, RUIN_WALLS, seededRandom } from "./layout.js";

const wall = (x, z, width, depth, height = 13) => ({ x, z, width, depth, height });
const dungeonWalls = [
  wall(-152, 0, 5, 309), wall(152, 0, 5, 309),
  wall(0, -152, 299, 5), wall(0, 152, 299, 5),
];
for (const divider of [-48, 48]) {
  for (const centre of [-96, 0, 96]) {
    for (const offset of [-28.5, 28.5]) {
      dungeonWalls.push(wall(divider, centre + offset, 4, 39));
      dungeonWalls.push(wall(centre + offset, divider, 39, 4));
    }
  }
}

export const MAPS = {
  village: {
    id: "village", name: "Cloudlands Village", limit: 165, spawn: PLAYER_SPAWN,
    sky: 0x9bbbc0, ground: 0x738e49, fogNear: 95, fogFar: 310,
    guides: GUIDES, enemies: [...ENEMY_SPAWNS,
      [-102, -65], [-100, -90], [-56, -102], [-103, 28], [-78, 76], [87, -70],
      [125, -93], [69, -113], [135, 89], [34, 108], [-22, 114], [128, -28]],
    obstacles: BUILDINGS.map(b => wall(b.x, b.z, 17, 17, 16)),
    gates: [
      { x: -136, z: -102, to: "mountains", label: "FROSTPEAK HIGHLANDS", color: 0x88d9ff },
      { x: 130, z: -110.5, to: "desert", label: "SUNSPIRE DESERT", color: 0xffc475 },
      { x: 0, z: 150, to: "dungeon", label: "FORGOTTEN VAULT", color: 0xc3a0ff },
    ],
  },
  mountains: {
    id: "mountains", name: "Frostpeak Highlands", limit: 220, spawn: [0, 180],
    sky: 0xb9cddc, ground: 0x8a999b, fogNear: 85, fogFar: 280,
    guides: [{ x: 12, z: 170, name: "Mountain ranger" }],
    gates: [{ x: 0, z: 201, to: "village", label: "RETURN TO CLOUDLANDS", color: 0xffd381 }],
    obstacles: [
      wall(-80, 100, 40, 60, 25), wall(85, 75, 55, 45, 28),
      wall(-110, -30, 50, 60, 35), wall(100, -85, 55, 70, 38),
      wall(-40, -150, 50, 35, 25),
    ],
    enemies: [[-40, 125], [45, 140], [-135, 90], [135, 5], [-45, -35], [30, -85], [-110, -140],
      [-28, 125], [57, 140], [-123, 90], [147, 5], [-33, -35], [42, -85], [-98, -140], [80, -170]],
  },
  desert: {
    id: "desert", name: "Sunspire Desert", limit: 240, spawn: [0, 200],
    sky: 0xe9c9a1, ground: 0xd4b174, fogNear: 105, fogFar: 330,
    guides: [{ x: 12, z: 190, name: "Desert wayfinder" }],
    gates: [{ x: 0, z: 221, to: "village", label: "RETURN TO CLOUDLANDS", color: 0xffd381 }],
    obstacles: [
      wall(-95, 75, 65, 65, 40), wall(100, -60, 70, 70, 45),
      wall(-75, -130, 50, 60, 32), wall(130, 130, 45, 45, 28),
    ],
    enemies: [[-45, 135], [45, 140], [-150, 40], [150, 35], [-30, -45], [35, -110], [-130, -175],
      [-33, 135], [57, 140], [-138, 40], [162, 35], [-18, -45], [47, -110], [-118, -175], [110, -180]],
  },
  dungeon: {
    id: "dungeon", name: "Forgotten Vault", limit: 155, spawn: [0, 125],
    sky: 0x172330, ground: 0x3e4655, fogNear: 45, fogFar: 155,
    guides: [{ x: 12, z: 118, name: "Vault scholar" }],
    gates: [{ x: 0, z: 140, to: "village", label: "RETURN TO CLOUDLANDS", color: 0xffd381 }],
    obstacles: [...dungeonWalls, wall(0, -110, 12, 12, 3)],
    enemies: [[-95, 100], [95, 100], [-95, 0], [95, 0], [-95, -95], [95, -95], [-20, -100],
      [-83, 100], [107, 100], [-83, 0], [107, 0], [-83, -95], [107, -95], [-8, -100], [20, -100]],
  },
};

export function isMapWalkable(map, x, z, margin = 1.5) {
  return Number.isFinite(x) && Number.isFinite(z) &&
    Math.abs(x) <= map.limit - margin && Math.abs(z) <= map.limit - margin &&
    !map.obstacles.some(b => Math.abs(x - b.x) < b.width / 2 + margin &&
      Math.abs(z - b.z) < b.depth / 2 + margin);
}

export function isSafePosition(map, x, z) {
  return map.id === "village" ? Math.abs(x) < 58 && Math.abs(z) < 46 :
    Math.hypot(x - map.spawn[0], z - map.spawn[1]) < 30;
}

export function nearbyGate(map, position) {
  return map.gates.find(gate => Math.hypot(position.x - gate.x, position.z - gate.z) < 9) || null;
}

export function isMagicWaveClear(map, from, to) {
  if (![from?.x, from?.z, to?.x, to?.z].every(Number.isFinite)) return false;
  const obstacles = map.id === "village" ? [...map.obstacles, ...RUIN_WALLS.map(wall => ({
    ...wall, width: wall.rotation === 0 ? 10 : 1.6, depth: wall.rotation === 0 ? 1.6 : 10,
  }))] : map.obstacles;
  return !obstacles.some(obstacle => {
    let enter = 0, exit = 1;
    for (const [axis, size] of [["x", "width"], ["z", "depth"]]) {
      const delta = to[axis] - from[axis];
      const min = obstacle[axis] - obstacle[size] / 2, max = obstacle[axis] + obstacle[size] / 2;
      if (delta === 0) {
        if (from[axis] < min || from[axis] > max) return false;
      } else {
        const a = (min - from[axis]) / delta, b = (max - from[axis]) / delta;
        enter = Math.max(enter, Math.min(a, b));
        exit = Math.min(exit, Math.max(a, b));
        if (enter > exit) return false;
      }
    }
    return true;
  });
}

export function mapScenery(map) {
  const random = seededRandom(map.id === "mountains" ? 415 : 953);
  const scenery = [];
  for (let i = 0; i < 180; i++) {
    const x = (random() * 2 - 1) * (map.limit - 12);
    const z = (random() * 2 - 1) * (map.limit - 12);
    if (Math.abs(x) < 13 || Math.abs(z + 70) < 12 ||
        isSafePosition(map, x, z) || !isMapWalkable(map, x, z, 5) ||
        map.enemies.some(([ex, ez]) => Math.hypot(x - ex, z - ez) < 10)) continue;
    scenery.push({ x, z, scale: 0.3 + random() * 0.6, rotation: random() * Math.PI * 2 });
  }
  return scenery;
}
