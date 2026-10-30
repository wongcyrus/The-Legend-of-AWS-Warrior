import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.118.1/build/three.module.js";
import { FBXLoader } from "https://cdn.jsdelivr.net/npm/three@0.118.1/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.118.1/examples/jsm/loaders/GLTFLoader.js";
import { entity } from "../src/entity.js";
import { entity_manager } from "../src/entity-manager.js";
import { player_entity } from "../src/player-entity.js";
import { player_input } from "../src/player-input.js";
import { npc_entity } from "../src/npc-entity.js";
import { health_component } from "../src/health-component.js";
import { inventory_controller } from "../src/inventory-controller.js";
import { equip_weapon_component } from "../src/equip-weapon-component.js";
import { attack_controller } from "../src/attacker-controller.js";
import { level_up_component } from "../src/level-up-component.js";
import { spatial_hash_grid } from "../src/spatial-hash-grid.js";
import { spatial_grid_controller } from "../src/spatial-grid-controller.js";
import { baseUrl } from "../src/constant.js";
import { Assets } from "./assets.js?v=20261027-maps-1";
import { GameApi, QUEST_KEY, MARKS_RESET_KEY } from "./api.js?v=20261029-ajax-collision-1";
import { GameSave, initialGameSave } from "./game-save.js?v=20261029-save-1";
import { World } from "./world.js?v=20261029-ajax-collision-1";
import { MAPS, isSafePosition, nearbyGate, isMagicWaveClear } from "./maps.js?v=20261029-monster-density-1";
import { sharedResources, disposeMap, cleanupExpiredEffects } from "./map-lifecycle.js?v=20261029-v2-features-1";
import { drawMinimap } from "./minimap.js?v=20261029-v2-features-1";
import { WorldEvents } from "./world-events.js?v=20261029-v2-features-1";
import { createRenderer, WebGLUnavailableError } from "./renderer.js";
import { findMeleeTargets, findMovementBlockers } from "./combat.js?v=20261027-equipment-1";
import { GuidePatrol, guideArchetype } from "./guides.js?v=20261029-guides-1";
import { SoundEffects } from "./audio.js?v=20261030-male-tts-1";
import { WEAPONS, FINISHES, AdventureProgress, DodgeMotion } from "./adventure.js?v=20261027-equipment-1";
import { CombatFeedback } from "./feedback.js";
import { findMonsterSpawn, MonsterRespawns } from "./spawning.js?v=20261027-maps-1";
import { BUILDINGS, GUIDES, LAKE, PLAYER_SPAWN, CHESTS, BOSS, regionAt, seededRandom } from "./layout.js";
import { MONSTERS, monsterFor, superMonsterProfile, clearShot, SpikeShots } from "./monsters.js?v=20261029-monsters-1";
import { MonsterModels } from "./monster-models.js?v=20261028-magic-1";
import { SHIELDS, ShieldGuard } from "./shields.js?v=20261029-v2-features-1";
import { equipmentIcon, nextWeapon } from "./equipment-ui.js?v=20261027-equipment-bar-1";
import { AWS_SERVICES, AWS_LANDMARKS, BUILDING_SERVICES, CLOUD_REGIONS, missionServices } from "./aws-theme.js?v=20261028-voice-1";
import { loadServiceImages } from "./aws-world.js?v=20261029-sign-post-1";
import { bindServiceReader } from "./aws-service-reader.js?v=20261030-click-fix-1";
import { SPELLS, FULL_RELEASE_RANGE, comboArtFor, spellDamage, MagicWallet, MagicCombat } from "./magic.js?v=20261030-recovery-hp-1";
import { MagicEffects } from "./magic-effects.js?v=20261030-anime-combos-6";

class BasicCharacterController extends player_entity.BasicCharacterController {
  Update(dt) {
    const game = this._params.game;
    if (this._target?.position) this._target.position.y = 0;
    this._animations.attack?.action.setEffectiveTimeScale(
      WEAPONS[game.weapon].speed * (game.worldEvents?.attackSpeedMultiplier || 1));
    if (this.frostSlow > 0) this.frostSlow = Math.max(0, this.frostSlow - dt);
    if (game.dodge.active || game.progressChanging || game.traveling) {
      this._velocity.set(0, 0, 0);
      this._mixer?.update(dt);
      return;
    }
    const keys = this.GetComponent("BasicCharacterControllerInput")._keys;
    const shift = keys.shift, acceleration = this._acceleration.z;
    const equipped = this.GetComponent("EquipWeapon");
    if (game.guard.active || (game.weapon !== "Unarmed" && !equipped._target?.parent)) keys.space = false;
    this._acceleration.z *= (game.worldEvents?.speedMultiplier || 1) * (this.frostSlow > 0 ? 0.7 : 1);
    if (game.guard.active) {
      keys.shift = false;
      this._acceleration.z *= 0.4;
      this._velocity.z = THREE.MathUtils.clamp(this._velocity.z, -4, 4);
    }
    try { super.Update(dt); }
    finally {
      if (this.tapAttack) { keys.space = false; this.tapAttack = false; }
      keys.shift = shift;
      this._acceleration.z = acceleration;
    }
  }

  _FindIntersections(position) {
    const blocked = clearShot(this._parent._position, position, (x, z) => this._params.world.canWalk(x, z)) ?
      findMovementBlockers(this._params.game.grid, this._parent, position) : [true];
    if (blocked.length) {
      this._velocity?.set(0, 0, 0);
      if (this._target) this._parent.SetQuaternion?.(this._target.quaternion);
    }
    return blocked;
  }
}

class BasicCharacterControllerInput extends player_input.BasicCharacterControllerInput {
  _onKeyDown(event) {
    if (event.target?.closest?.("input, select, dialog")) return;
    const game = this._params.game;
    if (game?.player && !game.player.GetComponent("HealthComponent")?.IsAlive?.()) {
      if (!event.repeat && ["Space", "Enter", "KeyR", "KeyH"].includes(event.code)) {
        event.preventDefault();
        game.returnHome();
        return;
      }
    }
    if (event.code === "KeyX") {
      event.preventDefault();
      if (!event.repeat) this._params.game.castMagic();
      return;
    }
    if (event.code === "KeyR" || event.key?.toLowerCase() === "r") {
      event.preventDefault();
      if (!event.repeat) this._params.game.startBlock();
      return;
    }
    if (!event.repeat && (event.code === "KeyT" || event.key?.toLowerCase() === "t" || event.keyCode === 84)) {
      event.preventDefault();
      this._params.game.useGate();
      return;
    }
    if (event.code === "KeyE" && !event.repeat) {
      event.preventDefault();
      this._params.game.talkToGuide();
      return;
    }
    if (!event.repeat && ["KeyQ", "KeyF", "Digit1", "Digit2", "Digit0"].includes(event.code)) {
      event.preventDefault();
      const game = this._params.game;
      if (game.progressChanging) return;
      if (event.code === "KeyQ") game.tryDodge();
      else if (event.code === "KeyF") game.openNearbyChest();
      else game.selectWeapon({ Digit1: "Sword", Digit2: "Axe", Digit0: "Unarmed" }[event.code]);
      return;
    }
    const spellSlots = { Digit3: "lightning", Digit4: "fireball", Digit5: "frost", Digit6: "storm", Digit7: "shockwave" };
    if (!event.repeat && Object.hasOwn(spellSlots, event.code)) {
      event.preventDefault();
      if (!this._params.game.progressChanging) this._params.game.toggleSpell?.(spellSlots[event.code]);
      return;
    }
    if (!event.repeat && (event.code === "KeyC" || event.code === "KeyV") &&
        !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const game = this._params.game;
      if (game.progressChanging) return;
      const step = event.shiftKey ? -1 : 1;
      if (event.code === "KeyC") game.cycleWeapon?.(step);
      else game.cycleShield?.(step);
      return;
    }
    if (event.target?.closest?.("button, a, summary")) return;
    if (["Space", "KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) event.preventDefault();
    super._onKeyDown(event);
  }

  _onMouseUp() {
    // Guide interaction stays on E; don't invoke Classic's picker.
  }

  _onKeyUp(event) {
    if (event.code === "KeyR" || event.key?.toLowerCase() === "r") this._params.game.guard.release();
    super._onKeyUp(event);
  }
}

class SpatialGridController extends spatial_grid_controller.SpatialGridController {
  _OnPosition(message) {
    if (this._client) super._OnPosition(message);
  }

  FindNearbyEntities(range) {
    if (range !== 2) return super.FindNearbyEntities(range);
    const weapon = this._parent.GetComponent("EquipWeapon");
    const controller = this._parent.GetComponent("BasicCharacterController");
    return findMeleeTargets(this._grid, this._parent, WEAPONS[weapon?.Name]?.reach || 5)
      .filter(({ entity: target }) => !controller ||
        clearShot(this._parent._position, target._position, (x, z) => controller._params.world.canWalk(x, z)));
  }
}

class QuestComponent extends entity.Component {
  constructor(game) { super(); this.game = game; }
  InitComponent() {
    this._RegisterHandler("input.picked", () => this.game.talk(this._parent));
  }
}

class GuideController extends entity.Component {
  constructor(game, home, index = 0) {
    super();
    this.game = game;
    this.archetype = guideArchetype(index);
    this.patrol = new GuidePatrol({
      home, random: seededRandom(Math.round((home.x + 200) * 1000 + home.z + 200)),
      canStep: (x, z) => game.world.canWalk(x, z) &&
        !game.grid.FindNear([x, z], [8, 8]).some(({ entity: actor }) =>
          actor !== this._parent && actor.GetComponent("HealthComponent")?.IsAlive() !== false &&
          Math.hypot(actor._position.x - x, actor._position.z - z) < 4),
    });
  }

  InitComponent() {
    this.load().catch(error => this.game.fail(error));
  }

  async load() {
    let model, idleClip, walkClip;
    if (this.archetype.format === "glb") {
      const loader = new GLTFLoader();
      const gltf = await new Promise((resolve, reject) => loader.load(this.archetype.model, resolve, undefined, reject));
      model = gltf.scene || gltf;
      const clips = gltf.animations || [];
      idleClip = clips.find(c => this.archetype.idleClip.test(c.name)) || clips[0];
      const rawWalk = clips.find(c => this.archetype.walkClip.test(c.name)) || idleClip;
      walkClip = rawWalk.clone();
    } else {
      const loader = new FBXLoader();
      const load = url => new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
      const [fbxModel, idle, walk] = await Promise.all([
        load(this.archetype.model),
        load(this.archetype.idle),
        load(this.archetype.walk),
      ]);
      model = fbxModel;
      idleClip = idle.animations[0];
      walkClip = walk.animations[0].clone();
      walkClip.tracks = walkClip.tracks.filter(track => model.getObjectByName(track.name.split(".")[0]));
    }
    this.model = model;
    model.scale.setScalar(this.archetype.scale);
    model.traverse(object => {
      object.castShadow = true;
      object.receiveShadow = true;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material?.map) material.map.encoding = THREE.sRGBEncoding;
      }
    });
    this._parent._mesh = model;
    this.game.scene.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    for (const track of walkClip.tracks.filter(track => /(?:Hips|Bone)\.position$/.test(track.name))) {
      for (let i = 3; i < track.values.length; i += 3) {
        track.values[i] = track.values[0];
        track.values[i + 2] = track.values[2];
      }
    }
    this.actions = { idle: this.mixer.clipAction(idleClip), walk: this.mixer.clipAction(walkClip) };
    this.action = this.actions.idle;
    this.action.play();
    this.syncModel();
  }

  syncModel() {
    this.model.position.copy(this._parent._position);
    this.model.position.y = this.archetype.yOffset ?? 0.35;
    this.model.quaternion.copy(this._parent._rotation);
  }

  Update(dt) {
    if (!this.model) return;
    const nearPlayer = this.game.player._position.distanceTo(this._parent._position) < 6;
    const speaking = this.game.speakingGuide === this._parent &&
      (this.game.talking || document.getElementById("task-dialog").open);
    this.patrol.update(dt, nearPlayer || speaking);
    const { x, z } = this.patrol.position;
    this._parent.SetPosition(new THREE.Vector3(x, 0, z));
    if (this.patrol.walking) this._parent.SetQuaternion(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.patrol.heading));
    this.syncModel();
    const action = this.patrol.walking ? this.actions.walk : this.actions.idle;
    if (action !== this.action) {
      action.reset().play();
      this.action.crossFadeTo(action, 0.2, false);
      this.action = action;
    }
    this.mixer.update(dt);
  }
}

class NPCController extends npc_entity.NPCController {
  _LoadModels() {
    const name = this._params.resourceName.replace(".fbx", "");
    this._params.game.monsterModels.load(name).then(() => this.setMonster(name)).catch(error => {
      this._params.game.failed = true;
      this._params.game.fail(new Error(`Could not load ${name}. Reload to try again. ${error.message}`));
    });
  }

