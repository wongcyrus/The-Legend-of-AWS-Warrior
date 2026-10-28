import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.118.1/build/three.module.js";
import { SPELLS } from "./magic.js?v=20261028-magic-2";

export class MagicEffects {
  constructor(scene) { this.scene = scene; this.active = []; }
  spawn(kind, from, to, level) {
    const color = to?.color || SPELLS[kind]?.color || 0xff893b;
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false });
    let object, duration = 0.85;
    if (kind === "lightning") {
      const points = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        points.push(new THREE.Vector3(from.x + (to.x - from.x) * t + (i && i < 8 ? Math.sin(i * 19) * 0.7 : 0),
          (from.y || 3) * (1 - t) + 3 * t, from.z + (to.z - from.z) * t));
      }
      object = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),
        32, 0.18 + level * 0.07, 6, false), material);
      duration = 0.75;
    } else if (kind === "fireball" || kind === "explosion" || kind === "cast") {
      object = new THREE.Mesh(new THREE.SphereGeometry(kind === "fireball" ? 1.2 + level * 0.3 : 1, 16, 12), material);
      object.position.set(from.x, 3, from.z);
      duration = kind === "fireball" ? 3 : kind === "cast" ? 0.65 : 0.85;
    } else {
      object = new THREE.Mesh(new THREE.RingGeometry(0.55, 1, 48, 1,
        kind === "frost" ? -Math.PI / 3 : 0, kind === "frost" ? Math.PI * 2 / 3 : Math.PI * 2), material);
      object.position.set(from.x, 0.8, from.z);
      object.rotation.x = -Math.PI / 2;
      if (kind === "frost") object.rotation.z = Math.atan2(-to.z, to.x);
      if (kind === "storm") {
        for (let i = 0; i < 6; i++) {
          const angle = i * Math.PI / 3, radius = to.range * 0.65;
          const point = { x: from.x + Math.cos(angle) * radius, z: from.z + Math.sin(angle) * radius };
          this.spawn("lightning", { ...point, y: 22 }, point, level);
        }
      }
    }
    if (this.active.length >= 40) this.remove(this.active[0]);
    this.scene.add(object);
    this.active.push({ object, kind, from: kind === "fireball" ? from : { x: from.x, z: from.z },
      age: 0, duration, radius: kind === "cast" ? 3 + level : to?.range || 4 + level * 2 });
  }
  remove(effect) {
    effect.object.parent?.remove(effect.object);
    effect.object.geometry.dispose();
    effect.object.material.dispose();
    this.active.splice(this.active.indexOf(effect), 1);
  }
  update(dt) {
    for (const effect of [...this.active]) {
      effect.age += dt;
      if (effect.age >= effect.duration || effect.from.done) { this.remove(effect); continue; }
      if (effect.kind === "fireball") effect.object.position.set(effect.from.x, 3, effect.from.z);
      else {
        effect.object.material.opacity = 1 - effect.age / effect.duration;
        if (effect.kind !== "lightning") effect.object.scale.setScalar(
          Math.max(0.2, effect.radius * effect.age / effect.duration));
      }
    }
  }
  clear() { [...this.active].forEach(effect => this.remove(effect)); }
}
