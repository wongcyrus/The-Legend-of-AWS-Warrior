import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.118.1/build/three.module.js";
import { instances, normalized } from "./assets.js";
import { BUILDINGS, LAKE, RUIN_WALLS, createScenery, isWalkable, seededRandom } from "./layout.js";

export class World {
  constructor(scene, models) {
    this.scene = scene;
    this.models = models;
    this.scenery = createScenery();
    this.animated = [];
    this.detail = new THREE.Group();
    scene.add(this.detail);
    this.buildGround();
    this.buildVillage();
    this.buildLake();
    this.buildRuins();
    this.buildScenery();
    this.buildHorizon();
  }

  material(color, extra = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.92, ...extra });
  }

  mesh(geometry, material, x, y, z, parent = this.scene) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  model(name, x, y, z, scale = 1, rotation = 0, parent = this.scene) {
    const model = this.models[name].clone(true);
    model.position.set(x, y, z);
    model.scale.setScalar(scale);
    model.rotation.y = rotation;
    parent.add(model);
    return model;
  }

  buildGround() {
    const ground = this.mesh(new THREE.PlaneGeometry(1400, 1400),
      this.material(0x738e49), 0, -0.08, 0);
    ground.rotation.x = -Math.PI / 2;
    const pathMaterial = this.material(0xc1ac7c);
    const path = (x, z, width, length, angle = 0) => {
      const mesh = this.mesh(new THREE.PlaneGeometry(width, length), pathMaterial, x, 0.01, z);
      mesh.rotation.set(-Math.PI / 2, 0, angle);
    };
    path(0, 0, 10, 310);
    path(0, 0, 142, 10);
    path(-68, -51, 9, 172, Math.atan2(1, 0.75));
    path(65, -55, 9, 170, -Math.atan2(1, 0.85));
    const square = this.mesh(new THREE.CircleGeometry(23, 48),
      this.material(0xcdbb94), 0, 0.025, 0);
    square.rotation.x = -Math.PI / 2;
    const random = seededRandom(905);
    const stones = [];
    for (let i = 0; i < 150; i++) {
      const angle = random() * Math.PI * 2;
      const radius = 23 + random() * 4;
      stones.push({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius,
        scale: 0.15 + random() * 0.18, rotation: angle });
    }
    instances(this.scene, normalized(this.models["rock-small"], 2), stones, false);
  }

  buildVillage() {
    for (const building of BUILDINGS) {
      const house = new THREE.Group();
      house.position.set(building.x, 0, building.z);
      house.rotation.y = building.rotation;
      house.scale.setScalar(8);
      this.scene.add(house);
      const base = building.timber ? "wall-wood" : "wall";
      for (const offset of [-0.5, 0.5]) {
        this.model(base, 0.5, 0, offset, 1, 0, house);
        this.model("wall-window-shutters", -0.5, 0, offset, 1, Math.PI, house);
        this.model(offset < 0 ? "wall-window-shutters" : "wall-door",
          offset, 0, 0.5, 1, -Math.PI / 2, house);
        this.model(base, offset, 0, -0.5, 1, Math.PI / 2, house);
      }
      const roof = this.model("roof-gable-end", 0, 1, 0, 1, 0, house);
      roof.scale.set(2, 1.6, 2);
      this.model("chimney", -0.4, 1.45, -0.35, 0.8, 0, house);
      this.model(building.timber ? "banner-green" : "banner-red",
        -0.45, 0.72, 1.02, 0.7, -Math.PI / 2, house);
    }
    this.model("fountain-round-detail", 0, 0, -7, 4.2);
    this.model("stall-red", -15, 0, 10, 5, Math.PI / 2);
    this.model("stall-green", 17, 0, 13, 5, -Math.PI / 2);
    this.model("stall-bench", -13, 0, 17, 4, Math.PI / 2);
    this.model("cart", 37, 0, -11, 4.5, -0.4);
    for (const x of [-59, 59]) {
      const fences = [];
      for (let z = -32; z <= 32; z += 6) {
        if (Math.abs(z) > 9) fences.push({ x, z, scale: 6 });
      }
      instances(this.scene, this.models.fence, fences);
    }
    for (const [x, z] of [[-11, 23], [12, -22], [-60, -40], [50, 25], [57, -61]]) {
      const pole = this.mesh(new THREE.CylinderGeometry(0.18, 0.25, 7, 6),
        this.material(0x5a4031), x, 3.5, z);
      pole.castShadow = true;
      this.model("lantern", x, 6.6, z, 3);
      const glow = this.mesh(new THREE.SphereGeometry(0.25, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xffce78 }), x, 6.8, z);
      this.animated.push({ object: glow, type: "glow", base: 0.25 });
    }
    for (const [x, z, text] of [[-57, -40, "WHISPERING FOREST"], [46, 25, "MIRRORWATER"],
      [57, -61, "CRYSTAL RUINS"]]) this.sign(x, z, text);
  }

  sign(x, z, text) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#49382a";
    ctx.fillRect(0, 0, 512, 96);
    ctx.strokeStyle = "#c8a66b";
    ctx.lineWidth = 6;
    ctx.strokeRect(5, 5, 502, 86);
    ctx.fillStyle = "#fff1ca";
    ctx.font = "bold 30px Georgia";
    ctx.textAlign = "center";
    ctx.fillText(text, 256, 59);
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    this.mesh(new THREE.BoxGeometry(0.3, 5, 0.3),
      this.material(0x5a4031), x, 2.5, z);
    const board = this.mesh(new THREE.PlaneGeometry(7, 1.4),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }), x, 4.6, z);
    board.rotation.y = -0.4;
  }

  buildLake() {
    const shore = this.mesh(new THREE.CircleGeometry(1, 64), this.material(0xb0a076),
      LAKE.x, -0.01, LAKE.z);
    shore.rotation.x = -Math.PI / 2;
    shore.scale.set(LAKE.rx + 2, LAKE.rz + 2, 1);
    const water = this.mesh(new THREE.CircleGeometry(1, 64),
      this.material(0x418f9f, { transparent: true, opacity: 0.86, roughness: 0.28,
        metalness: 0.25 }), LAKE.x, 0.04, LAKE.z);
    water.rotation.x = -Math.PI / 2;
    water.scale.set(LAKE.rx, LAKE.rz, 1);
    this.water = water;
    const wood = this.material(0x876443);
    for (let z = LAKE.z - 26; z <= LAKE.z + 26; z += 2) {
      this.mesh(new THREE.BoxGeometry(6, 0.16, 1.8), wood, LAKE.x, 0.11, z).castShadow = true;
      for (const side of [-3, 3]) {
        this.mesh(new THREE.BoxGeometry(0.17, 0.17, 2), wood, LAKE.x + side, 2, z);
        if (z % 4 === 2) {
          this.mesh(new THREE.BoxGeometry(0.25, 2.6, 0.25), wood, LAKE.x + side, 1, z);
        }
      }
    }
    for (let i = 0; i < 5; i++) {
      const ring = this.mesh(new THREE.RingGeometry(2.8, 2.85, 48),
        new THREE.MeshBasicMaterial({ color: 0x9bd8cf, transparent: true, opacity: 0.3,
          side: THREE.DoubleSide, depthWrite: false }),
        LAKE.x - 14 + i * 6, 0.09, LAKE.z + (i % 2 ? 8 : -7));
      ring.rotation.x = -Math.PI / 2;
      this.animated.push({ object: ring, type: "ripple", offset: i });
    }
  }

  buildRuins() {
    const platform = this.mesh(new THREE.CircleGeometry(27, 9),
      this.material(0x929484), 94, 0.015, -85);
    platform.rotation.x = -Math.PI / 2;
    for (const wall of RUIN_WALLS) {
      const model = normalized(this.models["wall-broken"], 10);
      model.position.set(wall.x, 0, wall.z);
      model.rotation.y = wall.rotation + Math.PI / 2;
      this.scene.add(model);
    }
    this.model("wall-arch", 79, 0, -85, 12, Math.PI / 2);
    for (const [x, z] of [[83, -68], [104, -105], [112, -65]]) {
      this.model("pillar-stone", x, 0, z, 8);
    }
    for (let i = 0; i < 5; i++) {
      const angle = i * Math.PI * 2 / 5;
      const crystal = this.mesh(new THREE.OctahedronGeometry(2 + (i % 2), 0),
        this.material(0x73d8d4, { emissive: 0x176975, emissiveIntensity: 0.6,
          metalness: 0.25, roughness: 0.3 }),
        94 + Math.cos(angle) * 7, 4, -85 + Math.sin(angle) * 7);
      crystal.scale.y = 1.8;
      this.animated.push({ object: crystal, type: "crystal", offset: i });
    }
    this.model("fence-broken", 113, 0, -58, 7, Math.PI / 2);
  }

  buildScenery() {
    const scenery = this.scenery;
    const treeNames = ["tree", "tree-high", "tree-crooked", "tree-high-round"];
    treeNames.forEach((name, index) => instances(this.scene,
      normalized(this.models[name], 15 + index * 2),
      scenery.trees.filter((_, i) => i % 4 === index)));
    instances(this.scene, normalized(this.models["rock-large"], 3), scenery.rocks);
    instances(this.scene, normalized(this.models.Bush_1, 2.5), scenery.bushes);
    instances(this.detail, normalized(this.models.Grass, 1.1), scenery.grass, false);
    instances(this.detail, normalized(this.models.Flowers, 1.4), scenery.flowers, false);
    const random = seededRandom(122);
    const points = new Float32Array(180 * 3);
    for (let i = 0; i < points.length; i += 3) {
      points[i] = (random() * 2 - 1) * 130;
      points[i + 1] = 1 + random() * 10;
      points[i + 2] = (random() * 2 - 1) * 130;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(points, 3));
    this.motes = new THREE.Points(geometry, new THREE.PointsMaterial({
      color: 0xffe6ab, size: 0.22, transparent: true, opacity: 0.6, depthWrite: false,
    }));
    this.detail.add(this.motes);
  }

  buildHorizon() {
    const random = seededRandom(503);
    const mountains = [];
    for (let i = 0; i < 36; i++) {
      const angle = i * Math.PI * 2 / 36;
      mountains.push({ x: Math.sin(angle) * 240, z: Math.cos(angle) * 240,
        scale: 1 + random(), rotation: angle });
    }
    const mountain = new THREE.Mesh(new THREE.ConeGeometry(23, 60, 5),
      this.material(0x687c77));
    mountain.position.y = 18;
    instances(this.scene, mountain, mountains, false);
    const cloud = new THREE.Mesh(new THREE.SphereGeometry(10, 7, 5),
      this.material(0xffead3, { flatShading: true }));
    cloud.scale.set(2.5, 0.6, 1);
    instances(this.scene, cloud, Array.from({ length: 18 }, (_, i) => ({
      x: Math.sin(i * 2.4) * 190, y: 85 + i % 4 * 6,
      z: Math.cos(i * 2.4) * 190, scale: 1 + i % 3 * 0.25,
    })), false);
  }

  update(time, player) {
    this.animated.forEach(({ object, type, offset = 0 }) => {
      if (type === "crystal") {
        object.rotation.y = time * 0.3 + offset;
        object.position.y = 4 + Math.sin(time * 1.4 + offset) * 0.5;
      } else if (type === "ripple") {
        object.scale.setScalar(1 + ((time * 0.2 + offset * 0.3) % 1) * 1.5);
      } else {
        object.scale.setScalar(1 + Math.sin(time * 3) * 0.12);
      }
    });
    this.motes.position.y = Math.sin(time * 0.25) * 0.6;
    if (player) this.detail.visible = Math.abs(player.x) < 170 && Math.abs(player.z) < 170;
  }

  canWalk(x, z) {
    return isWalkable(x, z, 1.5, this.scenery.trees);
  }
}