  setMonster(name, elite = false) {
    if (this.kind === name && Boolean(this.elite) === elite) return;
    const { model, animations } = this._params.game.monsterModels.create(name);
    this._stateMachine._currentState?.Exit();
    this._stateMachine._currentState = null;
    if (this._target) {
      this._mixer.stopAllAction();
      this._mixer.uncacheRoot(this._target);
      this._params.game.monsterModels.release(this._target);
    }
    this.kind = name;
    this.elite = elite;
    this.profile = this._params.boss ? {
      ...MONSTERS.Cyclops, label: BOSS.name, health: 480, damage: 16,
      scale: 0.084, windup: 1.15, cooldown: 1,
    } : elite ? superMonsterProfile(name, this._params.game.map.id) : MONSTERS[name];
    this._target = model;
    this._target.scale.setScalar(this.profile.scale);
    this.labelHeight = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).y + 3;
    if (elite) model.traverse(object => {
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material?.emissive) {
          material.emissive.setHex(this.profile.color);
          material.emissiveIntensity = 0.3;
        }
      }
    });
    this._target.position.copy(this._parent._position);
    this._params.scene.add(model);
    this._mixer = new THREE.AnimationMixer(model);
    for (const [state, source] of Object.entries(animations)) {
      const clip = source.clone();
      clip.name = state;
      this._animations[state] = { clip, action: this._mixer.clipAction(clip) };
    }
    this._stateMachine.SetState("idle");
    this._acceleration.z = this.profile.acceleration;
    this._OnPosition({ value: this._parent._position });
  }

  _OnPosition(message) {
    super._OnPosition(message);
    if (this._target && this.profile) this._target.position.y = this.profile.hover;
  }

  _OnAIWalk(dt) {
    if (this.profile.ranged) {
      this._velocity.set(0, 0, 0);
      this._input._keys.forward = false;
      if (this._FindPlayer().length()) {
        const player = this.FindEntity("player");
        this._target.lookAt(player._position.x, this._target.position.y, player._position.z);
        this._parent.SetQuaternion(this._target.quaternion);
      }
      return;
    }
    super._OnAIWalk(dt);
    this._input._keys.space = false;
  }

  _UpdateAI(dt) {
    const attack = this.GetComponent("EnemyAttackController");
    if (attack && attack.remaining !== null) return;
    super._UpdateAI(dt);
  }

  Update(dt) {
    if (this._params.game.traveling) return;
    if (this.parried > 0) this.parried = Math.max(0, this.parried - dt);
    if (this.magicSlow > 0) {
      this.magicSlow = Math.max(0, this.magicSlow - dt);
      dt *= 0.4;
    }
    super.Update(dt);
    if (this.kind === "Bat" && this._target && this.GetComponent("HealthComponent").IsAlive()) {
      this._target.position.y = this.profile.hover + Math.sin(this._params.game.clock.elapsedTime * 7) * 0.35;
    }
  }

  _OnDeath() {
    if (this._stateMachine._currentState?.Name === "death") return;
    this._stateMachine.SetState("death");
    this._params.game.sound.play("death");
    this._params.game.defeated++;
    document.getElementById("defeated").textContent = this._params.game.defeated;
    this._params.game.onMonsterDefeated?.(this._parent._position);
    this._params.game.grade(this.GetComponent("HealthComponent").deathGradeBatch);
    if (this._params.boss) this._params.game.rewardBoss();
    else this._params.game.respawns.schedule(this._parent);
  }

  _FindIntersections(position) {
    const blocked = clearShot(this._parent._position, position, (x, z) => this._params.world.canWalk(x, z)) ?
      findMovementBlockers(this._params.game.grid, this._parent, position) : [true];
    if (blocked.length) {
      this._velocity?.set(0, 0, 0);
      if (this._target) this._parent.SetQuaternion?.(this._target.quaternion);
    }
    return blocked;
  }

  _FindPlayer() {
    const player = this.FindEntity("player");
    if (this._params.boss && player._position.distanceTo(new THREE.Vector3(BOSS.x, 0, BOSS.z)) > 28) {
      return new THREE.Vector3();
    }
    if (isSafePosition(this._params.game.map, player._position.x, player._position.z)) {
      return new THREE.Vector3();
    }
    if (player._position.distanceTo(this._parent._position) > 36) return new THREE.Vector3();
    return super._FindPlayer();
  }
}

class EnemyAttackController extends entity.Component {
  constructor(game, boss = false) {
    super(); this.game = game; this.boss = boss; this.remaining = null; this.cooldown = 0;
  }

  InitComponent() {
    this.ring = this.game.world.mesh(new THREE.RingGeometry(5, 5.5, 32),
      new THREE.MeshBasicMaterial({ color: 0xffb95e, transparent: true, opacity: 0.7,
        side: THREE.DoubleSide, depthWrite: false }), 0, 0.12, 0);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.aimLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3(),
    ]), new THREE.LineBasicMaterial({ color: 0xe7ee7c }));
    this.aimLine.visible = false;
    this.game.scene.add(this.aimLine);
  }

  reset() {
    this.remaining = null; this.cooldown = 1; this.ring.visible = false;
    this.aimLine.visible = false;
    this.aim = null;
  }

  updateSuperLabel(controller, health) {
    const visible = Boolean(controller.elite && controller._target?.visible && health.IsAlive());
    if (!visible) {
      if (this.superLabel) this.superLabel.visible = false;
      return;
    }
    if (!this.superLabel) {
      const canvas = document.createElement("canvas");
      canvas.width = 512; canvas.height = 160;
      const texture = new THREE.CanvasTexture(canvas);
      texture.encoding = THREE.sRGBEncoding;
      this.superLabel = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture, transparent: true, depthWrite: false, fog: false,
      }));
      this.superLabel.scale.set(16, 5, 1);
      this.game.scene.add(this.superLabel);
    }
    this.superLabel.visible = true;
    this.superLabel.position.copy(this._parent._position);
    this.superLabel.position.y += controller.labelHeight ?? 24;
    const title = `${controller.profile.label}: ${Math.ceil(health._health)} / ${health._maxHealth} HP`;
    if (this.superLabel.userData.title === title) return;
    this.superLabel.userData.title = title;
    const canvas = this.superLabel.material.map.image, ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#161e2df2";
    ctx.fillRect(0, 0, 512, 160);
    ctx.strokeStyle = "#ff9900"; ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 506, 154);
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffb454"; ctx.font = "bold 28px sans-serif";
    ctx.fillText("SUPER MONSTER", 256, 38);
    ctx.fillStyle = "#ffffff"; ctx.font = "bold 32px sans-serif";
    ctx.fillText(controller.profile.label, 256, 78);
    ctx.fillStyle = "#3c4350"; ctx.fillRect(24, 92, 464, 18);
    ctx.fillStyle = "#ff684f";
    ctx.fillRect(24, 92, 464 * health._health / health._maxHealth, 18);
    ctx.fillStyle = "#ffffff"; ctx.font = "22px sans-serif";
    ctx.fillText(`${Math.ceil(health._health)} / ${health._maxHealth} HP`, 256, 140);
    this.superLabel.material.map.needsUpdate = true;
  }

  Update(dt) {
    const health = this.GetComponent("HealthComponent");
    const controller = this.GetComponent("NPCController");
    const player = this.game.player;
    this.updateSuperLabel(controller, health);
    if (this.game.traveling || !controller._stateMachine._currentState || !health.IsAlive() ||
        !player.GetComponent("HealthComponent").IsAlive()) { this.reset(); return; }
    const profile = controller.profile;
    this.cooldown = Math.max(0, this.cooldown - dt);
    const distance = this._parent._position.distanceTo(player._position);
    const safe = isSafePosition(this.game.map, player._position.x, player._position.z);
    if (safe) { this.reset(); return; }
    const clear = () => clearShot(this._parent._position, player._position,
      (x, z) => this.game.world.canWalk(x, z));
    if (this.remaining === null) {
      if (this.cooldown > 0 || !clear()) return;
      if (distance > profile.range) {
        if (controller.elite && this.game.map?.id === "dungeon" && distance <= 22) {
          const dx = this._parent._position.x - player._position.x;
          const dz = this._parent._position.z - player._position.z;
          const stepX = player._position.x + dx / distance * 4.5;
          const stepZ = player._position.z + dz / distance * 4.5;
          if (this.game.world.canWalk(stepX, stepZ) &&
              (!this.game.grid || findMovementBlockers(this.game.grid, this._parent, { x: stepX, z: stepZ }).length === 0)) {
            this.game.magicEffects?.spawn("seal", this._parent._position, { range: 3.5, color: profile.color }, 1);
            controller._position?.set?.(stepX, 0, stepZ);
            controller._target?.position?.set?.(stepX, controller.profile.hover || 0, stepZ);
            this._parent.SetPosition?.(controller._position || { x: stepX, y: 0, z: stepZ });
            this.game.magicEffects?.spawn("seal", this._parent._position, { range: 3.5, color: profile.color }, 1);
          } else return;
        } else return;
      }
      this.remaining = profile.windup;
      const cue = { Yeti: "yeti", Cactus: "cactus", Bat: "bat" }[controller.kind];
      if (cue) this.game.sound.play(cue, distance);
      this.aim = { x: player._position.x, z: player._position.z };
      controller._velocity.set(0, 0, 0);
      controller._stateMachine.SetState("attack");
      this.ring.position.set(this._parent._position.x, 0.12, this._parent._position.z);
      this.ring.scale.setScalar(profile.ranged ? 0.7 : profile.reach / 5.5);
      this.ring.visible = true;
      if (profile.ranged) {
        const points = this.aimLine.geometry.attributes.position;
        points.setXYZ(0, this._parent._position.x, 0.2, this._parent._position.z);
        points.setXYZ(1, this.aim.x, 0.2, this.aim.z);
        points.needsUpdate = true;
        this.aimLine.geometry.computeBoundingSphere();
        this.aimLine.visible = true;
      }
    } else {
      this.remaining -= dt;
      this.ring.position.set(this._parent._position.x, 0.12, this._parent._position.z);
      this.ring.material.color.setHex(this.remaining < 0.3 ? 0xff4c4c : 0xffb95e);
      if (this.remaining <= 0) {
        if (profile.ranged) {
          const fired = controller.elite && this.game.spikes.fireFan
            ? this.game.spikes.fireFan(this._parent._position, this.aim, health._params.strength, this._parent)
            : this.game.spikes.fire(this._parent._position, this.aim, health._params.strength, this._parent);
          if (fired) this.game.sound.play("spike", distance);
        } else if (distance <= profile.reach && clear()) {
          const chill = Boolean(controller.elite && this.game.map?.id === "mountains");
          if (chill) this.game.magicEffects?.spawn("ward", this._parent._position,
            { range: profile.reach, duration: 0.6, color: profile.color }, 1);
          player.Broadcast({
            topic: "health.damage", value: health._params.strength, attacker: this._parent, chill,
          });
        }
        if (controller.kind === "Yeti") this.game.sound.play("slam", distance);
        this.remaining = null;
        this.cooldown = profile.cooldown;
        this.ring.visible = false;
        this.aimLine.visible = false;
      }
    }
  }
}

class HealthComponent extends health_component.HealthComponent {
  _UpdateUI() {
    super._UpdateUI();
    const doc = typeof document !== "undefined" ? document : null;
    const bar = doc?.getElementById("health-bar");
    if (bar && this._maxHealth > 0) {
      const pct = Math.max(0, Math.min(100, Math.round((this._health / this._maxHealth) * 100)));
      bar.style.width = `${pct}%`;
    }
    const val = doc?.getElementById("health-value");
    if (val) {
      val.textContent = `${Math.ceil(this._health)} / ${this._maxHealth}`;
    }
  }

  _OnDamage(message) {
    if (!this.IsAlive() || !Number.isFinite(message.value) || message.value <= 0) return;
    const game = this._params.game;
    if (game.progressChanging) return;
    const position = this._parent._position.clone().add(new THREE.Vector3(0, 7, 0));
    if (this._params.updateUI && game.dodge.active) {
      game.feedback.show(position, "DODGED", "#8ce8e0");
      game.sound.play("evade");
      return;
    }
    if (this._params.updateUI && game.guard.active) {
      const source = message.attacker?._position;
      const direction = message.direction || (source ? {
        x: source.x - this._parent._position.x, z: source.z - this._parent._position.z,
      } : null);
      const attacker = message.attacker?.GetComponent("NPCController");
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this._parent._rotation);
      const result = game.guard.block(message.value, direction, forward,
        !message.direction && (attacker?.kind === "Yeti" || attacker?.elite || attacker?._params?.boss));
      if (result.blocked) {
        if (result.parried) {
          game.feedback.show(position, "PERFECT PARRY", "#ffd978");
          game.sound.play("block");
          if (message.direction && message.attacker?.GetComponent?.("HealthComponent")?.IsAlive?.()) {
            message.attacker.Broadcast({
              topic: "health.damage", value: message.value * 2, attacker: this._parent,
            });
          } else if (attacker) {
            attacker.magicSlow = Math.max(attacker.magicSlow || 0, 2);
            attacker.parried = 2.5;
          }
          return;
        }
        game.feedback.show(position, result.broken ? "GUARD BROKEN" : "BLOCKED", "#a9ddff");
        game.sound.play(result.broken ? "guardBreak" : "block");
        if (!result.damage) return;
        message = { ...message, value: result.damage };
      }
    }
    if (!this._params.updateUI && this.GetComponent("NPCController")?.parried > 0) {
      message = { ...message, value: Math.round(message.value * 1.25) };
    }
    if (this._params.updateUI && game.magic) {
      message = { ...message, value: game.magic.incomingDamage(
        message.value, this._parent._position, this._health, this._maxHealth) };
      if (!message.value) return;
    }
    const before = this._health;
    this.deathGradeBatch = message.gradingBatch;
    super._OnDamage(message);
    if (this._health < before) {
      game.sound.play(this._params.updateUI ? "hurt" : "hit");
      game.feedback.show(position, String(Math.round(message.value)), this._params.updateUI ? "#ff9c91" : "#ffe0a0");
      game.feedback.flash(this.GetComponent(this._params.updateUI ? "BasicCharacterController" : "NPCController")._target);
      if (this._params.updateUI && message.chill) {
        this.GetComponent("BasicCharacterController").frostSlow = 1.8;
        game.feedback.show(position.clone().add(new THREE.Vector3(0, 2.2, 0)), "CHILLED", "#7ddaff");
      }
    }
    if (this._params.updateUI) {
      this._UpdateUI();
      if (!this.IsAlive()) {
        game.guard.release();
        const doc = typeof document !== "undefined" ? document : null;
        const homeBtn = doc?.getElementById("home-button");
        if (homeBtn) {
          homeBtn.textContent = "Revive in village (Full HP)";
          homeBtn.classList.add("revive-needed");
        }
        this._params.game.status("You fell in battle! Click 'Revive in village' or press Space to recover.");
      }
    }
  }
}

