import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.118.1/build/three.module.js";
import { SPELLS } from "./magic.js?v=20261030-anime-combos-1";
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
    let duration = to?.duration || (kind === "lightning" ? 1.2 : 0.8), mixer, model, attack, blade;
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
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        points.push(new THREE.Vector3((to.x - from.x) * t + (i && i < 20 ? Math.sin(i * 19) * 1.15 : 0),
          (from.y || 3) * (1 - t) + 3 * t, (to.z - from.z) * t));
      }
      mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), reduced ? 20 : 56, 0.45, 6, false));
      const core = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), reduced ? 20 : 56, 0.16, 6, false));
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
    } else if (kind === "blade-barrage") {
      object.rotation.y = Math.atan2(to?.dx || 0, to?.dz || 1);
      const count = reduced ? 8 : 18;
      for (let i = 0; i < count; i++) {
        const arc = (i / Math.max(1, count - 1) - 0.5) * Math.PI * 0.9;
        const x = Math.sin(arc) * 13, y = 5 + Math.cos(arc) * 8 + (i % 3) * 1.5, z = -3 - (i % 3) * 1.5;
        const portal = mesh(new THREE.RingGeometry(1.1, 1.45, segments), x, y, z);
        portal.material = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true,
          opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false });
        const sword = mesh(new THREE.BoxGeometry(0.32, 0.32, 5.2), x, y, z + 1);
        sword.material = new THREE.MeshBasicMaterial({ color: 0xfff5c0, transparent: true,
          opacity: 0.95, depthWrite: false, fog: false, toneMapped: false });
        sword.userData = { sword: true, baseZ: z + 1, delay: (i % 6) * 0.2, speed: 34 + (i % 4) * 5 };
        mesh(new THREE.OctahedronGeometry(0.6), x, y, z - 0.4);
      }
    } else if (kind === "singularity") {
      ring(radius);
      const blue = mesh(new THREE.SphereGeometry(2.2, 16, 12), -9, 6, 0);
      blue.material = new THREE.MeshBasicMaterial({ color: 0x00d2ff, transparent: true,
        opacity: 0.9, depthWrite: false, fog: false, toneMapped: false });
      blue.userData = { orb: 1 };
      const red = mesh(new THREE.SphereGeometry(2.2, 16, 12), 9, 6, 0);
      red.material = new THREE.MeshBasicMaterial({ color: 0xff2a6d, transparent: true,
        opacity: 0.9, depthWrite: false, fog: false, toneMapped: false });
      red.userData = { orb: -1 };
      const core = mesh(new THREE.SphereGeometry(4.2, 20, 14), 0, 6, 0);
      core.material = new THREE.MeshBasicMaterial({ color: 0xb537f2, transparent: true,
        opacity: 0.9, depthWrite: false, fog: false, toneMapped: false });
      core.userData = { core: true };
      const shell = mesh(new THREE.SphereGeometry(6.8, 16, 12), 0, 6, 0);
      shell.material = new THREE.MeshBasicMaterial({ color: 0xff77ff, wireframe: true,
        transparent: true, opacity: 0.45, depthWrite: false, fog: false, toneMapped: false });
      shell.userData = { core: true };
      for (let i = 0; i < 3; i++) {
        const gyro = mesh(new THREE.RingGeometry(8 + i * 1.6, 8.9 + i * 1.6, segments), 0, 6, 0);
        gyro.rotation?.set?.(i * 0.9, i * 0.6, i * 0.4);
        gyro.userData = { gyro: i + 1 };
      }
      const shardCount = reduced ? 6 : 12;
      for (let i = 0; i < shardCount; i++) {
        const a = i * Math.PI * 2 / shardCount;
        const shard = mesh(new THREE.OctahedronGeometry(0.95), Math.cos(a) * 18, 3 + (i % 4) * 2, Math.sin(a) * 18);
        shard.userData = { shard: a };
      }
    } else if (kind === "almighty-push") {
      for (let i = 1; i <= 3; i++) ring(radius * i / 3);
      const coreSphere = mesh(new THREE.SphereGeometry(2.6, reduced ? 10 : 18, reduced ? 8 : 14), 0, 3.2, 0);
      coreSphere.material = new THREE.MeshBasicMaterial({ color: 0xfff0d4, transparent: true,
        opacity: 0.92, depthWrite: false, fog: false, toneMapped: false });
      coreSphere.userData = { pushOrigin: true };
      const innerSphere = mesh(new THREE.SphereGeometry(radius * 0.65, segments, reduced ? 8 : 14), 0, 3.2, 0);
      innerSphere.material = new THREE.MeshBasicMaterial({ color: 0xb794f4, transparent: true,
        opacity: 0.26, side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false });
      innerSphere.userData = { pushDome: 0.85 };
      const dome = mesh(new THREE.SphereGeometry(radius, segments, reduced ? 10 : 18), 0, 3.2, 0);
      dome.material = new THREE.MeshBasicMaterial({ color: 0xe9d5ff, wireframe: true,
        transparent: true, opacity: 0.48, depthWrite: false, fog: false, toneMapped: false });
      dome.userData = { pushDome: 1 };
      const count = reduced ? 8 : 16;
      for (let i = 0; i < count; i++) {
        const a = i * Math.PI * 2 / count;
        const pitch = ((i % 3) - 1) * 0.32;
        const spike = mesh(new THREE.BoxGeometry(0.45, 0.9, 5.2), Math.cos(a) * 2, 3.2, Math.sin(a) * 2);
        spike.rotation.y = a;
        spike.rotation.x = pitch;
        spike.userData = { radial: a, pitch };
      }
    } else if (kind === "omniscience") {
      material.opacity = 0.96;
      material.depthWrite = true;
      for (const existing of this.active) {
        if (existing.kind === "domain" || existing.kind === "ward") {
          existing.object.traverse(item => {
            item.material?.color?.setHex?.(0x07030c);
          });
        }
      }
      ring(radius);
      ring(radius * 0.6);
      const sharingan = mesh(new THREE.RingGeometry(radius * 0.28, radius * 0.34, segments), 0, 0.28, 0);
      sharingan.rotation.x = -Math.PI / 2;
      sharingan.material = new THREE.MeshBasicMaterial({ color: 0xb8001f, transparent: true,
        opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false });
      const eye = mesh(new THREE.OctahedronGeometry(2.4), 0, 13, 0);
      eye.material = new THREE.MeshBasicMaterial({ color: 0x050208, transparent: true,
        opacity: 0.98, depthWrite: true, fog: false, toneMapped: false });
      eye.userData = { eye: true };
      const halo = mesh(new THREE.RingGeometry(2.8, 3.8, segments), 0, 13, 0);
      halo.material = new THREE.MeshBasicMaterial({ color: 0xb8001f, transparent: true,
        opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false });
      halo.userData = { eye: true };
      const beam = mesh(new THREE.BoxGeometry(0.55, 0.55, radius), 0, 1.2, radius / 2);
      beam.material = new THREE.MeshBasicMaterial({ color: 0x08030d, transparent: true,
        opacity: 0.95, depthWrite: true, fog: false, toneMapped: false });
      const count = reduced ? 10 : 24;
      for (let i = 0; i < count; i++) {
        const a = i * Math.PI * 2 / count;
        const r = radius * (i % 3 === 0 ? 0.45 : i % 3 === 1 ? 0.72 : 0.9);
        const h = 7.5 + (i % 4) * 2.2;
        const flame = mesh(new THREE.BoxGeometry(1.35, h, 1.35),
          Math.cos(a) * r, h / 2, Math.sin(a) * r);
        flame.rotation.y = a + i * 0.4;
        flame.material = new THREE.MeshBasicMaterial({ color: i % 3 === 0 ? 0x12061a : 0x050208,
          transparent: true, opacity: 0.96, depthWrite: true, fog: false, toneMapped: false });
        flame.userData = { blackFlame: i, baseY: h / 2 };
        const tongue = mesh(new THREE.OctahedronGeometry(1.85),
          Math.cos(a) * r, h * 0.75, Math.sin(a) * r);
        tongue.material = new THREE.MeshBasicMaterial({ color: 0x050208,
          transparent: true, opacity: 0.94, depthWrite: true, fog: false, toneMapped: false });
        tongue.userData = { blackFlame: i + 0.5, baseY: h * 0.75 };
      }
    } else if (kind === "edge-flash") {
      object.rotation.y = Math.atan2(to?.dx || 0, to?.dz || 1);
      const pointsA = [], pointsB = [];
      for (let i = 0; i <= 18; i++) {
        const s = i / 18, z = s * radius;
        pointsA.push(new THREE.Vector3(Math.sin(s * Math.PI * 6) * 2.6, 3.2 + Math.cos(s * Math.PI * 6) * 1.8, z));
        pointsB.push(new THREE.Vector3(-Math.sin(s * Math.PI * 6) * 2.6, 3.2 - Math.cos(s * Math.PI * 6) * 1.8, z));
      }
      const flameDragon = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pointsA), reduced ? 18 : 48, 0.65, 6, false));
      flameDragon.material = new THREE.MeshBasicMaterial({ color: 0xff4500, transparent: true,
        opacity: 0.9, depthWrite: false, fog: false, toneMapped: false });
      const thunderDragon = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pointsB), reduced ? 18 : 48, 0.38, 6, false));
      thunderDragon.material = new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true,
        opacity: 0.95, depthWrite: false, fog: false, toneMapped: false });
      const head = mesh(new THREE.OctahedronGeometry(2.3), 0, 3.5, 4);
      head.material = new THREE.MeshBasicMaterial({ color: 0xfff0b3, transparent: true,
        opacity: 0.95, depthWrite: false, fog: false, toneMapped: false });
      head.userData = { dragonHead: true };
      const count = reduced ? 4 : 8;
      for (let i = 1; i <= count; i++) {
        const z = i * radius / count;
        const pillar = mesh(new THREE.BoxGeometry(1.1, 9, 1.1), (i % 2 ? 1 : -1) * 2.4, 4.5, z);
        pillar.userData = { stepPillar: i / count };
      }
    } else if (kind === "titan-meteor") {
      ring(radius);
      ring(radius * 0.5);
      const skyPortal = mesh(new THREE.RingGeometry(radius * 0.42, radius * 0.68, segments), 0, 34, 0);
      skyPortal.rotation.x = -Math.PI / 2;
      skyPortal.material = new THREE.MeshBasicMaterial({ color: 0x3b1d14, transparent: true,
        opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false });
      const meteor = mesh(new THREE.OctahedronGeometry(8.2, reduced ? 0 : 1), 0, 36, 0);
      meteor.material = new THREE.MeshBasicMaterial({ color: 0x3d281c, transparent: true,
        opacity: 0.98, depthWrite: true, fog: false, toneMapped: false });
      meteor.userData = { meteor: 1 };
      const rockMantle = mesh(new THREE.BoxGeometry(10.6, 10.6, 10.6), 0, 36, 0);
      rockMantle.rotation?.set?.(0.6, 0.8, 0.4);
      rockMantle.material = new THREE.MeshBasicMaterial({ color: 0x543828, transparent: true,
        opacity: 0.96, depthWrite: true, fog: false, toneMapped: false });
      rockMantle.userData = { meteor: 1 };
      const crust = mesh(new THREE.OctahedronGeometry(8.8, reduced ? 0 : 1), 0, 36, 0);
      crust.material = new THREE.MeshBasicMaterial({ color: 0xff5500, wireframe: true,
        transparent: true, opacity: 0.85, depthWrite: false, fog: false, toneMapped: false });
      crust.userData = { meteor: 1 };
      const secondRock = mesh(new THREE.OctahedronGeometry(6.8, reduced ? 0 : 1), 0, 46, 0);
      secondRock.material = new THREE.MeshBasicMaterial({ color: 0x2e1d14, transparent: true,
        opacity: 0.96, depthWrite: true, fog: false, toneMapped: false });
      secondRock.userData = { meteor: 2 };
      const shock = mesh(new THREE.RingGeometry(radius * 0.85, radius, segments), 0, 0.5, 0);
      shock.rotation.x = -Math.PI / 2;
      shock.userData = { impactWave: true };
      const count = reduced ? 5 : 10;
      for (let i = 0; i < count; i++) {
        const a = i * Math.PI * 2 / count;
        const spire = mesh(new THREE.BoxGeometry(2.1, 11, 2.1),
          Math.cos(a) * radius * 0.68, 0.2, Math.sin(a) * radius * 0.68);
        spire.rotation.y = a;
        spire.material = new THREE.MeshBasicMaterial({ color: i % 2 ? 0x3d281c : 0xd95b26,
          transparent: true, opacity: 0.95, depthWrite: true, fog: false, toneMapped: false });
        spire.userData = { impactSpire: true };
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
      source: ["anchor", "domain", "ward", "clone", "release-wave", "release-boundary",
        "blade-barrage", "singularity", "almighty-push", "omniscience", "edge-flash", "titan-meteor"].includes(kind) ? from : null });
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
    if (effect.kind === "almighty-push") {
      const charTarget = this.character?.()?._target;
      if (charTarget?.position) charTarget.position.y = 0;
    }
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
      } else if (effect.kind === "blade-barrage") {
        effect.object.children.forEach(item => {
          if (item.userData?.sword) {
            const activeAge = Math.max(0, effect.age - item.userData.delay);
            item.position.z = item.userData.baseZ + Math.min(effect.radius, activeAge * item.userData.speed);
            if (item.rotation) item.rotation.z = activeAge * 10;
          }
        });
      } else if (effect.kind === "singularity") {
        const merge = Math.min(1, effect.age / 0.7);
        const burst = effect.age > 1.95 ? 1 + (effect.age - 1.95) * 6 : 1;
        effect.object.children.forEach(item => {
          if (item.userData?.orb) {
            const angle = effect.age * 12 + (item.userData.orb > 0 ? 0 : Math.PI);
            const r = 10 * (1 - merge);
            item.position?.set?.(Math.cos(angle) * r, 6, Math.sin(angle) * r);
          } else if (item.userData?.core) {
            item.scale?.setScalar?.(merge * burst * (1 + Math.sin(effect.age * 20) * 0.12));
          } else if (item.userData?.gyro) {
            if (item.rotation) item.rotation.z += dt * 3 * item.userData.gyro;
            item.scale?.setScalar?.(burst);
          } else if (item.userData?.shard !== undefined) {
            const a = item.userData.shard + effect.age * 4;
            const r = Math.max(1.5, 18 * (1 - (effect.age % 1.2) / 1.2));
            item.position?.set?.(Math.cos(a) * r, 6, Math.sin(a) * r);
          }
        });
      } else if (effect.kind === "almighty-push") {
        const ascend = Math.min(1, effect.age / 0.4);
        const descend = effect.age > effect.duration - 0.5 ? Math.max(0, (effect.duration - effect.age) / 0.5) : 1;
        const flyY = 18 * ascend * descend + (ascend >= 1 && descend >= 1 ? Math.sin(effect.age * 6) * 0.6 : 0);
        const charTarget = this.character?.()?._target;
        if (charTarget?.position) {
          charTarget.position.y = flyY;
          effect.object.position?.set?.(charTarget.position.x, 0, charTarget.position.z);
        }
        const centerY = flyY + 3.2;
        const pulseAge = Math.max(0, effect.age - 0.3);
        const wave = (pulseAge % 0.95) / 0.95;
        effect.object.children.forEach(item => {
          if (item.userData?.pushOrigin) {
            item.position?.set?.(0, centerY, 0);
            item.scale?.setScalar?.(1 + Math.sin(effect.age * 18) * 0.2);
          } else if (item.userData?.pushDome) {
            item.position?.set?.(0, centerY, 0);
            const scale = effect.age < 0.3 ? 0.08 : (0.08 + wave * 0.98) * item.userData.pushDome;
            item.scale?.setScalar?.(scale);
          } else if (item.userData?.radial !== undefined) {
            const dist = effect.age < 0.3 ? 1.5 : 2 + wave * (effect.radius - 2);
            const pitch = item.userData.pitch || 0;
            item.position?.set?.(Math.cos(item.userData.radial) * dist,
              centerY + Math.sin(pitch) * dist * 0.45,
              Math.sin(item.userData.radial) * dist);
          }
        });
      } else if (effect.kind === "omniscience") {
        effect.material.opacity = Math.min(0.96, (1 - t) * 3.5);
        effect.object.scale.setScalar(Math.min(1, effect.age * 3));
        if (!effect.reduced) effect.object.rotation.y += dt * 1.4;
        effect.object.children.forEach(item => {
          if (item.userData?.blackFlame !== undefined) {
            const flicker = 0.82 + Math.sin(effect.age * 14 + item.userData.blackFlame * 2.1) * 0.24;
            item.scale?.setScalar?.(flicker);
            if (item.position) item.position.y = item.userData.baseY * flicker;
          }
        });
      } else if (effect.kind === "edge-flash") {
        const progress = Math.min(1, effect.age / 1.2);
        effect.object.children.forEach(item => {
          if (item.userData?.dragonHead) item.position.z = progress * effect.radius;
          else if (item.userData?.stepPillar !== undefined)
            item.scale?.setScalar?.(effect.age >= item.userData.stepPillar * 1.1 ? 1 : 0.01);
        });
      } else if (effect.kind === "titan-meteor") {
        const fall = Math.min(1, effect.age / 1.2);
        const fall2 = Math.min(1, Math.max(0, (effect.age - 0.25) / 1.1));
        const impacted = effect.age >= 1.2;
        effect.object.children.forEach(item => {
          if (item.userData?.meteor === 1) {
            item.position?.set?.(0, 36 * (1 - fall) + 4.5 * fall, 0);
            if (item.rotation) { item.rotation.y += dt * 3.2; item.rotation.x = (item.rotation.x || 0) + dt * 2.1; }
          } else if (item.userData?.meteor === 2) {
            item.position?.set?.(0, 46 * (1 - fall2) + 9.5 * fall2, 0);
            if (item.rotation) { item.rotation.y -= dt * 2.6; item.rotation.z = (item.rotation.z || 0) + dt * 1.8; }
          } else if (item.userData?.impactWave) {
            item.scale?.setScalar?.(impacted ? Math.min(1.3, (effect.age - 1.2) * 2.5) : 0.01);
          } else if (item.userData?.impactSpire) {
            item.position.y = impacted ? Math.min(5.5, (effect.age - 1.2) * 18) : -6;
          }
        });
      } else if (effect.kind !== "lightning") {
        effect.object.scale.setScalar(Math.max(0.2, effect.radius * t));
      }
    }
  }
  clear() { [...this.active].forEach(effect => this.remove(effect)); }
}
