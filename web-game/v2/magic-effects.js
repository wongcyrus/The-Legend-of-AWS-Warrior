import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.118.1/build/three.module.js";
import { SPELLS } from "./magic.js?v=20261029-lightning-80-1";
import { SkeletonUtils } from "https://cdn.jsdelivr.net/npm/three@0.118.1/examples/jsm/utils/SkeletonUtils.js";

export class MagicEffects {
  constructor(scene, { low = () => false, character = () => null, cpuSkinning = () => false } = {}) {
    Object.assign(this, { scene, low, character, cpuSkinning, active: [] });
  }
  spawnAvatarFormation(origin, forward) {
    for (const effect of [...this.active]) if (effect.kind === "avatar") this.remove(effect);
    const angle = Math.atan2(forward.x, forward.z);
    for (let i = 0; i < 4; i++) {
      const heading = angle + i * Math.PI / 2;
      const dx = Math.sin(heading), dz = Math.cos(heading);
      this.spawn("avatar", { x: origin.x + dx * 12, z: origin.z + dz * 12, dx, dz },
        { color: SPELLS.storm.color, duration: 6 }, 1);
    }
  }
  spawn(kind, from, to, level = 1) {
    if (kind === "avatar") {
      const avatars = this.active.filter(effect => effect.kind === "avatar");
      if (avatars.length >= 4) this.remove(avatars[0]);
    }
    const color = to?.color || ({ domain: SPELLS.frost.color, ward: SPELLS.storm.color,
      anchor: SPELLS.shockwave.color, recall: SPELLS.shockwave.color,
      clone: SPELLS.fireball.color })[kind] || SPELLS.lightning.color;
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7,
      side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false });
    const object = new THREE.Group(), radius = to?.range || 4;
    const reduced = this.low(), segments = reduced ? 16 : 40;
    const ownedGeometries = [];
    const mesh = (geometry, x = 0, y = 0, z = 0) => {
      ownedGeometries.push(geometry);
      const item = new THREE.Mesh(geometry, material);
      item.position.set(x, y, z);
      object.add(item);
      return item;
    };
    const ring = size => {
      const item = mesh(new THREE.RingGeometry(size * 0.94, size, segments), 0, 0.2, 0);
      item.rotation.x = -Math.PI / 2;
      return item;
    };
    let duration = to?.duration || (kind === "lightning" ? 1.1 : 0.8), mixer, model, attack, blade;
    const skins = [];
    if (kind === "release-boundary") {
      ring(radius);
      material.opacity = 0.3;
    } else if (kind === "release-wave") {
      const slash = mesh(new THREE.RingGeometry(0.88, 1, segments, 1, -Math.PI / 4, Math.PI / 2 - 0.04), 0, 2, 0);
      slash.rotation.x = -Math.PI / 2;
      slash.rotation.z = Math.PI / 2 - to.heading;
    } else if (kind === "lightning") {
      const points = [];
      for (let i = 0; i <= 14; i++) {
        const t = i / 14;
        points.push(new THREE.Vector3((to.x - from.x) * t + (i && i < 14 ? Math.sin(i * 19) * 0.9 : 0),
          (from.y || 3) * (1 - t) + 3 * t, (to.z - from.z) * t));
      }
      mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), reduced ? 16 : 44, 0.34, 6, false));
      const core = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), reduced ? 16 : 44, 0.12, 6, false));
      core.material = new THREE.MeshBasicMaterial({ color: 0xfff3d1, transparent: true,
        opacity: 0.95, depthWrite: false, fog: false, toneMapped: false });
    } else if (kind === "domain" || kind === "ward") {
      ring(radius);
      const dome = mesh(new THREE.SphereGeometry(radius, segments, reduced ? 8 : 16,
        0, Math.PI * 2, 0, Math.PI / 2));
      dome.material = material.clone();
      dome.material.wireframe = true;
      dome.material.opacity = 0.18;
      const count = reduced ? 6 : 16;
      for (let i = 0; i < count; i++) {
        const angle = i * Math.PI * 2 / count;
        const item = mesh(kind === "domain" ? new THREE.BoxGeometry(1, 1, 1) :
          new THREE.BoxGeometry(0.3, 5, 1.8), Math.cos(angle) * radius * 0.85,
        kind === "domain" ? 2 + i % 4 * 2 : 3, Math.sin(angle) * radius * 0.85);
        item.rotation.y = -angle;
      }
    } else if (kind === "clone" || kind === "avatar") {
      const controller = this.character();
      if (!controller?._target) { material.dispose(); return; }
      const cpu = this.cpuSkinning();
      material.skinning = !cpu;
      model = SkeletonUtils.clone(controller._target);
      model.position.set(0, 0, 0);
      model.rotation.set(0, Math.atan2(from.dx, from.dz), 0);
      if (kind === "avatar") {
        model.scale.multiplyScalar(6);
        model.rotation.y = 0;
        object.rotation.y = Math.atan2(from.dx, from.dz);
      }
      model.traverse(item => {
        if (item.isMesh) {
          if (cpu && item.isSkinnedMesh) {
            const source = item.geometry;
            item.geometry = source.clone();
            item.frustumCulled = false;
            skins.push({ mesh: item, source, geometry: item.geometry });
          }
          item.material = material;
          item.castShadow = false;
          item.receiveShadow = false;
        }
      });
      object.add(model);
      mixer = new THREE.AnimationMixer(model);
      const runClip = kind === "avatar" ? controller._animations.idle?.clip :
        controller._animations.run?.clip || controller._animations.walk?.clip;
      const attackClip = controller._animations.attack?.clip;
      if (runClip) mixer.clipAction(runClip).play();
      if (attackClip) attack = mixer.clipAction(attackClip);
      mixer.update(0);
      model.updateMatrixWorld(true);
      this.poseSkins(skins);
      duration = kind === "avatar" ? 6 : 3.2;
      if (kind === "avatar") {
        const armor = mesh(new THREE.BoxGeometry(15, 18, 9), 0, 22.5, 0);
        armor.material = new THREE.MeshBasicMaterial({ color: SPELLS.storm.color, wireframe: true,
          transparent: true, opacity: 0.4, depthWrite: false });
        const core = mesh(new THREE.OctahedronGeometry(2.25), 0, 22.5, 4.8);
        core.material = new THREE.MeshBasicMaterial({ color: SPELLS.frost.color, transparent: true,
          opacity: 0.9, depthWrite: false });
        blade = mesh(new THREE.BoxGeometry(0.9, 22.5, 2.1), 12, 21, 0);
        blade.material = new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true,
          opacity: 0.7, depthWrite: false });
      }
    } else if (kind === "anchor") {
      ring(3).material = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true,
        opacity: 0.8, side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false });
      mesh(new THREE.OctahedronGeometry(1), 0, 3, 0);
    } else {
      ring(1);
      mesh(new THREE.OctahedronGeometry(1), 0, 2, 0);
    }
    object.position.set(from.x, 0, from.z);
    if (this.active.length >= 40) this.remove(this.active[0]);
    this.scene.add(object);
    this.active.push({ object, material, kind, from: { x: from.x, z: from.z },
      to: to ? { x: to.x, z: to.z } : null, age: 0, duration, radius,
      reduced, level, mixer, model, attack, skins, ownedGeometries, blade, poseAge: 0, strikes: 0,
      source: ["anchor", "domain", "ward", "clone", "release-wave", "release-boundary"].includes(kind) ? from : null });
  }
  poseSkins(skins) {
    if (!skins.length) return;
    const vertex = new THREE.Vector3();
    for (const { mesh, source, geometry } of skins) {
      // boneTransform reads bind-pose positions; never feed it last frame's deformed vertices.
      mesh.geometry = source;
      try {
        const positions = geometry.attributes.position;
        for (let i = 0; i < positions.count; i++) {
          mesh.boneTransform(i, vertex);
          positions.setXYZ(i, vertex.x, vertex.y, vertex.z);
        }
        positions.needsUpdate = true;
      } finally { mesh.geometry = geometry; }
    }
  }
  remove(effect) {
    effect.object.parent?.remove(effect.object);
    const geometries = new Set(), materials = new Set();
    effect.skins.forEach(skin => geometries.add(skin.geometry));
    effect.ownedGeometries.forEach(geometry => geometries.add(geometry));
    effect.mixer?.stopAllAction();
    if (effect.model) effect.mixer.uncacheRoot(effect.model);
    effect.object.traverse(item => {
      if (effect.model && item.skeleton?.boneTexture) item.skeleton.boneTexture.dispose();
      if (item.geometry && !effect.model) geometries.add(item.geometry);
      if (item.material) materials.add(item.material);
    });
    for (const resource of [...geometries, ...materials]) resource.dispose();
    this.active.splice(this.active.indexOf(effect), 1);
  }
  update(dt) {
    if (!Number.isFinite(dt) || dt < 0) return;
    for (const effect of [...this.active]) {
      if (effect.kind === "release-wave") effect.age = effect.source.age;
      else effect.age += dt;
      if (effect.age >= effect.duration || effect.source?.done) { this.remove(effect); continue; }
      const t = effect.age / effect.duration;
      effect.material.opacity = 0.7 * Math.min(1, (1 - t) * 4);
      if (effect.kind === "release-wave") {
        effect.object.scale.setScalar(effect.source.radius);
        effect.material.opacity = 0.85 * Math.min(1, (effect.duration - effect.age) / 0.2);
      } else if (effect.kind === "release-boundary") {
        effect.material.opacity = 0.3 * Math.min(1, (effect.duration - effect.age) / 0.5);
      } else if (effect.kind === "clone" || effect.kind === "avatar") {
        if (effect.source) effect.object.position.set(effect.source.x, 0, effect.source.z);
        const strikes = effect.kind === "avatar" ? Math.max(0, Math.min(3, Math.floor((effect.age - 0.7) / 1.6) + 1)) :
          effect.source.strikes;
        if (effect.attack && effect.strikes !== strikes) {
          effect.strikes = strikes;
          effect.mixer.stopAllAction();
          effect.attack.reset().setLoop(THREE.LoopOnce, 1);
          effect.attack.clampWhenFinished = true;
          effect.attack.setDuration(effect.kind === "avatar" ? 1.6 : 0.8).play();
        }
        if (effect.blade) effect.blade.rotation.z = effect.age < 0.7 ? -0.3 :
          Math.sin(Math.min(effect.age - 0.7, 4.8) / 1.6 * Math.PI * 2) * 1.1;
        effect.mixer.update(dt);
        effect.poseAge += dt;
        if (effect.skins.length && effect.poseAge >= 1 / 20) {
          effect.model.updateMatrixWorld(true);
          this.poseSkins(effect.skins);
          effect.poseAge = 0;
        }
      } else if (["domain", "ward", "anchor"].includes(effect.kind)) {
        effect.object.scale.setScalar(Math.min(1, effect.age * 3));
        if (!effect.reduced) effect.object.rotation.y += dt * (effect.kind === "domain" ? 0.3 : 0.12);
      } else if (effect.kind !== "lightning") {
        effect.object.scale.setScalar(Math.max(0.2, effect.radius * t));
      }
    }
  }
  clear() { [...this.active].forEach(effect => this.remove(effect)); }
}