class EquipWeapon extends equip_weapon_component.EquipWeapon {
  _UnloadModels() {
    if (!this._target) return;
    this._target.parent?.remove(this._target);
    this.disposeModel(this._target);
    this._target = null;
  }

  disposeModel(model) {
    model.traverse(object => {
      object.geometry?.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material?.dispose();
    });
  }

  _OnEquip(message) {
    const name = message.value || null;
    if (name === this._name) return;
    if (name && !this.GetComponent("InventoryController").GetItemByName(name)) return;
    this._revision = (this._revision || 0) + 1;
    this._UnloadModels();
    this._name = name;
    if (name) {
      this._LoadModels(this.GetComponent("InventoryController").GetItemByName(name).GetComponent("InventoryItem"),
        () => this._AttachTarget());
    }
  }

  _LoadModels(item, callback) {
    const revision = this._revision;
    const loader = new FBXLoader(new THREE.LoadingManager());
    loader.setPath("./resources/weapons/FBX/");
    loader.load(item.RenderParams.name + ".fbx", model => {
      if (revision !== this._revision) { this.disposeModel(model); return; }
      this._target = model;
      model.scale.setScalar(item.RenderParams.scale);
      if (this._params.shield) {
        const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
        this._shieldNormal = size.x < size.y && size.x < size.z ? new THREE.Vector3(1, 0, 0) :
          size.y < size.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
        model.rotation.set(Math.PI / 2, 0, Math.PI / 2);
      }
      else { model.rotateY(Math.PI); model.rotateX(-Math.PI / 3); model.rotateY(-1); }
      model.traverse(object => { object.castShadow = true; object.receiveShadow = true; });
      this.applyFinish();
      callback();
    }, undefined, () => {
      if (revision !== this._revision) return;
      const game = this._params.game;
      if (this._params.shield) game.selectShield("None");
      else game.selectWeapon("Unarmed", true);
      game.status("This equipment could not load. You can keep playing and select it again to retry.");
    });
  }

  applyFinish() {
    const color = FINISHES[this._params.game.progress.data.finish].color;
    this._target?.traverse(object => {
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!material?.color) continue;
        material.userData.originalColor ||= material.color.clone();
        if (color === null) material.color.copy(material.userData.originalColor);
        else material.color.setHex(color);
      }
    });
  }
}

class EquipShield extends EquipWeapon {
  InitComponent() {
    this.forward = new THREE.Vector3();
    this.point = new THREE.Vector3();
    this.parentRotation = new THREE.Quaternion();
    this.rotation = new THREE.Quaternion();
    this._RegisterHandler("load.character", message => this._OnCharacterLoaded(message));
    this._RegisterHandler("inventory.shield", message => this._OnEquip(message));
  }

  _OnEquip(message) {
    if ((message.value || null) === this._name) return;
    this._params.game.guard.release();
    super._OnEquip(message);
  }

  _UnloadModels() {
    this._params.game.guard.equipped = false;
    super._UnloadModels();
  }

  _AttachTarget() {
    super._AttachTarget();
    this._params.game.guard.equipped = Boolean(this._target?.parent);
  }

  Update() {
    if (!this._target) return;
    const active = this._params.game.guard.active;
    if (active && this._target.parent) {
      const player = this._params.game.player, hand = this._target.parent;
      this.forward.set(0, 0, 1).applyQuaternion(player._rotation);
      this.point.copy(player._position).addScaledVector(this.forward, 1.4);
      this.point.x += this.forward.z * 0.6;
      this.point.z -= this.forward.x * 0.6;
      this.point.y = 3;
      hand.updateWorldMatrix(true, false);
      this._target.position.copy(hand.worldToLocal(this.point));
      hand.getWorldQuaternion(this.parentRotation);
      this.rotation.setFromUnitVectors(this._shieldNormal, this.forward);
      this._target.quaternion.copy(this.parentRotation.inverse().multiply(this.rotation));
    } else {
      this._target.position.set(0, 0, 0);
      this._target.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    }
  }
}

class InventoryController extends entity.Component {
  constructor() { super(); this.items = new Set(); }
  InitComponent() {
    this._RegisterHandler("inventory.add", message => { this.items.add(message.value); message.added = true; });
  }
  GetItemByName(name) {
    const item = name || "Unarmed";
    return this.items.has(item) ? this.FindEntity(item) : null;
  }
}

class SoundComponent extends entity.Component {
  constructor(sound, weapon = () => "Sword") {
    super(); this.sound = sound; this.weapon = weapon; this.action = null; this.time = 0;
  }

  InitComponent() {
    this._RegisterHandler("player.action", message => {
      if (message.action === "attack" && (this.action !== "attack" || message.time < this.time)) {
        this.sound.play(WEAPONS[this.weapon()]?.sound ||
          ({ Axe: "axe", Unarmed: "punch" }[this.weapon()] || "swing"));
      }
      this.action = message.action;
      this.time = message.time;
    });
  }
}

class Game {
  constructor() {
    this.api = new GameApi({ baseUrl });
    this.sound = new SoundEffects();
    this.progress = new AdventureProgress();
    this.map = MAPS.village;
    this.dodge = new DodgeMotion();
    this.guard = new ShieldGuard();
    this.worldEvents = new WorldEvents();
    this.weapon = "Sword";
    this.infinitiveMagic = false;
    this.shield = "Shield_Round";
    this.feedback = new CombatFeedback(document.getElementById("combat-feedback"));
    this.manager = new entity_manager.EntityManager();
    this.grid = new spatial_hash_grid.SpatialHashGrid([[-200, -200], [200, 200]], [80, 80]);
    this.respawns = new MonsterRespawns();
    this.defeated = 0;
    this.ready = false;
    this.talking = false;
    this.conversation = "";
    this.quality = localStorage.getItem("aws-warrior:v2:quality") || "medium";
    this.markers = [];
    this.guideActors = [];
    this.enemies = [];
    this.monsterModels = new MonsterModels();
    this.spikeGeometry = new THREE.ConeGeometry(0.35, 2, 5);
    this.spikeGeometry.rotateX(Math.PI / 2);
    this.spikeMaterial = new THREE.MeshBasicMaterial({ color: 0xc5e874 });
    this.spikes = new SpikeShots({
      spawn: shot => {
        shot.mesh = new THREE.Mesh(this.spikeGeometry, this.spikeMaterial);
        shot.mesh.rotation.y = Math.atan2(shot.vx, shot.vz);
        shot.mesh.position.set(shot.x, 3, shot.z);
        this.scene.add(shot.mesh);
      },
      remove: shot => this.scene.remove(shot.mesh),
    });
    this.cameraDistance = 29;
    this.cameraYaw = 0;
    this.cameraPitch = 0.65;
    this.clock = new THREE.Clock();
    this.voiceWallet = new MagicWallet({
      baseUrl, readKey: () => localStorage.getItem("api_key"),
      changed: () => this.updateMagicUI(),
    });
    this.gameSave = new GameSave({
      baseUrl, changed: save => {
        const labels = { guest: "Local play - set a key to save", loading: "Loading save...",
          saving: "Saving...", saved: "Saved", offline: "Offline - retrying",
          conflict: "Newer save found. Load it to continue saving.", blocked: "Save unavailable - check your key or reload" };
        document.getElementById("game-save-status").textContent = labels[save.status] +
          (save.cacheUnavailable ? " (local recovery unavailable)" : "");
        document.getElementById("game-save-retry").hidden = !["offline", "conflict", "blocked"].includes(save.status);
        document.getElementById("game-save-retry").textContent = save.status === "conflict" ? "Load latest save" : "Retry save";
      },
      restored: state => {
        if (this.gameSave.key === localStorage.getItem("api_key")) this.resumeSave = state;
      },
    });
    this.bindUI();
    this.refreshVoiceWallet();
  }

  status(message) { document.getElementById("status").textContent = message; }

  updateMagicUI() {
    if (!this.voiceWallet) return;
    this.voiceWallet.syncKey();
    const { wallet, pending, checking, busy, error } = this.voiceWallet;
    const balance = wallet?.balance ?? 0, max = wallet?.max ?? 100;
    const mpValue = document.getElementById("mp-value"), mpBar = document.getElementById("mp-bar");
    if (mpValue) mpValue.textContent = `${balance} / ${max}`;
    if (mpBar) mpBar.style.width = `${balance / max * 100}%`;
    const meter = document.querySelector('.mp-track[role="meter"]');
    if (meter) {
      meter.setAttribute("aria-valuenow", String(balance));
      meter.setAttribute("aria-valuemax", String(max));
    }
    const state = busy ? "Reserving MP..." : checking ? "Checking MP..." :
      pending ? "Retry reserved selection — MP pending" :
      wallet ? `${balance} MP available` : error || "Save your API key to load MP.";
    document.getElementById("magic-badges").textContent = state;
    const selected = this.selectedSpells ?? [this.spell];
    const cost = selected.reduce((sum, id) => sum + SPELLS[id].cost, 0);
    const ultimate = Object.keys(SPELLS).every(id => selected.includes(id));
    const combo = typeof comboArtFor === "function" ? comboArtFor(selected) : null;
    const matches = ids => !pending || (pending.spells
      ? JSON.stringify([...ids].sort()) === JSON.stringify(pending.spells)
      : ids.length === 1 && ids[0] === pending.spell && this.magicLevel === pending.level);
    const summary = document.getElementById("magic-selection");
    if (summary) summary.textContent = `${ultimate ? "全域部署 · " : combo ? `${combo.label} (${combo.englishLabel}) · ` : ""}${selected.length} selected · ${cost} MP · ${
      selected.length ? Math.max(...selected.map(id => SPELLS[id].cooldown)) : 0}s cooldown`;
    if (this.infinitiveMagic) {
      document.getElementById("magic-badges").textContent = "Infinitive Magic Mode";
      const cast = document.getElementById("magic-cast");
      cast.disabled = !this.ready || busy || Boolean(pending) || !selected.length;
      cast.classList?.toggle("ultimate-ready", ultimate || Boolean(combo));
      cast.textContent = ultimate ? "全域部署 · Free (X)" : combo ? `${combo.label} · Free (X)` : "Cast: free (X)";
      cast.title = "Infinitive Magic Mode - no MP cost or cooldown";
      document.querySelectorAll("[data-spell]").forEach(button => {
        button.disabled = !this.ready || busy || Boolean(pending);
      });
      return;
    }
    const cooldown = this.magic?.cooldown ?? 0;
    const unavailable = !this.ready || busy || checking > 0 || (!wallet && !pending) || cooldown > 0;
    const matchesPending = matches(selected);
    const cast = document.getElementById("magic-cast");
    cast.disabled = unavailable || !selected.length || !matchesPending || (!pending && balance < cost);
    cast.classList?.toggle("ultimate-ready", ultimate || Boolean(combo));
    cast.textContent = busy ? "Reserving MP..." : checking ? "Checking MP..." :
      cooldown > 0 ? `Cooldown ${cooldown.toFixed(1)}s` : pending ? "Retry reserved cast (X)" :
        `${ultimate ? "全域部署 ·" : combo ? `${combo.label} ·` : "Cast:"} ${cost} MP (X)`;
    cast.title = error || (ultimate ? `${FULL_RELEASE_RANGE}-unit radius. Three outward waves defeat enemies, including bosses, when reached; walls block hits.` : state);
    document.querySelectorAll("[data-spell]").forEach(button => {
      button.disabled = busy || checking > 0 || Boolean(pending);
    });
  }

  refreshVoiceWallet() { return this.voiceWallet.refresh(); }

  magicStatus(message) {
    document.getElementById("magic-cast").title = message;
    document.getElementById("manual-cast-status").textContent = message;
  }

  toggleInfinitiveMagic(event) {
    if (event.code !== "KeyM" || !event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey ||
        event.repeat || event.isComposing || event.target?.closest?.("input, textarea, select, [contenteditable]") ||
        document.querySelector("dialog[open]")) return;
    event.preventDefault();
    if (!this.ready || !this.magic || this.voiceWallet.busy || this.voiceWallet.pending) {
      this.magicStatus("Finish loading or resolve the pending MP reservation before changing magic mode.");
      return;
    }
    this.infinitiveMagic = !this.infinitiveMagic;
    if (this.infinitiveMagic) this.magic.cooldown = 0;
    this.updateMagicUI();
    this.magicStatus(this.infinitiveMagic
      ? "Infinitive Magic Mode enabled - free local casts, no cooldowns. Reload to reset."
      : "Infinitive Magic Mode disabled - normal MP costs and cooldowns restored.");
  }

  canCastMagic() {
    if (!this.ready || !this.magic) { this.magicStatus("Magic is still loading."); return false; }
    if (this.traveling || this.progressChanging) {
      this.magicStatus("Wait for travel or account loading to finish before casting."); return false;
    }
    if (this.readingService || this.talking || document.querySelector("dialog[open]")) {
      this.magicStatus("Close the reader or conversation before casting."); return false;
    }
    if (!this.player.GetComponent("HealthComponent").IsAlive()) {
      this.magicStatus("Return to the village to recover before casting."); return false;
    }
    const controller = this.player.GetComponent("BasicCharacterController");
    if (this.dodge.active || controller._stateMachine._currentState?.Name === "attack") {
      this.magicStatus("Finish your attack or dodge before casting."); return false;
    }
    if (this.magic.cooldown > 0) {
      this.magicStatus(`Magic is cooling down: ${this.magic.cooldown.toFixed(1)}s.`); return false;
    }
    return true;
  }

