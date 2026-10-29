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
      object.rotation.y = Math.atan2(to?.dx || 0, to?.dz || 1);
      const blue = mesh(new THREE.SphereGeometry(2.6, 16, 12), -8, 6.8, 5);
      blue.material = new THREE.MeshBasicMaterial({ color: 0x00d2ff, transparent: true,
        opacity: 0.92, depthWrite: false, fog: false, toneMapped: false });
      blue.userData = { orb: 1 };
      const red = mesh(new THREE.SphereGeometry(2.6, 16, 12), 8, 6.8, 5);
      red.material = new THREE.MeshBasicMaterial({ color: 0xff2a6d, transparent: true,
        opacity: 0.92, depthWrite: false, fog: false, toneMapped: false });
      red.userData = { orb: -1 };
      const inner = mesh(new THREE.SphereGeometry(4.2, 18, 14), 0, 6.8, 5);
      inner.material = new THREE.MeshBasicMaterial({ color: 0xffe6ff, transparent: true,
        opacity: 0.98, depthWrite: false, fog: false, toneMapped: false });
      inner.userData = { core: true };
      const core = mesh(new THREE.SphereGeometry(6.8, 22, 16), 0, 6.8, 5);
      core.material = new THREE.MeshBasicMaterial({ color: 0xb537f2, transparent: true,
        opacity: 0.9, depthWrite: false, fog: false, toneMapped: false });
      core.userData = { core: true };
      const shell = mesh(new THREE.SphereGeometry(9.2, 18, 14), 0, 6.8, 5);
      shell.material = new THREE.MeshBasicMaterial({ color: 0xff477e, wireframe: true,
        transparent: true, opacity: 0.72, depthWrite: false, fog: false, toneMapped: false });
      shell.userData = { core: true };
      for (let i = 0; i < 3; i++) {
        const gyro = mesh(new THREE.RingGeometry(9.8 + i * 1.8, 10.9 + i * 1.8, segments), 0, 6.8, 5);
        gyro.rotation?.set?.(i * 0.9, i * 0.6, i * 0.4);
        gyro.userData = { gyro: i + 1 };
      }
      const wakeCount = reduced ? 5 : 10;
      for (let i = 1; i <= wakeCount; i++) {
        const z = i * radius / wakeCount;
        const wake = mesh(new THREE.RingGeometry(6.5, 8.2, segments), 0, 6.8, z);
        wake.material = new THREE.MeshBasicMaterial({ color: i % 2 ? 0xd8b4fe : 0xff477e,
          transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false });
        wake.userData = { wakeZ: z };
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
    } else if (kind === "susanoo-mecha") {
      ring(radius);
      const armor = mesh(new THREE.BoxGeometry(12, 22, 8), 0, 12, 0);
      armor.material = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true,
        transparent: true, opacity: 0.52, depthWrite: false, fog: false, toneMapped: false });
      for (let i = 0; i < 4; i++) {
        const rib = mesh(new THREE.RingGeometry(6.5 + i * 0.8, 7.6 + i * 0.8, 6), 0, 4 + i * 4, 0);
        rib.rotation.x = Math.PI / 2;
      }
      const crest = mesh(new THREE.OctahedronGeometry(3.2), 0, 24, 2);
      crest.material = new THREE.MeshBasicMaterial({ color: 0xbae6fd, transparent: true,
        opacity: 0.92, depthWrite: false, fog: false, toneMapped: false });
      for (const side of [-1, 1]) {
        const katana = mesh(new THREE.BoxGeometry(1.1, 1.1, 26), side * 8, 11, 6);
        katana.material = new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true,
          opacity: 0.9, depthWrite: false, fog: false, toneMapped: false });
        katana.userData = { susanooBlade: side };
      }
    } else if (kind === "malevolent-shrine") {
      for (const existing of this.active) {
        if (existing.kind === "domain" || existing.kind === "ward") {
          existing.object.traverse(item => item.material?.color?.setHex?.(0x1f0408));
        }
      }
      ring(radius);
      for (const side of [-6, 6]) {
        const pillar = mesh(new THREE.BoxGeometry(1.8, 16, 1.8), side, 8, -4);
        pillar.material = new THREE.MeshBasicMaterial({ color: 0x1a0508, transparent: true,
          opacity: 0.96, depthWrite: true, fog: false, toneMapped: false });
      }
      const roof = mesh(new THREE.BoxGeometry(18, 2.2, 3.2), 0, 15.5, -4);
      roof.material = new THREE.MeshBasicMaterial({ color: 0x7f1d1d, transparent: true,
        opacity: 0.96, depthWrite: true, fog: false, toneMapped: false });
      const beam = mesh(new THREE.BoxGeometry(14, 1.4, 2.2), 0, 12, -4);
      beam.material = new THREE.MeshBasicMaterial({ color: 0x1a0508, transparent: true,
        opacity: 0.96, depthWrite: true, fog: false, toneMapped: false });
      const skull = mesh(new THREE.OctahedronGeometry(3.4), 0, 7.5, -3);
      skull.material = new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true,
        opacity: 0.9, depthWrite: false, fog: false, toneMapped: false });
      const count = reduced ? 10 : 24;
      for (let i = 0; i < count; i++) {
        const a = i * Math.PI * 2 / count;
        const slash = mesh(new THREE.BoxGeometry(0.32, 0.32, 14),
          Math.cos(a) * radius * 0.55, 2 + (i % 5) * 2.2, Math.sin(a) * radius * 0.55);
        slash.rotation.y = a + 0.8;
        slash.rotation.z = (i % 3 - 1) * 0.6;
        slash.material = new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffffff : 0xff2a4b,
          transparent: true, opacity: 0.9, depthWrite: false, fog: false, toneMapped: false });
        slash.userData = { shrineSlash: i };
      }
    } else if (kind === "planetary-devastation") {
      ring(radius);
      const core = mesh(new THREE.SphereGeometry(4.8, 18, 14), 0, 6, 0);
      core.material = new THREE.MeshBasicMaterial({ color: 0x050208, transparent: true,
        opacity: 0.98, depthWrite: true, fog: false, toneMapped: false });
      core.userData = { chibakuCore: true };
      const halo = mesh(new THREE.RingGeometry(5.8, 7.6, segments), 0, 6, 0);
      halo.material = new THREE.MeshBasicMaterial({ color: 0xe9d5ff, transparent: true,
        opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false });
      halo.userData = { chibakuCore: true };
      const planetInner = mesh(new THREE.SphereGeometry(13.5, reduced ? 8 : 12, reduced ? 6 : 10), 0, 6, 0);
      planetInner.material = new THREE.MeshBasicMaterial({ color: 0x4a3222, transparent: true,
        opacity: 0.97, depthWrite: true, fog: false, toneMapped: false });
      planetInner.userData = { chibakuPlanet: 1 };
      const planetCrust = mesh(new THREE.SphereGeometry(14.4, reduced ? 7 : 9, reduced ? 5 : 7), 0, 6, 0);
      planetCrust.material = new THREE.MeshBasicMaterial({ color: 0x362317, transparent: true,
        opacity: 0.94, depthWrite: true, fog: false, toneMapped: false });
      planetCrust.userData = { chibakuPlanet: 2 };
      const count = reduced ? 10 : 18;
      const rockColors = [0x3d281c, 0x543828, 0x694835];
      for (let i = 0; i < count; i++) {
        const a = i * Math.PI * 2 / count;
        const size = 6.8 + (i % 3) * 1.6;
        const rock = mesh(i % 2 ? new THREE.OctahedronGeometry(size) : new THREE.BoxGeometry(size * 1.2, size, size * 1.1),
          Math.cos(a) * radius * 0.95, 2.5, Math.sin(a) * radius * 0.95);
        rock.rotation?.set?.(i * 0.7, a, i * 0.5);
        rock.material = new THREE.MeshBasicMaterial({ color: rockColors[i % rockColors.length],
          transparent: true, opacity: 0.97, depthWrite: true, fog: false, toneMapped: false });
        rock.userData = { chibakuRock: a, offset: ((i % 5) - 2) * 3.8 };
      }
    } else if (kind === "time-rewind") {
      ring(radius);
      ring(radius * 0.65);
      const skyClock = mesh(new THREE.RingGeometry(radius * 0.72, radius * 0.8, segments), 0, 14, 0);
      skyClock.rotation.x = -Math.PI / 2;
      const handLong = mesh(new THREE.BoxGeometry(0.85, 0.4, radius * 0.85), 0, 0.6, 0);
      handLong.material = new THREE.MeshBasicMaterial({ color: 0xfff3b0, transparent: true,
        opacity: 0.95, depthWrite: false, fog: false, toneMapped: false });
      handLong.userData = { clockHand: -8 };
      const handShort = mesh(new THREE.BoxGeometry(1.2, 0.5, radius * 0.55), 0, 0.7, 0);
      handShort.userData = { clockHand: -2.5 };
      for (let i = 0; i < 12; i++) {
        const a = i * Math.PI / 6;
        const tick = mesh(new THREE.BoxGeometry(0.9, 3.5, 2.2),
          Math.cos(a) * radius * 0.9, 1.75, Math.sin(a) * radius * 0.9);
        tick.rotation.y = -a;
      }
    } else if (kind === "aurora-excalibur") {
      object.rotation.y = Math.atan2(to?.dx || 0, to?.dz || 1);
      const skyPillar = mesh(new THREE.BoxGeometry(3.8, 44, 3.8), 0, 22, 0);
      skyPillar.material = new THREE.MeshBasicMaterial({ color: 0xffe57f, transparent: true,
        opacity: 0.92, depthWrite: false, fog: false, toneMapped: false });
      skyPillar.userData = { excaliburPillar: true };
      const outerBeam = mesh(new THREE.BoxGeometry(7.2, 5.2, radius), 0, 3.8, radius / 2);
      outerBeam.material = new THREE.MeshBasicMaterial({ color: 0x64ffda, transparent: true,
        opacity: 0.82, depthWrite: false, fog: false, toneMapped: false });
      outerBeam.userData = { excaliburBeam: true };
      const innerBeam = mesh(new THREE.BoxGeometry(3.4, 3.0, radius), 0, 3.8, radius / 2);
      innerBeam.material = new THREE.MeshBasicMaterial({ color: 0xfff59d, transparent: true,
        opacity: 0.96, depthWrite: false, fog: false, toneMapped: false });
      innerBeam.userData = { excaliburBeam: true };
      const count = reduced ? 5 : 10;
      for (let i = 1; i <= count; i++) {
        const r = mesh(new THREE.RingGeometry(4.2, 5.2, segments), 0, 3.8, i * radius / count);
        r.material = new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true,
          opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false });
      }
    } else if (kind === "infinite-void") {
      for (const existing of this.active) {
        if (existing.kind === "domain" || existing.kind === "ward") {
          existing.object.traverse(item => item.material?.color?.setHex?.(0x04020a));
        }
      }
      ring(radius);
      const voidDome = mesh(new THREE.SphereGeometry(radius, segments, reduced ? 10 : 18, 0, Math.PI * 2, 0, Math.PI / 2));
      voidDome.material = new THREE.MeshBasicMaterial({ color: 0x05020d, transparent: true,
        opacity: 0.88, side: THREE.DoubleSide, depthWrite: true, fog: false, toneMapped: false });
      const horizon = mesh(new THREE.RingGeometry(8, 15, segments), 0, 9, 0);
      horizon.rotation.x = Math.PI / 2.3;
      horizon.material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true,
        opacity: 0.92, side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false });
      horizon.userData = { voidStar: 0 };
      const count = reduced ? 10 : 24;
      for (let i = 0; i < count; i++) {
        const a = i * Math.PI * 2 / count;
        const r = radius * (0.28 + (i % 4) * 0.16);
        const star = mesh(new THREE.OctahedronGeometry(1.1), Math.cos(a) * r, 3 + (i % 6) * 2.5, Math.sin(a) * r);
        star.material = new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffffff : 0x7dd3fc,
          transparent: true, opacity: 0.95, depthWrite: false, fog: false, toneMapped: false });
        star.userData = { voidStar: a, orbitR: r, orbitY: 3 + (i % 6) * 2.5 };
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
        "blade-barrage", "singularity", "almighty-push", "omniscience", "edge-flash", "titan-meteor",
        "susanoo-mecha", "malevolent-shrine", "planetary-devastation", "time-rewind", "aurora-excalibur", "infinite-void"].includes(kind) ? from : null });
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
        const merge = Math.min(1, effect.age / 0.4);
        const shoot = Math.max(0, Math.min(1, (effect.age - 0.35) / Math.max(0.1, effect.duration - 0.35)));
        const zPos = 5 + shoot * effect.radius;
        effect.object.children.forEach(item => {
          if (item.userData?.orb) {
            const angle = effect.age * 14 + (item.userData.orb > 0 ? 0 : Math.PI);
            const r = 9 * (1 - merge);
            item.position?.set?.(Math.cos(angle) * r, 6.8 + Math.sin(angle) * r * 0.4, 5);
            item.scale?.setScalar?.(Math.max(0.01, 1 - merge * 0.95));
          } else if (item.userData?.core) {
            item.position?.set?.(0, 6.8, zPos);
            item.scale?.setScalar?.((0.15 + merge * 0.85) * (1 + Math.sin(effect.age * 24) * 0.1));
            if (item.rotation) item.rotation.y = (item.rotation.y || 0) + dt * 5;
          } else if (item.userData?.gyro) {
            item.position?.set?.(0, 6.8, zPos);
            if (item.rotation) item.rotation.z += dt * 4 * item.userData.gyro;
            item.scale?.setScalar?.(0.15 + merge * 0.85);
          } else if (item.userData?.wakeZ !== undefined) {
            item.scale?.setScalar?.(zPos >= item.userData.wakeZ ? 1.15 : 0.01);
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
      } else if (effect.kind === "susanoo-mecha") {
        const charTarget = this.character?.()?._target;
        if (charTarget?.position) effect.object.position?.set?.(charTarget.position.x, 0, charTarget.position.z);
        effect.object.children.forEach(item => {
          if (item.userData?.susanooBlade && item.rotation)
            item.rotation.y = Math.sin(effect.age * 7) * 1.4 * item.userData.susanooBlade;
        });
      } else if (effect.kind === "malevolent-shrine") {
        effect.object.children.forEach(item => {
          if (item.userData?.shrineSlash !== undefined && item.rotation) {
            item.rotation.y += dt * 12;
            item.scale?.setScalar?.(0.6 + Math.abs(Math.sin(effect.age * 18 + item.userData.shrineSlash)) * 0.7);
          }
        });
      } else if (effect.kind === "planetary-devastation") {
        const rise = Math.min(1, effect.age / 0.55);
        const pull = Math.min(1, Math.max(0, (effect.age - 0.3) / 1.35));
        const crush = effect.age >= 1.85 ? Math.min(1, (effect.age - 1.85) / 0.4) : 0;
        const coreY = (6 + 20 * rise) * (1 - crush) + 10 * crush;
        effect.object.children.forEach(item => {
          if (item.userData?.chibakuCore) {
            item.position?.set?.(0, coreY, 0);
            if (item.rotation) item.rotation.z += dt * 4;
          } else if (item.userData?.chibakuPlanet) {
            item.position?.set?.(0, coreY, 0);
            item.scale?.setScalar?.(0.08 + pull * 0.95);
            if (item.rotation) {
              item.rotation.y = (item.rotation.y || 0) + dt * (item.userData.chibakuPlanet === 1 ? 1.8 : -1.4);
              item.rotation.x = (item.rotation.x || 0) + dt * 0.9;
            }
          } else if (item.userData?.chibakuRock !== undefined) {
            const a = item.userData.chibakuRock + effect.age * 3.2;
            const r = effect.radius * 0.95 * (1 - pull) + 9.5 * pull;
            const y = 2.5 * (1 - pull) + (coreY + item.userData.offset) * pull;
            item.position?.set?.(Math.cos(a) * r, y, Math.sin(a) * r);
            if (item.rotation) {
              item.rotation.x = (item.rotation.x || 0) + dt * 2.5;
              item.rotation.y = (item.rotation.y || 0) + dt * 3.1;
            }
          }
        });
      } else if (effect.kind === "time-rewind") {
        effect.object.children.forEach(item => {
          if (item.userData?.clockHand && item.rotation)
            item.rotation.y = (item.rotation.y || 0) + dt * item.userData.clockHand;
        });
      } else if (effect.kind === "aurora-excalibur") {
        const cleaved = effect.age >= 0.35;
        effect.object.children.forEach(item => {
          if (item.userData?.excaliburPillar)
            item.scale?.setScalar?.(cleaved ? Math.max(0.1, 1 - (effect.age - 0.35) * 1.5) : 1);
          else if (item.userData?.excaliburBeam)
            item.scale?.setScalar?.(cleaved ? 1 + Math.sin(effect.age * 20) * 0.15 : 0.05);
        });
      } else if (effect.kind === "infinite-void") {
        effect.material.opacity = Math.min(0.95, (1 - t) * 3.5);
        effect.object.children.forEach(item => {
          if (item.userData?.voidStar !== undefined) {
            if (item.userData.orbitR) {
              const a = item.userData.voidStar + effect.age * 1.8;
              item.position?.set?.(Math.cos(a) * item.userData.orbitR, item.userData.orbitY, Math.sin(a) * item.userData.orbitR);
            } else if (item.rotation) item.rotation.z += dt * 2.5;
          }
        });
      } else if (effect.kind !== "lightning") {
        effect.object.scale.setScalar(Math.max(0.2, effect.radius * t));
      }
    }
  }
  clear() { [...this.active].forEach(effect => this.remove(effect)); }
}
