import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.118.1/build/three.module.js";
import { instances, normalized } from "./assets.js?v=20261027-maps-1";
import { mapScenery } from "./maps.js?v=20261027-maps-1";

export function buildGates(world) {
  for (const gate of world.map.gates) {
    const stone = world.material(0x5f686a);
    for (const side of [-4.3, 4.3]) {
      world.mesh(new THREE.BoxGeometry(1.2, 10, 1.4), stone, gate.x + side, 5, gate.z).castShadow = true;
    }
    world.mesh(new THREE.BoxGeometry(10, 1.2, 1.4), stone, gate.x, 10, gate.z);
    const portal = world.mesh(new THREE.TorusGeometry(3.2, 0.18, 8, 32),
      new THREE.MeshBasicMaterial({ color: gate.color }), gate.x, 4.6, gate.z);
    world.animated.push({ object: portal, type: "glow" });
    const circle = world.mesh(new THREE.RingGeometry(3, 4, 32),
      new THREE.MeshBasicMaterial({ color: gate.color, transparent: true, opacity: 0.55,
        side: THREE.DoubleSide, depthWrite: false }), gate.x, 0.08, gate.z);
    circle.rotation.x = -Math.PI / 2;
    world.sign(gate.x - 7, gate.z - 4, gate.label);
  }
}

export function buildExpedition(world) {
  const map = world.map;
  const ground = world.mesh(new THREE.PlaneGeometry(map.limit * 2 + 40, map.limit * 2 + 40),
    world.material(map.ground), 0, -0.08, 0);
  ground.rotation.x = -Math.PI / 2;
  if (map.id === "dungeon") {
    const floor = new THREE.Mesh(new THREE.BoxGeometry(9.7, 0.12, 9.7), world.material(0x586171));
    const tiles = [];
    for (let x = -140; x <= 140; x += 10) {
      for (let z = -140; z <= 140; z += 10) tiles.push({ x, z, scale: 1 });
    }
    instances(world.scene, floor, tiles, false);
    const stone = world.material(0x4c5363);
    for (const b of map.obstacles) {
      world.mesh(new THREE.BoxGeometry(b.width, b.height, b.depth), stone,
        b.x, b.height / 2, b.z).castShadow = true;
    }
    for (const x of [-96, 0, 96]) {
      for (const z of [-96, 0, 96]) {
        const crystal = world.mesh(new THREE.OctahedronGeometry(1.2),
          world.material(0x8b9bff, { emissive: 0x4959ac, emissiveIntensity: 0.8 }), x + 24, 5, z - 24);
        world.animated.push({ object: crystal, type: "crystal", offset: x + z });
        const lamp = world.mesh(new THREE.SphereGeometry(0.5, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0x9bddff }), x - 24, 6, z - 24);
        world.animated.push({ object: lamp, type: "glow" });
      }
    }
    world.sign(-12, 102, "NINE CHAMBERS / AWS TASKS CONTINUE");
    return;
  }
  const path = world.mesh(new THREE.PlaneGeometry(14, map.limit * 2),
    world.material(map.id === "desert" ? 0xb99a64 : 0xb0b9ba), 0, 0.015, 0);
  path.rotation.x = -Math.PI / 2;
  const cross = world.mesh(new THREE.PlaneGeometry(map.limit * 1.7, 12),
    path.material, 0, 0.02, -70);
  cross.rotation.x = -Math.PI / 2;
  const obstacleMaterial = world.material(map.id === "desert" ? 0xb7894e : 0x657680);
  for (const b of map.obstacles) {
    const obstacle = world.mesh(new THREE.ConeGeometry(1, b.height, map.id === "desert" ? 4 : 7),
      obstacleMaterial, b.x, b.height / 2, b.z);
    obstacle.scale.set(b.width * 0.55, 1, b.depth * 0.55);
    if (map.id === "desert") obstacle.rotation.y = Math.PI / 4;
    obstacle.castShadow = true;
    if (map.id === "mountains") {
      const snow = world.mesh(new THREE.ConeGeometry(1, b.height * 0.35, 7),
        world.material(0xe4edf0), b.x, b.height * 0.825, b.z);
      snow.scale.set(b.width * 0.2, 1, b.depth * 0.2);
    }
  }
  const scenery = mapScenery(map);
  world.scenery.trees = map.id === "mountains" ? scenery.filter((_, i) => i % 3 === 0) : [];
  instances(world.scene, normalized(world.models["rock-small"], map.id === "desert" ? 1.2 : 2), scenery);
  if (map.id === "mountains") {
    instances(world.scene, normalized(world.models["tree-high"], 12), world.scenery.trees);
  } else {
    instances(world.detail, normalized(world.models.Bush_1, 1), scenery.filter((_, i) => i % 4 === 0), false);
  }
  const peaks = [];
  for (let i = 0; i < 28; i++) {
    const angle = i * Math.PI * 2 / 28;
    peaks.push({ x: Math.sin(angle) * (map.limit + 50), z: Math.cos(angle) * (map.limit + 50),
      scale: 1 + i % 3 * 0.3, rotation: angle });
  }
  instances(world.scene, new THREE.Mesh(new THREE.ConeGeometry(30, 80, 5), obstacleMaterial), peaks, false);
  world.sign(-12, map.spawn[1] - 25, map.id === "mountains" ? "FOLLOW THE FROSTPEAK TRAIL" : "EXPLORE THE SUNSPIRE TOMBS");
}