  async castMagic() {
    if (!this.canCastMagic()) return false;
    const ids = [...(this.selectedSpells ?? [this.spell])];
    if (!ids.length) {
      this.magicStatus("Select at least one cloud art before casting.");
      return false;
    }
    const ultimate = Object.keys(SPELLS).every(id => ids.includes(id));
    const rumbling = ultimate && (this.random ? this.random() : Math.random()) >= 0.5;
    const combo = typeof comboArtFor === "function" ? comboArtFor(ids) : null;
    const spell = ids[0], level = this.magicLevel, map = this.map;
    const combined = ids.length > 1;
    const cost = ids.reduce((sum, id) => sum + SPELLS[id].cost, 0);
    const chineseName = ultimate ? (rumbling ? "地鳴・全域踐踏" : "全域部署") : combo ? combo.label : ids.map(id => SPELLS[id].label).join(" ＋ ");
    const englishName = ultimate ? (rumbling ? "The Rumbling · Titan Stampede" : "Global Deployment") : combo ? combo.englishLabel : ids.map(id => SPELLS[id].englishLabel).join(" + ");
    let origin, forward;
    const valid = () => {
      if (this.map !== map || !this.canCastMagic()) return false;
      origin = this.player._position.clone();
      forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.player._rotation);
      return ids.every(id => this.magic.canCast(id, level, origin, forward));
    };
    const free = this.infinitiveMagic === true;
    const execute = pay => {
      if (!(combined ? this.magic.castCombination(ids, level, origin, forward, pay) :
        this.magic.cast(spell, level, origin, forward, pay))) return false;
      if (free) this.magic.cooldown = 0;
      this.guard.release();
      this.sound.play({ lightning: "magicLightning", fireball: "magicFire", frost: "magicFrost",
        storm: "magicStorm", shockwave: "magicShock" }[spell]);
      this.sound.speakAttack(ultimate ? (rumbling ? "地鳴・全域踐踏。The Rumbling" : "全域部署。Global Deployment") :
        combo ? combo.label :
        ids.map(id => SPELLS[id].label).join("。"));
      if (ultimate) {
        if (rumbling && this.magicEffects.spawnRumblingFormation) this.magicEffects.spawnRumblingFormation(origin, forward);
        else this.magicEffects.spawnAvatarFormation(origin, forward);
      }
      const healNotice = ids.includes("shockwave") ? "HP recovered. " : "";
      this.magicStatus(`${chineseName} cast! ${healNotice}${free ? "Infinitive Magic Mode - no MP spent." : `Spent ${cost} MP.`}`);
      const title = document.getElementById("cloud-art-title");
      if (title) {
        const english = document.createElement("span"), chinese = document.createElement("span");
        english.className = "banner-english";
        chinese.className = "banner-chinese";
        english.textContent = englishName;
        chinese.textContent = chineseName;
        title.classList.toggle("combo-banner", combined);
        title.replaceChildren(english, chinese);
        const bannerColor = rumbling ? 0xff3b1f : combo ? (combo.id === "omniscience" ? 0xb8001f : combo.color) : SPELLS[spell].color;
        title.style.setProperty("--art-color", `#${bannerColor.toString(16).padStart(6, "0")}`);
        const bannerDuration = ultimate ? 6000 : Math.max(3800, 2600 + ids.length * 1400, (englishName.length + chineseName.length) * 65);
        title.getAnimations().forEach(animation => animation.cancel());
        title.animate([{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }],
          { duration: bannerDuration, easing: "ease-out" });
      }
      return true;
    };
    const cast = free
      ? !this.voiceWallet.busy && !this.voiceWallet.pending && valid() && execute(() => true)
      : await this.voiceWallet.cast({ ...(combined ? { spells: ids } : { spell, level }), valid, execute });
    if (!cast && this.voiceWallet.error) this.magicStatus(this.voiceWallet.error);
    this.updateMagicUI();
    return cast;
  }

  setupMagic() {
    this.magicEffects = new MagicEffects(this.scene, {
      low: () => this.quality === "low" || matchMedia("(prefers-reduced-motion: reduce)").matches,
      character: () => this.player.GetComponent("BasicCharacterController"),
      cpuSkinning: () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    });
    this.magic = new MagicCombat({
      power: () => this.player.GetComponent("HealthComponent")._params.strength,
      targets: () => this.enemies.filter(actor => actor._active !== false &&
        actor.GetComponent("NPCController")._target?.visible && actor.GetComponent("HealthComponent").IsAlive())
        .map(actor => ({ id: actor.Name, actor, x: actor._position.x, z: actor._position.z,
          boss: actor.GetComponent("NPCController").elite || actor.GetComponent("NPCController")._params.boss })),
      canWalk: (x, z) => this.world.canWalk(x, z),
      clear: (from, to) => clearShot(from, to, (x, z) => this.world.canWalk(x, z)),
      waveClear: (from, to) => isMagicWaveClear(this.map, from, to),
      damage: (target, value, gradingBatch) => target.actor.Broadcast({ topic: "health.damage", value, attacker: this.player, gradingBatch }),
      defeat: (target, gradingBatch) => target.actor.Broadcast({ topic: "health.damage",
        value: target.actor.GetComponent("HealthComponent")._health, attacker: this.player, gradingBatch }),
      slow: (target, duration) => {
        target.actor.GetComponent("NPCController").magicSlow = duration;
      },
      push: (target, from, distance) => {
        const dx = target.x - from.x, dz = target.z - from.z, length = Math.hypot(dx, dz) || 1;
        const position = target.actor._position.clone();
        for (let step = 0; step < Math.ceil(distance / 0.4); step++) {
          const x = position.x + dx / length * 0.4, z = position.z + dz / length * 0.4;
          if (!this.world.canWalk(x, z) ||
              findMovementBlockers(this.grid, target.actor, { x, z }, position).length) break;
          position.set(x, 0, z);
        }
        target.actor.GetComponent("NPCController")._target.position.copy(position);
        target.actor.SetPosition(position);
      },
      effect: (...args) => this.magicEffects.spawn(...args),
      recover: (anchor, healthValue) => {
        if (findMovementBlockers(this.grid, this.player, anchor, { x: Infinity, z: Infinity }).length) return false;
        const controller = this.player.GetComponent("BasicCharacterController");
        controller._target.position.set(anchor.x, 0, anchor.z);
        controller._velocity.set(0, 0, 0);
        this.player.SetPosition(controller._target.position);
        const health = this.player.GetComponent("HealthComponent");
        health._health = Math.ceil(healthValue);
        health._UpdateUI();
        document.getElementById("health-value").textContent = `${health._health} / ${health._maxHealth}`;
        this.dodge.remaining = 0;
        this.guard.release();
        this.feedback.show(controller._target.position.clone().add(new THREE.Vector3(0, 7, 0)), "跨區復甦", "#7dffd0");
        this.sound.play("portal");
        return true;
      },
      heal: (level = 1) => (this.healPlayer || Game.prototype.healPlayer)?.call(this, level),
    });
  }

  showKeyDialog(message = "Classic and V2 share your key and marks. Your active V2 quest stays separate in this browser tab.") {
    const dialog = document.getElementById("key-dialog");
    const input = document.getElementById("api-key");
    input.value = localStorage.getItem("api_key") || "";
    document.getElementById("key-help").textContent = message;
    this.dodge.remaining = 0;
    this.guard.release();
    if (this.player) {
      const keys = this.player.GetComponent("BasicCharacterControllerInput")._keys;
      Object.keys(keys).forEach(key => { keys[key] = false; });
    }
    if (!dialog.open) dialog.showModal();
    input.focus();
  }

  async syncProgress() {
    const key = localStorage.getItem("api_key"), reset = localStorage.getItem(MARKS_RESET_KEY);
    const changed = key !== this.progressKey || reset !== this.progressReset;
    this.progressKey = key; this.progressReset = reset; this.progressChanging = true;
    this.guard.release();
    if (!await this.progress.selectAccount(key, reset)) return;
    const seed = initialGameSave(), data = this.progress.data;
    seed.adventure = { chests: data.chests, boss: data.boss };
    seed.equipment.finish = data.finish;
    seed.missions = data.passed;
    this.resumeSave = seed;
    await this.gameSave.selectAccount(key, seed);
    if (key !== this.progressKey || reset !== this.progressReset) return;
    this.progressChanging = false;
    this.updateAdventure();
    if (changed && this.map.id === "village" && this.boss?.GetComponent("NPCController")._stateMachine._currentState &&
        !this.boss.GetComponent("HealthComponent").IsAlive()) this.respawnEnemy(this.boss, BOSS);
  }

  updateAdventure() {
    const data = this.progress.data;
    this.world?.setAdventure(data);
    this.player?.GetComponent("EquipWeapon").applyFinish();
    this.player?.GetComponent("EquipShield").applyFinish();
    document.getElementById("village-progress").textContent =
      `AWS missions: ${data.passed.length} | Village: ${Math.min(data.passed.length, BUILDINGS.length)} / ${BUILDINGS.length} restored`;
  }

  saveCheckpoint() {
    if (!this.ready || this.progressChanging || this.restoringSave || this.resumeSave ||
        this.gameSave.key !== localStorage.getItem("api_key")) return;
    this.gameSave.update({
      schemaVersion: 2, checkpoint: this.map.id,
      equipment: { weapon: this.weapon, shield: this.shield, finish: this.progress.data.finish,
        spell: this.spell, level: this.magicLevel },
      adventure: { chests: this.progress.data.chests, boss: this.progress.data.boss },
      missions: this.progress.data.passed,
    });
  }

  restoreCheckpoint() {
    if (!this.resumeSave || !this.ready || !this.mapActorsReady() || this.traveling ||
        this.progressChanging || this.api.grading || this.talking) return;
    const state = this.resumeSave;
    this.restoringSave = true;
    try {
      if (this.map.id !== state.checkpoint && !this.switchMap(state.checkpoint, true)) return;
      const controller = this.player.GetComponent("BasicCharacterController");
      controller._target.position.set(this.map.spawn[0], 0, this.map.spawn[1]);
      controller._velocity.set(0, 0, 0);
      controller._stateMachine.SetState("idle");
      this.player.SetPosition(controller._target.position);
      this.dodge.remaining = 0;
      this.guard.release();
      const health = this.player.GetComponent("HealthComponent");
      health._health = health._maxHealth;
      health._UpdateUI();
      this.progress.data = { reset: this.progress.data.reset, passed: [...state.missions],
        chests: [...state.adventure.chests], boss: state.adventure.boss, finish: state.equipment.finish };
      this.progress.save();
      this.selectWeapon(state.equipment.weapon, true);
      this.selectShield(state.equipment.shield);
      this.spell = state.equipment.spell; this.magicLevel = 1;
      this.selectedSpells = null;
      document.querySelectorAll("[data-spell]").forEach(button =>
        button.setAttribute("aria-pressed", String(button.dataset.spell === this.spell)));
      this.updateAdventure();
      this.updateMagicUI();
      this.resumeSave = null;
    } finally { this.restoringSave = false; }
  }

  selectWeapon(name, force = false) {
    if (!this.player || !Object.hasOwn(WEAPONS, name)) return false;
    const state = this.player.GetComponent("BasicCharacterController")._stateMachine._currentState?.Name;
    if (!force && (state === "attack" || this.dodge.active)) {
      this.status("Finish your swing or dodge before changing weapons."); return false;
    }
    if (this.weapon !== name) this.sound.play("equip");
    this.weapon = name;
    this.player.Broadcast({ topic: "inventory.equip", value: name === "Unarmed" ? null : name });
    document.querySelectorAll("[data-weapon]").forEach(button =>
      button.setAttribute("aria-pressed", String(button.dataset.weapon === name)));
    this.saveCheckpoint();
    return true;
  }

  selectShield(name) {
    if (!this.player || (name !== "None" && !Object.hasOwn(SHIELDS, name))) return false;
    this.guard.release();
    this.shield = name;
    this.player.Broadcast({ topic: "inventory.shield", value: name === "None" ? null : name });
    document.querySelectorAll("[data-shield]").forEach(button =>
      button.setAttribute("aria-pressed", String(button.dataset.shield === name)));
    this.sound.play("equip");
    this.saveCheckpoint();
    return true;
  }

  cycleWeapon(step = 1) {
    return this.selectWeapon(nextWeapon(Object.keys(WEAPONS), this.weapon, step));
  }

  cycleShield(step = 1) {
    return this.selectShield(nextWeapon(["None", ...Object.keys(SHIELDS)], this.shield, step));
  }

  toggleSpell(id) {
    if (!Object.hasOwn(SPELLS, id) || this.voiceWallet?.busy ||
        this.voiceWallet?.checking > 0 || this.voiceWallet?.pending) return false;
    const selected = new Set(this.selectedSpells ?? [this.spell]);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    this.selectedSpells = [...selected];
    if (selected.size) this.spell = this.selectedSpells[0];
    document.querySelectorAll("[data-spell]").forEach(item =>
      item.setAttribute("aria-pressed", String(selected.has(item.dataset.spell))));
    this.updateMagicUI();
    this.saveCheckpoint();
    return true;
  }

  triggerControlAction(action) {
    if (this.progressChanging) return false;
    if (action === "attack") {
      if (!this.ready || this.traveling || !this.player?.GetComponent("HealthComponent")?.IsAlive() ||
          this.guard.active || this.dodge.active) return false;
      const input = this.player.GetComponent("BasicCharacterControllerInput");
      const controller = this.player.GetComponent("BasicCharacterController");
      input._keys.space = true;
      if (controller) controller.tapAttack = true;
      return true;
    }
    if (action === "magic") return Boolean(this.castMagic());
    if (action === "dodge") return this.tryDodge();
    if (action === "task") { this.talkToGuide(); return true; }
    if (action === "chest") return this.openNearbyChest();
    if (action === "gate") return this.useGate();
    if (action === "weapon") return this.cycleWeapon(1);
    if (action === "shield") return this.cycleShield(1);
    return false;
  }

  scrollEquipment(event) {
    if (!event.deltaY || event.target.closest(".v2-ui, dialog") || document.querySelector("dialog[open]") ||
        !this.ready || this.traveling || this.progressChanging || !this.player.GetComponent("HealthComponent").IsAlive()) return;
    event.preventDefault();
    if (!event.shiftKey) {
      this.cameraDistance = THREE.MathUtils.clamp(this.cameraDistance + event.deltaY * 0.02, 18, 46);
      return;
    }
    const now = performance.now();
    if (now - (this.lastWeaponScroll ?? -Infinity) < 160) return;
    if (this.selectWeapon(nextWeapon(Object.keys(WEAPONS), this.weapon, event.deltaY))) this.lastWeaponScroll = now;
  }

  startBlock() {
    if (!this.ready || this.traveling || this.progressChanging || this.dodge.active ||
        !this.player.GetComponent("HealthComponent").IsAlive()) return false;
    if (!this.guard.equipped) { this.status("Choose a shield and let it load before blocking."); return false; }
    if (this.guard.broken > 0) return false;
    const controller = this.player.GetComponent("BasicCharacterController");
    if (controller._stateMachine._currentState?.Name === "attack") return false;
    if (this.guard.press) this.guard.press();
    else this.guard.held = true;
    controller._velocity.multiplyScalar(0.4);
    this.player.GetComponent("BasicCharacterControllerInput")._keys.space = false;
    return true;
  }

  tryDodge() {
    if (!this.ready || this.progressChanging || !this.player.GetComponent("HealthComponent").IsAlive()) return false;
    const controller = this.player.GetComponent("BasicCharacterController");
    if (controller._stateMachine._currentState?.Name === "attack") return false;
    const keys = this.player.GetComponent("BasicCharacterControllerInput")._keys;
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.player._rotation);
    const direction = keys.left ? { x: -forward.z, z: forward.x } :
      keys.right ? { x: forward.z, z: -forward.x } :
        { x: forward.x * (keys.forward ? 1 : -1), z: forward.z * (keys.forward ? 1 : -1) };
    if (!this.dodge.start(direction)) return false;
    this.guard.release();
    controller._velocity.set(0, 0, 0);
    controller._stateMachine.SetState("idle");
    this.sound.play("dodge");
    return true;
  }

  nearbyChest() {
    if (this.map.id !== "village") return null;
    return CHESTS.filter(chest => !this.progress.data.chests.includes(chest.id) &&
      Math.hypot(chest.x - this.player._position.x, chest.z - this.player._position.z) < 7)
      .sort((a, b) => Math.hypot(a.x - this.player._position.x, a.z - this.player._position.z) -
        Math.hypot(b.x - this.player._position.x, b.z - this.player._position.z))[0];
  }

  openNearbyChest() {
    if (!this.ready || this.progressChanging || !this.player.GetComponent("HealthComponent").IsAlive()) return false;
    const chest = this.nearbyChest();
    if (!chest) { this.status("Find a glowing cache and press F nearby. Look for the smuggler's trail west of the forest watcher."); return false; }
    const emerald = this.progress.unlocked("verdant");
    if (!this.progress.openChest(chest.id)) return false;
    if (!emerald && this.progress.data.finish === "plain") this.progress.selectFinish("verdant");
    this.updateAdventure();
    this.sound.play("chest");
    this.status(`${chest.name} opened! Forest emerald weapon finish unlocked. Exploration rewards are cosmetic, not AWS marks.`);
    this.saveCheckpoint();
    return true;
  }

  rewardBoss() {
    if (this.progressChanging || !this.progress.defeatBoss()) return;
    this.progress.selectFinish("crystal");
    this.updateAdventure();
    this.sound.play("success");
    this.status("Crystal Warden defeated! Crystal weapon finish unlocked. Ordinary monsters still check your AWS tasks.");
    this.saveCheckpoint();
  }

  onMonsterDefeated(position) {
    const outcome = this.worldEvents?.recordKill(position);
    if (!outcome?.resolved || !this.player) return;
    const health = this.player.GetComponent("HealthComponent");
    if (health?.IsAlive()) {
      health._health = Math.min(health._maxHealth, health._health + 20);
      health._UpdateUI();
      document.getElementById("health-value").textContent = `${health._health} / ${health._maxHealth}`;
    }
    this.feedback.show(this.player._position.clone().add(new THREE.Vector3(0, 8, 0)), "AZ RESTORED!", "#7dffd0");
    this.sound.play("success");
  }

  showCombatManual() {
    const strength = this.player?.GetComponent("HealthComponent")._params.strength ?? 50;
    const table = (id, rows) => {
      const body = document.getElementById(id);
      body.replaceChildren();
      for (const values of rows) {
        const row = document.createElement("tr");
        values.forEach((value, index) => {
          const cell = document.createElement(index ? "td" : "th");
          if (!index) cell.scope = "row";
          cell.textContent = value;
          row.appendChild(cell);
        });
        body.appendChild(row);
      }
    };
    document.getElementById("manual-mode").textContent =
      "Each cloud art has a fixed MP cost, reserved on the server before casting. Misses still cost MP. " +
      "Earn MP through graded voice activities, not by marking signs as read. MP is capped at 100. " +
      "Combat effects run locally; only the MP wallet and reservation cooldown are server-enforced.";
    document.getElementById("manual-strength").textContent =
      `Weapon damage below uses your current Power (${strength}). Damage = Power x weapon multiplier; speed is an animation multiplier, not attacks per second. Reach and spell ranges use world units.`;
    table("manual-weapons", Object.entries(WEAPONS).map(([name, weapon]) => [
      weapon.label, Math.round(strength * (name === "Unarmed" ? 1 : weapon.damage)),
      `${name === "Unarmed" ? 1 : weapon.damage}x`,
      `${weapon.speed}x`, weapon.reach || 5, weapon.style,
    ]));
    table("manual-spells", Object.entries(SPELLS).map(([id, spell]) => [
      `${spell.label} (${spell.service})`, spellDamage(id, 1, strength),
      spell.range, `${spell.cost} MP / ${spell.cooldown}s`, spell.tradeoff, spell.bestFor,
    ]));
    document.getElementById("manual-shields").textContent =
      `${Object.values(SHIELDS).join(", ")}. All five have the same protection; appearance differs. Hold R to block frontal hits within 60 degrees of facing. Sides and rear remain exposed. Heavy hits deal half damage (rounded up), break guard for 1.5 seconds, and require a fresh R press. Timed Perfect Parry: pressing R within 0.25 seconds of a frontal hit negates all damage without breaking guard, reflects ranged spikes for 2x damage, and staggers melee attackers (+25% bonus damage taken for 2.5 seconds).`;
    this.guard.release();
    if (this.player) {
      const keys = this.player.GetComponent("BasicCharacterControllerInput")._keys;
      Object.keys(keys).forEach(key => { keys[key] = false; });
    }
    const dialog = document.getElementById("combat-manual");
    if (!dialog.open) dialog.showModal();
    document.getElementById("manual-content").scrollTop = 0;
  }

  bindUI() {
    bindServiceReader(this, THREE);
    document.getElementById("game-save-retry").onclick = () =>
      this.gameSave.status === "conflict" ? this.gameSave.load({ discard: true }) :
        this.gameSave.status === "blocked" ? this.gameSave.load() :
        this.gameSave.pending ? this.gameSave.flush() : this.gameSave.load();
    window.addEventListener("online", () => {
      if (this.gameSave.status === "offline")
        this.gameSave.document ? this.gameSave.flush() : this.gameSave.load();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.gameSave.flush();
    });
    const manual = document.getElementById("combat-manual");
    document.getElementById("manual-button").onclick = () => this.showCombatManual();
    document.getElementById("manual-close").onclick = () => manual.close();
    manual.addEventListener("close", () => this.renderer?.domElement.focus());
    this.spell = "lightning";
    this.magicLevel = 1;
    Object.entries(SPELLS).forEach(([id, spell], index) => {
      const button = document.createElement("button");
      const slotKey = index + 3;
      button.type = "button";
      const enLine = document.createElement("span"), zhLine = document.createElement("span");
      enLine.className = "spell-btn-en";
      enLine.textContent = `${spell.englishLabel} · ${spell.cost} MP`;
      zhLine.className = "spell-btn-zh";
      zhLine.textContent = spell.label;
      button.replaceChildren?.(enLine, zhLine);
      if (!button.replaceChildren) button.textContent = `${spell.englishLabel} · ${spell.cost} MP\n${spell.label}`;
      button.title = `[${slotKey}] ${spell.service}: ${spell.tradeoff}`;
      button.style.borderLeft = `4px solid #${spell.color.toString(16).padStart(6, "0")}`;
      button.dataset.spell = id;
      button.dataset.slot = String(slotKey);
      button.setAttribute("aria-pressed", String(id === this.spell));
      button.onclick = () => {
        this.toggleSpell(id);
        this.renderer?.domElement.focus();
      };
      document.getElementById("magic-bar").appendChild(button);
    });
    document.getElementById("magic-cast").onclick = () => {
      this.castMagic();
      this.renderer?.domElement.focus();
    };
    document.querySelectorAll?.("[data-control-action]")?.forEach(item => {
      item.onclick = () => {
        this.triggerControlAction(item.dataset.controlAction);
        this.renderer?.domElement.focus();
      };
    });
    const soundButton = document.getElementById("sound-button");
    const soundVolume = document.getElementById("sound-volume");
    const voiceSelect = document.getElementById("attack-voice");
    const updateVoices = () => {
      const automatic = document.createElement("option");
      automatic.value = "";
      const voices = this.sound.cantoneseVoices();
      automatic.textContent = voices.length ? "自動 / Auto" : "系統廣東話 / System Cantonese";
      voiceSelect.replaceChildren(automatic, ...voices.map(voice => {
        const option = document.createElement("option");
        option.value = voice.voiceURI;
        option.textContent = voice.name;
        return option;
      }));
      voiceSelect.value = voices.some(voice => voice.voiceURI === this.sound.voiceURI) ? this.sound.voiceURI : "";
      voiceSelect.disabled = !this.sound.synthesis || !this.sound.Utterance;
    };
    voiceSelect.onchange = () => {
      this.sound.selectVoice(voiceSelect.value);
      this.sound.unlockSpeech();
      this.sound.speakAttack(SPELLS[this.spell].label);
    };
    this.sound.synthesis?.addEventListener("voiceschanged", updateVoices);
    updateVoices();
    const updateSound = () => {
      soundButton.textContent = this.sound.available
        ? this.sound.muted ? "Unmute sound" : "Mute sound" : "Sound unavailable";
      soundButton.setAttribute("aria-pressed", String(this.sound.muted));
      soundButton.disabled = soundVolume.disabled = !this.sound.available;
      soundVolume.value = Math.round(this.sound.volume * 100);
    };
    const unlockSound = () => this.sound.unlock().then(updateSound);
    soundButton.onclick = () => {
      this.sound.setMuted(!this.sound.muted);
      unlockSound();
      updateSound();
      this.renderer?.domElement.focus();
    };
    soundVolume.oninput = () => {
      this.sound.setVolume(Number(soundVolume.value) / 100);
      unlockSound();
    };
    soundVolume.onpointerup = () => this.renderer?.domElement.focus();
    document.addEventListener("pointerdown", unlockSound, { passive: true });
    document.addEventListener("keydown", unlockSound);
    document.addEventListener("keydown", event => this.toggleInfinitiveMagic(event));
    document.addEventListener("visibilitychange", () => {
      this.sound.setPaused(document.hidden);
      if (document.hidden) this.guard.release();
    });
    updateSound();
    const dialog = document.getElementById("key-dialog");
    document.getElementById("key-button").onclick = () => this.showKeyDialog();
    const closeDialog = () => {
      dialog.close();
      this.renderer?.domElement.focus();
    };
    document.getElementById("cancel-key").onclick = closeDialog;
    dialog.addEventListener("close", () => this.renderer?.domElement.focus());
    document.getElementById("key-form").onsubmit = event => {
      event.preventDefault();
      const key = document.getElementById("api-key").value.trim();
      if (!key) return;
      if (key !== localStorage.getItem("api_key")) {
        sessionStorage.removeItem(QUEST_KEY);
        this.conversation = "";
        document.getElementById("conversation-button").hidden = true;
        document.getElementById("task-dialog").close();
        this.showQuest();
      }
      localStorage.setItem("api_key", key);
      this.refreshVoiceWallet();
      window.dispatchEvent(new Event("voice-owner-changed"));
      this.syncProgress();
      closeDialog();
      this.status("Key saved. Press E near a guide to receive a quest.");
    };
    const taskDialog = document.getElementById("task-dialog");
    document.getElementById("instructions-button").onclick = () => this.showInstructions();
    document.getElementById("conversation-button").onclick = () => this.showConversation();
    document.getElementById("close-task").onclick = () => taskDialog.close();
    taskDialog.addEventListener("close", () => this.renderer?.domElement.focus());
    document.getElementById("home-button").onclick = () => this.returnHome();
    document.getElementById("reload-button").onclick = () => location.reload();
    const quality = document.getElementById("quality");
    quality.value = ["low", "medium", "high"].includes(this.quality) ? this.quality : "medium";
    this.quality = quality.value;
    quality.onchange = () => {
      this.quality = quality.value;
      localStorage.setItem("aws-warrior:v2:quality", this.quality);
      this.applyQuality();
    };
    for (const [id, kind, entries] of [
      ["weapon-bar", "weapon", Object.entries(WEAPONS).map(([name, weapon]) => [name, weapon.label])],
      ["shield-bar", "shield", [["None", "No shield"], ...Object.entries(SHIELDS)]],
    ]) {
      const bar = document.getElementById(id);
      for (const [name, label] of entries) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset[kind] = name;
        button.setAttribute("aria-label", label);
        button.setAttribute("aria-pressed", String(kind === "weapon" && name === this.weapon));
        button.title = label;
        button.innerHTML = equipmentIcon(name);
        const shortcut = { Sword: "1", Axe: "2", Unarmed: "0" }[name];
        if (kind === "weapon" && shortcut) {
          const hint = document.createElement("span");
          hint.className = "slot-key"; hint.textContent = shortcut;
          button.appendChild(hint);
        }
        button.onclick = () => {
          if (kind === "weapon") this.selectWeapon(name); else this.selectShield(name);
          this.renderer?.domElement.focus();
        };
        bar.appendChild(button);
      }
    }
    window.addEventListener("blur", () => {
      this.guard.release();
      if (this.player) Object.keys(this.player.GetComponent("BasicCharacterControllerInput")._keys)
        .forEach(key => { this.player.GetComponent("BasicCharacterControllerInput")._keys[key] = false; });
    });
    window.addEventListener("storage", event => {
      if (event.key === MARKS_RESET_KEY) {
        this.syncProgress();
        this.showQuest();
        this.status("Your marks were reset. Press E near a guide to start again.");
      } else if (event.key === "api_key" || event.key === null) {
        this.refreshVoiceWallet();
        sessionStorage.removeItem(QUEST_KEY);
        document.getElementById("task-dialog").close();
        this.syncProgress();
        this.showQuest();
      }
    });
    window.addEventListener("wheel", event => this.scrollEquipment(event), { passive: false });
    const viewport = document.getElementById("container");
    viewport?.addEventListener("pointerdown", event => {
      if (event.button !== 0 && event.button !== 2) return;
      if (document.querySelector("dialog[open]")) return;
      this.cameraDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      viewport.setPointerCapture?.(event.pointerId);
    });
    viewport?.addEventListener("pointermove", event => {
      if (!this.cameraDrag || this.cameraDrag.id !== event.pointerId) return;
      const dx = event.clientX - this.cameraDrag.x, dy = event.clientY - this.cameraDrag.y;
      this.cameraDrag.x = event.clientX;
      this.cameraDrag.y = event.clientY;
      this.cameraYaw = (this.cameraYaw || 0) - dx * 0.007;
      this.cameraPitch = THREE.MathUtils.clamp((this.cameraPitch ?? 0.65) + dy * 0.005, 0.12, 1.35);
    });
    const endDrag = event => {
      if (this.cameraDrag && (!event?.pointerId || this.cameraDrag.id === event.pointerId)) this.cameraDrag = null;
    };
    viewport?.addEventListener("pointerup", endDrag);
    viewport?.addEventListener("pointercancel", endDrag);
    viewport?.addEventListener("dblclick", () => {
      this.cameraYaw = 0;
      this.cameraPitch = 0.65;
    });
    viewport?.addEventListener("contextmenu", event => event.preventDefault());
    this.showQuest();
  }

  async start() {
    await this.syncProgress();
    const assets = new Assets();
    THREE.Cache.enabled = true;
    THREE.DefaultLoadingManager.onProgress = (_, loaded, total) => {
      document.getElementById("loading-progress").value = loaded / total * 100;
      document.getElementById("loading-message").textContent = `Preparing the world: ${loaded} / ${total} resources`;
    };
    THREE.DefaultLoadingManager.onError = () => {
      this.failed = true;
      this.fail(new Error("A world asset could not load. Check your connection and try again."));
    };
    const graphics = createRenderer(THREE.WebGLRenderer);
    this.renderer = graphics.renderer;
    if (graphics.compatibilityMode) {
      this.quality = "low";
      document.getElementById("quality").value = "low";
      this.status("Compatibility graphics enabled. You can explore or set your API key.");
    }
    this.renderer.domElement.id = "threejs";
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute("aria-label", "Enhanced fantasy game world");
    this.renderer.domElement.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      this.failed = true;
      this.fail(new Error("The graphics context was lost. Reload the world or try Classic."));
    });
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById("container").appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9bbbc0);
    this.scene.fog = new THREE.Fog(0x9bbbc0, 95, 310);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 850);
    this.camera.position.set(0, 23, 52);
    this.camera.lookAt(0, 4, 0);
    this.scene.add(new THREE.HemisphereLight(0xffefd3, 0x586c4d, 0.65));
    this.sun = new THREE.DirectionalLight(0xffdeae, 1.1);
    this.sun.castShadow = true;
    Object.assign(this.sun.shadow.camera, { left: -65, right: 65, top: 65, bottom: -65, near: 1, far: 220 });
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);
    this.applyQuality();
    window.addEventListener("resize", () => this.resize());
    this.resize();
    await Promise.all([assets.preload(), loadServiceImages()]);
    this.models = await assets.templates();
    this.shared = sharedResources(this.models);
    this.worldRoot = new THREE.Group();
    this.scene.add(this.worldRoot);
    this.world = new World(this.worldRoot, this.models, this.map, this.readServices);
    this.cameraBoxes = BUILDINGS.map(b => new THREE.Box3(
      new THREE.Vector3(b.x - 8.5, 0, b.z - 8.5),
      new THREE.Vector3(b.x + 8.5, 16, b.z + 8.5)));
    this.spawnPlayer();
    this.spawnGuides();
    this.spawnEnemies();
    this.setupMagic();
    this.updateAdventure();
    this.loadTimeout = setTimeout(() => {
      if (!this.ready) this.fail(new Error("Character loading took too long. Check your connection and try again."));
    }, 60000);
    this.frame();
  }

  applyQuality() {
    if (!this.renderer) return;
    const ratio = { low: 1, medium: 1.35, high: 1.75 }[this.quality];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, ratio));
    this.renderer.shadowMap.enabled = this.quality !== "low";
    const resolution = this.quality === "high" ? 2048 : 1024;
    if (this.sun.shadow.mapSize.width !== resolution && this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.shadow.mapSize.set(resolution, resolution);
    this.scene.traverse(object => {
      if (object.material) {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          material.needsUpdate = true;
        }
      }
    });
    if (this.world) this.world.detail.visible = this.quality !== "low";
    this.resize();
  }

  resize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  stats(updateUI = false) {
    return { health: updateUI ? 100 : 80, maxHealth: updateUI ? 100 : 80,
      strength: updateUI ? 50 : 6, wisdomness: 5, benchpress: 20, curl: 10,
      experience: 0, level: 1, updateUI, game: this };
  }

  spawnPlayer() {
    const params = { camera: this.camera, scene: this.scene, world: this.world, game: this };
    const spawner = new entity.Entity();
    spawner.AddComponent(new level_up_component.LevelUpComponentSpawner({ ...params, scene: this.worldRoot }));
    this.manager.Add(spawner, "level-up-spawner");
    for (const [name, weapon] of [...Object.entries(WEAPONS), ...Object.keys(SHIELDS).map(name => [name, { damage: 0 }])]) {
      const item = new entity.Entity();
      item.AddComponent(new inventory_controller.InventoryItem({
        type: "weapon", damage: weapon.damage, renderParams: { name, scale: 0.25 },
      }));
      this.manager.Add(item, name);
    }
    const player = new entity.Entity();
    player.AddComponent(new BasicCharacterControllerInput(params));
    player.AddComponent(new BasicCharacterController(params));
    player.AddComponent(new EquipWeapon({ anchor: "RightHandIndex1", game: this }));
    player.AddComponent(new EquipShield({ anchor: "LeftHand", game: this, shield: true }));
    player.AddComponent(new InventoryController());
    player.AddComponent(new HealthComponent(this.stats(true)));
    player.AddComponent(new SpatialGridController({ grid: this.grid }));
    player.AddComponent(new attack_controller.AttackController({ timing: 0.7 }));
    player.AddComponent(new SoundComponent(this.sound, () => this.weapon));
    player.SetPosition(new THREE.Vector3(PLAYER_SPAWN[0], 0, PLAYER_SPAWN[1]));
    player.SetQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    this.manager.Add(player, "player");
    this.player = player;
    for (const name of [...Object.keys(WEAPONS), ...Object.keys(SHIELDS)]) player.Broadcast({ topic: "inventory.add", value: name });
    player.Broadcast({ topic: "inventory.equip", value: "Sword" });
    this.selectShield("Shield_Round");
  }

  spawnGuides() {
    GUIDES.forEach((guide, index) => {
      const npc = new entity.Entity();
      npc.AddComponent(new GuideController(this, guide, index));
      npc.AddComponent(new SpatialGridController({ grid: this.grid }));
      npc.AddComponent(new QuestComponent(this));
      npc.SetPosition(new THREE.Vector3(guide.x, 0, guide.z));
      this.manager.Add(npc, guide.name);
      this.guideActors.push(npc);
      const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.8, 0),
        new THREE.MeshBasicMaterial({ color: 0xffd381 }));
      marker.position.set(guide.x, 9, guide.z);
      marker.userData.guide = npc;
      this.scene.add(marker);
      this.markers.push(marker);
      const circle = new THREE.Mesh(new THREE.RingGeometry(2, 2.2, 32),
        new THREE.MeshBasicMaterial({ color: 0xffd381, transparent: true, opacity: 0.65,
          side: THREE.DoubleSide, depthWrite: false }));
      circle.rotation.x = -Math.PI / 2;
      circle.position.set(guide.x, 0.09, guide.z);
      this.scene.add(circle);
      marker.userData.ring = circle;
    });
  }

  spawnEnemies() {
    [...MAPS.village.enemies, [BOSS.x, BOSS.z]].forEach(([x, z], index) => {
      const boss = index === MAPS.village.enemies.length;
      const name = boss ? "Cyclops" : monsterFor("village", index);
      const monster = new entity.Entity();
      monster.AddComponent(new NPCController({
        camera: this.camera, scene: this.scene, game: this, world: this.world, boss,
        resourceName: `${name}.fbx`, resourceTexture: `${name}_Texture.png`,
      }));
      monster.AddComponent(new HealthComponent(boss ? { ...this.stats(), health: 480, maxHealth: 480, strength: 16 } : this.stats()));
      monster.AddComponent(new SpatialGridController({ grid: this.grid }));
      monster.AddComponent(new EnemyAttackController(this, boss));
      this.scene.add(monster.GetComponent("EnemyAttackController").ring);
      monster.SetPosition(new THREE.Vector3(x, 0, z));
      this.manager.Add(monster);
      this.enemies.push(monster);
      if (boss) this.boss = monster;
    });
  }

  respawnEnemy(monster, destination = null) {
    const position = destination || findMonsterSpawn({
      canWalk: (x, z) => this.world.canWalk(x, z),
      player: this.player._position,
      extent: this.map.id === "village" ? 145 : this.map.limit - 20,
      isSafe: (x, z) => this.map.id === "village" ? Math.abs(x) < 62 && Math.abs(z) < 50 :
        isSafePosition(this.map, x, z),
      occupied: this.manager.Filter(actor => actor !== monster &&
        (actor.GetComponent("QuestComponent") || actor.GetComponent("HealthComponent")?.IsAlive()))
        .map(actor => actor._position),
    });
    if (!position) return false;
    const controller = monster.GetComponent("NPCController");
    const health = monster.GetComponent("HealthComponent");
    health._maxHealth = health._params.maxHealth = health._params.health = controller.profile.health;
    health._params.strength = controller.profile.damage;
    health._health = health._maxHealth;
    controller._velocity.set(0, 0, 0);
    Object.keys(controller._input._keys).forEach(key => { controller._input._keys[key] = false; });
    controller._mixer.stopAllAction();
    controller.magicSlow = 0;
    controller.parried = 0;
    monster.GetComponent("EnemyAttackController").reset();
    controller._stateMachine.SetState("idle");
    controller._animations.idle.action.reset().play();
    controller._position.set(position.x, 0, position.z);
    monster.SetPosition(controller._position);
    controller._target.rotation.set(0, Math.random() * Math.PI * 2, 0);
    monster.SetQuaternion(controller._target.quaternion);
    return true;
  }

  mapActorsReady() {
    return this.enemies.every(actor => actor.GetComponent("NPCController")._stateMachine._currentState) &&
      this.guideActors.every(actor => actor.GetComponent("GuideController").actions);
  }

  travelStatus(message) {
    this.status(message);
  }

  useGate() {
    if (!this.player) { this.travelStatus("The world is still loading. Try travelling again in a moment."); return false; }
    const gate = nearbyGate(this.map, this.player._position);
    if (!gate) { this.travelStatus("Walk into a glowing ring at the end of a road to travel."); return false; }
    return this.switchMap(gate.to);
  }

  updateGateTravel() {
    const gate = nearbyGate(this.map, this.player._position);
    if (!gate || Math.hypot(this.player._position.x - gate.x, this.player._position.z - gate.z) >= 4) {
      this.enteredGate = null;
      return false;
    }
    if (this.enteredGate === gate || !this.ready || this.traveling || this.progressChanging ||
        this.readingService || this.talking || this.api.grading) return false;
    const controller = this.player.GetComponent("BasicCharacterController");
    if (!this.player.GetComponent("HealthComponent").IsAlive() || this.dodge.active ||
        controller._stateMachine._currentState?.Name === "attack") return false;
    this.enteredGate = gate;
    return this.switchMap(gate.to);
  }

  switchMap(id, returning = false) {
    const map = MAPS[id];
    if (!map) { this.travelStatus("This gate has no destination."); return false; }
    if (!this.ready || this.traveling) { this.travelStatus("The world is still loading. Try travelling again in a moment."); return false; }
    if (!this.mapActorsReady()) { this.travelStatus("Characters are still loading. Try the gate again in a moment."); return false; }
    if (this.api.grading || this.talking || this.progressChanging) {
      this.travelStatus("Finish talking or checking your AWS task before travelling.");
      return false;
    }
    if (!returning && !this.player.GetComponent("HealthComponent").IsAlive()) {
      this.travelStatus("You fell in battle. Click Return to village to recover before travelling.");
      return false;
    }
    const controller = this.player.GetComponent("BasicCharacterController");
    if (!returning && (controller._stateMachine._currentState.Name === "attack" || this.dodge.active)) {
      this.travelStatus("Finish your attack or dodge before travelling.");
      return false;
    }
    const kinds = map.enemies.map((_, index) => monsterFor(id, index));
    if (!this.monsterModels.ready(kinds)) {
      this.traveling = true;
      this.travelStatus(`Loading ${map.name} monsters for the first visit...`);
      this.monsterModels.prepare(kinds).then(() => {
        this.traveling = false;
        this.switchMap(id, returning);
      }).catch(error => {
        this.traveling = false;
        this.travelStatus("Monsters could not load. You are still on this map; try the gate again.");
        console.error(error);
      });
      return false;
    }
    this.traveling = true;
    const root = new THREE.Group();
    let world;
    try {
      world = new World(root, this.models, map, this.readServices);
    } catch (error) {
      disposeMap(root, this.shared);
      this.traveling = false;
      this.travelStatus("This map could not open. You can stay here and try the gate again.");
      console.error(error);
      return false;
    }
    const arrivalGate = returning ? null : map.gates.find(gate => gate.to === this.map.id);
    const arrival = arrivalGate ? [arrivalGate.x, arrivalGate.z] : map.spawn;
    const previous = this.worldRoot;
    this.map = map;
    this.enteredGate = arrivalGate;
    this.worldRoot = root;
    this.world = world;
    this.scene.add(root);
    this.scene.background.setHex(map.sky);
    this.scene.fog.color.setHex(map.sky);
    this.scene.fog.near = map.fogNear;
    this.scene.fog.far = map.fogFar;
    this.sun.intensity = map.id === "dungeon" ? 0.6 : 1.1;
    this.grid = new spatial_hash_grid.SpatialHashGrid(
      [[-map.limit - 20, -map.limit - 20], [map.limit + 20, map.limit + 20]], [80, 80]);
    this.respawns.pending.clear();
    this.spikes.clear();
    this.worldEvents?.reset();
    this.magic?.clearProjectiles();
    this.magicEffects?.clear();
    this.feedback.update(10, () => ({ x: 0, y: 0, z: 0 }));
    this.speakingGuide = null;
    const register = (actor, active, position) => {
      const spatial = actor.GetComponent("SpatialGridController");
      spatial._grid = this.grid;
      spatial._client = null;
      actor.SetActive(active);
      if (!active) return;
      actor.SetPosition(new THREE.Vector3(position[0], 0, position[1]));
      spatial._client = this.grid.NewClient(position, [1, 1]);
      spatial._client.entity = actor;
    };
    register(this.player, true, arrival);
    controller._params.world = world;
    controller._target.position.copy(this.player._position);
    controller._target.rotation.set(0, arrivalGate
      ? Math.atan2(map.spawn[0] - arrival[0], map.spawn[1] - arrival[1]) : Math.PI, 0);
    controller._velocity.set(0, 0, 0);
    controller._stateMachine.SetState("idle");
    this.player.SetQuaternion(controller._target.quaternion);
    const keys = this.player.GetComponent("BasicCharacterControllerInput")._keys;
    Object.keys(keys).forEach(key => { keys[key] = false; });
    this.dodge.remaining = 0;
    this.guard.release();
    if (id === "village" || returning) {
      this.recoverHealth(false);
    }
    const expeditionGuideSlot = { mountains: 1, desert: 2, dungeon: 3 }[id];
    this.guideActors.forEach((actor, index) => {
      const guide = id === "village" ? map.guides[index] :
        (index === expeditionGuideSlot ? map.guides[0] : null);
      const active = Boolean(guide);
      register(actor, active, guide ? [guide.x, guide.z] : null);
      const patrol = actor.GetComponent("GuideController");
      patrol.model.visible = active;
      this.markers[index].visible = this.markers[index].userData.ring.visible = active;
      if (guide) {
        patrol.patrol.home = { x: guide.x, z: guide.z };
        patrol.patrol.position = { x: guide.x, z: guide.z };
        patrol.patrol.target = null;
        patrol.patrol.wait = 1;
        patrol.syncModel();
      }
    });
    this.enemies.forEach((actor, index) => {
      const position = index === MAPS.village.enemies.length && id === "village" ? [BOSS.x, BOSS.z] : map.enemies[index];
      const active = Boolean(position);
      const npc = actor.GetComponent("NPCController");
      npc._params.world = world;
      if (active) npc.setMonster(index === MAPS.village.enemies.length ? "Cyclops" : monsterFor(id, index),
        id !== "village" && index === map.enemies.length - 1);
      npc._target.visible = active;
      const label = actor.GetComponent("EnemyAttackController").superLabel;
      if (label) label.visible = false;
      actor.GetComponent("EnemyAttackController").reset();
      register(actor, active, position);
      if (active) this.respawnEnemy(actor, { x: position[0], z: position[1] });
    });
    cleanupExpiredEffects(this.manager, true);
    const effects = this.manager.Get("level-up-spawner").GetComponent("LevelUpComponentSpawner");
    effects._params.scene = root;
    effects._params.world = world;
    this.cameraBoxes = map.obstacles.map(b => new THREE.Box3(
      new THREE.Vector3(b.x - b.width / 2, 0, b.z - b.depth / 2),
      new THREE.Vector3(b.x + b.width / 2, b.height, b.z + b.depth / 2)));
    disposeMap(previous, this.shared);
    this.renderer.renderLists.dispose();
    this.world.detail.visible = this.quality !== "low";
    this.updateAdventure();
    this.camera.position.copy(this.player._position).add(new THREE.Vector3(0, 23, 35));
    document.getElementById("map").setAttribute("aria-label", "Map of " + map.name);
    document.getElementById("map-label").textContent = map.name + " / N";
    this.traveling = false;
    this.sound.play("portal");
    this.saveCheckpoint();
    this.travelStatus(id === "village"
      ? (returning
          ? "Returned to Cloudhaven with full HP. Your active AWS task is saved."
          : "Welcome back to Cloudhaven with full HP. Walk into glowing gates to explore.")
      : `Entered ${map.name}. Your AWS task is unchanged. Walk into the glowing return gate to travel back.`);
    this.renderer.domElement.focus();
    return true;
  }

  showQuest(completed = false) {
    const quest = this.api.quest;
    const badges = document.getElementById("mission-services");
    badges.replaceChildren();
    for (const id of missionServices(quest)) {
      const service = AWS_SERVICES[id];
      const badge = document.createElement("button");
      badge.type = "button"; badge.className = "service-badge";
      badge.dataset.awsService = id;
      const icon = document.createElement("img");
      icon.src = service.icon; icon.alt = ""; icon.width = icon.height = 24;
      const label = document.createElement("span");
      label.textContent = service.label;
      badge.append(icon, label);
      badges.appendChild(badge);
    }
    badges.hidden = !badges.childElementCount;
    document.getElementById("quest-title").textContent = quest
      ? quest.name.split(".").pop().replace(/_/g, " ")
      : completed ? "All AWS tasks complete" : "A world worth saving";
    document.getElementById("quest-description").textContent = quest
      ? "Complete the AWS task, then defeat a monster to check your work."
      : completed ? "Every available task has passed. Your marks are saved."
        : "Press E near a character with a golden marker to receive an AWS task.";
    document.getElementById("quest-state").textContent = quest ? "ACTIVE" : completed ? "COMPLETE" : "EXPLORE";
    document.getElementById("instructions-button").hidden = !quest;
    const dialog = document.getElementById("task-dialog");
    if (dialog.open && dialog.dataset.kind === "task") {
      if (quest) this.showInstructions();
      else dialog.close();
    }
    document.getElementById("result-link").hidden = true;
  }

  showInstructions() {
    this.guard.release();
    const quest = this.api.quest;
    if (!quest) return;
    this.showReader(quest.name.split(".").pop().replace(/_/g, " "), quest.instruction, "task");
  }

  showConversation(message = this.conversation) {
    this.guard.release();
    if (!message) return;
    this.conversation = message;
    document.getElementById("conversation-button").hidden = false;
    this.showReader("Conversation with your guide", message, "conversation");
  }

  showReader(title, text, kind) {
    this.dodge.remaining = 0;
    const dialog = document.getElementById("task-dialog");
    const content = document.getElementById("task-instructions");
    if (content.textContent !== text || dialog.dataset.kind !== kind) {
      content.textContent = text;
      content.scrollTop = 0;
    }
    dialog.dataset.kind = kind;
    document.getElementById("reader-kind").textContent = kind === "task" ? "AWS TASK INSTRUCTIONS" : "NPC CONVERSATION";
    document.getElementById("task-title").textContent = title;
    document.getElementById("task-help").hidden = kind !== "task";
    if (this.player) {
      const keys = this.player.GetComponent("BasicCharacterControllerInput")._keys;
      Object.keys(keys).forEach(key => { keys[key] = false; });
    }
    if (!dialog.open) dialog.showModal();
  }

  nearbyGuide() {
    if (!this.player) return null;
    const guide = this.manager.Filter(e => e.GetComponent("QuestComponent"))
      .sort((a, b) => a._position.distanceTo(this.player._position) -
        b._position.distanceTo(this.player._position))[0];
    return guide && guide._position.distanceTo(this.player._position) < 24 ? guide : null;
  }

  nearbyAwsLandmark(range = 14) {
    if (!this.player || !this.map) return null;
    const pos = this.player._position;
    const landmarks = AWS_LANDMARKS[this.map.id] || [];
    for (const lm of landmarks) {
      if (Math.hypot(pos.x - lm.x, pos.z - lm.z) <= range) return lm;
    }
    if (this.map.id === "village") {
      for (let i = 0; i < BUILDINGS.length; i++) {
        const b = BUILDINGS[i];
        if (Math.hypot(pos.x - b.x, pos.z - b.z) <= range + 4) {
          const service = BUILDING_SERVICES[i];
          return { service, x: b.x, z: b.z, label: AWS_SERVICES[service]?.label };
        }
      }
    }
    return null;
  }

  talkToGuide() {
    const quest = this.api.quest;
    const guide = this.nearbyGuide();
    const landmark = !guide && !quest ? this.nearbyAwsLandmark?.(14) : null;
    if (landmark) {
      this.showService?.(landmark.service);
      return;
    }
    if (!quest && !guide) {
      this.status("Move closer to a character with a golden marker or an AWS sign, then press E.");
      return;
    }
    if (!localStorage.getItem("api_key")?.trim()) {
      const message = "Set your API key first to talk to a guide and receive AWS tasks. You can still explore and fight without a key.";
      this.status(message);
      this.showKeyDialog(message);
      return;
    }
    if (quest) {
      this.showInstructions();
      return;
    }
    this.renderer?.domElement?.focus?.();
    guide?.Broadcast?.({ topic: "input.picked" });
  }

  async talk(guide = null) {
    if (this.talking) return;
    this.speakingGuide = guide;
    this.talking = true;
    this.status("Loading your next AWS task...");
    try {
      const response = await this.api.requestQuest();
      this.showQuest(response.completed);
      this.status(response.completed ? "You have completed all tasks!"
        : response.task ? "Task received. Read its instructions, then defeat a monster to check your work."
          : "Your guide has replied. You can reopen the conversation here.");
      if (response.task) {
        this.sound.play("quest");
        this.showInstructions();
      } else if (response.message && !response.completed) {
        this.showConversation(response.message);
      }
    } catch (error) {
      this.status(error.message);
    } finally {
      this.talking = false;
    }
  }

  async grade(batch) {
    if (batch?.graded) return;
    if (batch) batch.graded = true;
    const quest = this.api.quest;
    if (!quest) {
      this.status("Press E near a guide to get an AWS task, complete its instructions, then defeat a monster to grade it.");
      return;
    }
    if (this.api.grading) return;
    const account = localStorage.getItem("api_key"), reset = localStorage.getItem(MARKS_RESET_KEY);
    const version = this.progress.version;
    this.status("Checking AWS resources... You can keep exploring.");
    try {
      const result = await this.api.gradeQuest();
      if (!result || account !== localStorage.getItem("api_key") || reset !== localStorage.getItem(MARKS_RESET_KEY) ||
          version !== this.progress.version || this.progressChanging) return;
      if (result.isSuccess) {
        const emerald = this.progress.unlocked("verdant");
        this.progress.pass(quest.filter);
        if (!emerald && this.progress.data.finish === "plain") this.progress.selectFinish("verdant");
        this.updateAdventure();
        this.saveCheckpoint();
      }
      this.sound.play(result.isSuccess ? "success" : "failure");
      this.showQuest();
      this.status(result.isSuccess
        ? "Validation passed! Your AWS marks are saved. Visit a guide for the next mission."
        : "Changes needed. Fix your AWS resources, then defeat another monster to retry. Your mission instructions are still saved.");
      const link = document.getElementById("result-link");
      try {
        const url = new URL(result.logUrl);
        link.hidden = !["https:", "http:"].includes(url.protocol);
        if (!link.hidden) link.href = url.href;
      } catch {
        link.hidden = true;
      }
    } catch (error) {
      if (account !== localStorage.getItem("api_key") || reset !== localStorage.getItem(MARKS_RESET_KEY) ||
          version !== this.progress.version || this.progressChanging) return;
      this.status(`${error.message} Your task is saved; defeat another monster to retry grading.`);
    }
  }

  returnHome() {
    if (!this.player || !this.ready) return;
    this.dodge.remaining = 0;
    this.guard.release();
    if (this.map.id !== "village") {
      this.switchMap("village", true);
      this.recoverHealth(true);
      return;
    }
    const controller = this.player.GetComponent("BasicCharacterController");
    controller._target.position.set(PLAYER_SPAWN[0], 0, PLAYER_SPAWN[1]);
    controller._velocity.set(0, 0, 0);
    controller._target.rotation.y = Math.PI;
    this.player.SetPosition(controller._target.position);
    this.player.SetQuaternion(controller._target.quaternion);
    const recovered = this.recoverHealth(true);
    this.status(recovered
      ? "Revived in Cloudhaven with full HP! Your active quest is still saved."
      : "Welcome back to Cloudhaven. Your active quest is still saved.");
    this.renderer?.domElement?.focus();
  }

  recoverHealth(announce = true) {
    if (!this.player) return false;
    const health = this.player.GetComponent("HealthComponent");
    if (!health) return false;
    const wasDead = !health.IsAlive();
    const wasInjured = health._health < health._maxHealth;
    health._health = health._maxHealth;
    health._UpdateUI?.();
    const doc = typeof document !== "undefined" ? document : null;
    const valEl = doc?.getElementById?.("health-value");
    if (valEl) valEl.textContent = `${health._maxHealth} / ${health._maxHealth}`;
    const barEl = doc?.getElementById?.("health-bar");
    if (barEl) barEl.style.width = "100%";
    const homeBtn = doc?.getElementById?.("home-button");
    if (homeBtn) {
      homeBtn.textContent = "Return to village";
      homeBtn.classList.remove("revive-needed");
    }
    const controller = this.player.GetComponent("BasicCharacterController");
    if (controller) {
      controller.frostSlow = 0;
      if (wasDead || controller._stateMachine?._currentState?.Name === "death") {
        const deathAction = controller._animations?.["death"]?.action;
        if (deathAction) {
          deathAction.stop?.();
          deathAction.reset?.();
        }
        controller._mixer?.stopAllAction?.();
        controller._stateMachine?.SetState?.("idle");
        const idleAction = controller._animations?.["idle"]?.action;
        if (idleAction) {
          idleAction.reset?.();
          idleAction.enabled = true;
          idleAction.setEffectiveWeight?.(1.0);
          idleAction.play?.();
        }
      }
    }
    if ((wasDead || wasInjured) && announce) {
      this.sound?.play?.("revive");
    }
    return wasDead || wasInjured;
  }

  healPlayer(level = 1) {
    if (!this.player) return false;
    const health = this.player.GetComponent?.("HealthComponent");
    if (!health || (typeof health.IsAlive === "function" && !health.IsAlive())) return false;
    const healPct = 0.35 + (level - 1) * 0.10;
    const healAmount = Math.max(1, Math.round(health._maxHealth * healPct));
    const prev = health._health;
    health._health = Math.min(health._maxHealth, health._health + healAmount);
    const actual = health._health - prev;
    health._UpdateUI?.();
    const doc = typeof document !== "undefined" ? document : null;
    const val = doc?.getElementById?.("health-value");
    if (val) val.textContent = `${health._health} / ${health._maxHealth}`;
    const charController = this.player.GetComponent?.("BasicCharacterController");
    const pos = charController?._target?.position || this.player._position;
    if (pos && this.feedback?.show) {
      const feedbackPos = typeof THREE !== "undefined" && THREE.Vector3 && pos.clone
        ? pos.clone().add(new THREE.Vector3(0, 7, 0))
        : { x: pos.x, y: (pos.y || 0) + 7, z: pos.z };
      this.feedback.show(feedbackPos, actual > 0 ? `+${actual} HP` : "MAX HP", "#7dffd0");
    }
    this.sound?.play?.("portal");
    return true;
  }

  updateCamera(dt) {
    const target = (this._cameraTarget ??= new THREE.Vector3()).copy(this.player._position);
    const charY = this.player.GetComponent("BasicCharacterController")?._target?.position?.y || 0;
    const skyMeteor = this.magicEffects?.active.some(effect =>
      (effect.kind === "titan-meteor" && effect.age < 1.6) ||
      (effect.kind === "planetary-devastation" && effect.age < 2.2));
    target.y += 5 + charY * 0.75 + (skyMeteor ? 9 : 0);
    const fullRelease = this.magicEffects?.active.some(effect =>
      effect.kind === "avatar" || effect.kind === "titan" || effect.kind === "release-boundary");
    const comboFraming = this.magicEffects?.active.reduce((max, effect) => Math.max(max, {
      "singularity": 82, "aurora-excalibur": 82, "planetary-devastation": 62, "titan-meteor": 56,
      "blade-barrage": 62, "edge-flash": 58, "susanoo-mecha": 56, "malevolent-shrine": 54,
      "infinite-void": 60, "almighty-push": 52, "time-rewind": 50,
    }[effect.kind] || 0), 0) || 0;
    const halfFov = this.camera.fov * Math.PI / 360;
    const fitFov = Math.min(halfFov, Math.atan(Math.tan(halfFov) * this.camera.aspect));
    const framing = fullRelease ? FULL_RELEASE_RANGE / Math.sin(fitFov) / Math.hypot(1, 0.65) :
      Math.max(comboFraming, charY > 0 || skyMeteor ? 48 : 0);
    const cameraDistance = Math.max(this.cameraDistance, framing);
    const viewDistance = cameraDistance * Math.hypot(1, 0.65);
    const far = Math.max(850, viewDistance + FULL_RELEASE_RANGE * 2);
    if (this.camera.far !== far) {
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.scene.fog.near = fullRelease ? Math.max(this.map.fogNear, viewDistance - FULL_RELEASE_RANGE) : this.map.fogNear;
    this.scene.fog.far = fullRelease ? Math.max(this.map.fogFar, viewDistance + FULL_RELEASE_RANGE * 2) : this.map.fogFar;
    const pitch = this.cameraPitch ?? 0.65;
    const yaw = this.cameraYaw || 0;
    const desired = (this._cameraDesired ??= new THREE.Vector3())
      .set(Math.sin(yaw) * cameraDistance, cameraDistance * pitch + charY * 0.4, -Math.cos(yaw) * cameraDistance)
      .applyQuaternion(this.player._rotation).add(this.player._position);
    this.camera.position.lerp(desired, 1 - Math.pow(0.002, dt));
    if (!fullRelease && !comboFraming && charY <= 0) {
      const direction = (this._cameraDir ??= new THREE.Vector3()).copy(this.camera.position).sub(target);
      let distance = direction.length();
      const ray = (this._cameraRay ??= new THREE.Ray()).set(target, direction.normalize());
      const hit = (this._cameraHit ??= new THREE.Vector3());
      for (const box of this.cameraBoxes) {
        const intersection = ray.intersectBox(box, hit);
        if (intersection && intersection.distanceTo(target) < distance) {
          distance = Math.max(0.5, intersection.distanceTo(target) - 0.8);
          this.camera.position.copy(target).addScaledVector(direction, distance);
        }
      }
    }
    this.camera.lookAt(target);
  }

  drawMap() {
    drawMinimap(document.getElementById("map").getContext("2d"),
      this.map, this.markers, this.player._position, this.worldEvents?.outage);
  }

  frame() {
    if (this.failed) return;
    requestAnimationFrame(() => this.frame());
    if (this.readingService || document.getElementById("combat-manual").open) {
      this.clock.getDelta();
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const elapsed = this.clock.getDelta();
    const dt = Math.min(elapsed, 1 / 30);
    this.guard.update(dt);
    const time = this.clock.elapsedTime;
    const controller = this.player.GetComponent("BasicCharacterController");
    if (localStorage.getItem("api_key") !== this.progressKey || localStorage.getItem(MARKS_RESET_KEY) !== this.progressReset) {
      this.magic.clearProjectiles();
      this.magicEffects.clear();
      sessionStorage.removeItem(QUEST_KEY);
      this.syncProgress();
      this.showQuest();
    }
    if (!this.ready && controller._stateMachine._currentState) {
      this.ready = true;
      controller._target.position.copy(this.player._position);
      controller._target.rotation.y = Math.PI;
      clearTimeout(this.loadTimeout);
      document.getElementById("loading").hidden = true;
      document.body.dataset.ready = "true";
    }
    this.restoreCheckpoint();
    const beforeX = this.player._position.x, beforeZ = this.player._position.z;
    this.manager.Update(dt);
    cleanupExpiredEffects(this.manager);
    if (this.traveling || this.progressChanging || !this.player.GetComponent("HealthComponent").IsAlive()) {
      this.magic.clearProjectiles();
      this.magicEffects.clear();
    } else this.magic.update(elapsed);
    this.magicEffects.update(elapsed);
    this.updateMagicUI();
    const dodge = this.dodge.update(dt, this.player._position, (x, z, from) => this.world.canWalk(x, z) &&
      findMovementBlockers(this.grid, this.player, { x, z }, from).length === 0);
    if (dodge.x !== this.player._position.x || dodge.z !== this.player._position.z) {
      controller._target.position.set(dodge.x, 0, dodge.z);
      this.player.SetPosition(controller._target.position);
    }
    this.sound.step(Math.hypot(this.player._position.x - beforeX, this.player._position.z - beforeZ),
      controller._stateMachine._currentState?.Name === "run");
    this.respawns.update(dt, monster => this.respawnEnemy(monster));
    if (this.traveling || this.progressChanging || !this.player.GetComponent("HealthComponent").IsAlive() ||
        isSafePosition(this.map, this.player._position.x, this.player._position.z)) this.spikes.clear();
    else this.spikes.update(dt, {
      player: this.player._position,
      canWalk: (x, z) => this.world.canWalk(x, z),
      isSafe: (x, z) => isSafePosition(this.map, x, z),
      hit: shot => this.player.Broadcast({ topic: "health.damage", value: shot.damage, attacker: shot.attacker,
        direction: { x: -shot.vx, z: -shot.vz } }),
    });
    this.spikes.active.forEach(shot => shot.mesh.position.set(shot.x, 3, shot.z));
    this.world.update(time, this.player._position, this.camera);
    if (this.quality === "low") this.world.detail.visible = false;
    this.markers.forEach((marker, index) => {
      const guide = marker.userData.guide._position;
      marker.position.x = marker.userData.ring.position.x = guide.x;
      marker.position.z = marker.userData.ring.position.z = guide.z;
      marker.position.y = 9 + Math.sin(time * 2 + index) * 0.45;
      marker.rotation.y = time;
    });
    this.updateCamera(dt);
    const position = this.player._position;
    if (this.updateGateTravel()) return;
    const eventStep = this.worldEvents?.update(dt, this.map.id, position);
    if (eventStep?.heal > 0) {
      const health = this.player.GetComponent("HealthComponent");
      if (health.IsAlive() && health._health < health._maxHealth) {
        health._health = Math.min(health._maxHealth, health._health + eventStep.heal);
        health._UpdateUI();
        document.getElementById("health-value").textContent = `${health._health} / ${health._maxHealth}`;
      }
    }
    this.sun.position.set(position.x - 55, 95, position.z + 40);
    this.sun.target.position.copy(position);
    document.getElementById("region").textContent = this.map.id === "village" ? regionAt(position.x, position.z) : this.map.name;
    document.getElementById("cloud-region").textContent = CLOUD_REGIONS[this.map.id].subtitle;
    document.getElementById("shield-state").textContent = this.guard.broken > 0
      ? `Guard broken: ${this.guard.broken.toFixed(1)}s`
      : this.guard.active ? "Blocking" : "";
    document.getElementById("shield-state").hidden = !this.guard.active && this.guard.broken <= 0;
    document.getElementById("dodge-state").textContent = this.dodge.active ? "Dodging: invulnerable" :
      this.dodge.cooldown > 0 ? `Dodge: ${this.dodge.cooldown.toFixed(1)}s` : "";
    document.getElementById("dodge-state").hidden = !this.dodge.active && this.dodge.cooldown <= 0;
    const chest = this.nearbyChest();
    const boss = this.boss.GetComponent("HealthComponent"), gate = nearbyGate(this.map, position);
    const nearbyEnemy = this.enemies.filter(actor => actor.GetComponent("NPCController")._target?.visible &&
      actor.GetComponent("HealthComponent").IsAlive() && actor._position.distanceTo(position) < 30)
      .sort((a, b) => a._position.distanceToSquared(position) - b._position.distanceToSquared(position))[0];
    const enemyHealth = nearbyEnemy?.GetComponent("HealthComponent");
    const outage = this.worldEvents?.outage;
    const eventHint = this.worldEvents?.surge > 0 ? `AZ Restored: +20% Speed & Haste (${Math.ceil(this.worldEvents.surge)}s)` :
      this.worldEvents?.activeZone?.label ? this.worldEvents.activeZone.label :
      outage ? `Outage Alert: ${outage.label} (${Math.ceil(outage.remaining)}s)` : "";
    const landmark = this.nearbyAwsLandmark?.(14);
    const landmarkHint = landmark ? `${AWS_SERVICES[landmark.service]?.label || landmark.service.toUpperCase()}: Press E or click sign to learn` : "";
    document.getElementById("explore-hint").textContent = gate ? MAPS[gate.to].name :
      nearbyEnemy ? `${nearbyEnemy.GetComponent("NPCController").profile.label}: ${Math.ceil(enemyHealth._health)} / ${enemyHealth._maxHealth} HP` :
      chest ? chest.name :
      landmarkHint ? landmarkHint :
      this.boss._position.distanceTo(position) < 35 && boss.IsAlive()
        ? `Optional: ${BOSS.name} ${Math.ceil(boss._health)} / ${boss._maxHealth} HP`
        : eventHint;
    document.getElementById("explore-hint").hidden = !document.getElementById("explore-hint").textContent;
    this.feedback.update(dt, point => {
      const projected = (this._projected ??= new THREE.Vector3()).copy(point).project(this.camera);
      return { x: (projected.x + 1) * innerWidth / 2, y: (1 - projected.y) * innerHeight / 2, z: projected.z };
    });
    this.drawMap();
    this.renderer.render(this.scene, this.camera);
  }

  fail(error) {
    clearTimeout(this.loadTimeout);
    document.getElementById("loading").hidden = false;
    document.getElementById("loading-message").textContent = error.message;
    document.getElementById("loading-actions").hidden = false;
    document.getElementById("graphics-help").hidden = !(error instanceof WebGLUnavailableError);
  }
}

const game = new Game();
game.start().catch(error => game.fail(error));
