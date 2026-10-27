import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.118.1/build/three.module.js";
import { FBXLoader } from "https://cdn.jsdelivr.net/npm/three@0.118.1/examples/jsm/loaders/FBXLoader.js";
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
import { Assets } from "./assets.js";
import { GameApi, QUEST_KEY, MARKS_RESET_KEY } from "./api.js";
import { World } from "./world.js";
import { createRenderer, WebGLUnavailableError } from "./renderer.js";
import { findMeleeTargets } from "./combat.js";
import { GuidePatrol } from "./guides.js";
import { findMonsterSpawn, MonsterRespawns } from "./spawning.js";
import { BUILDINGS, GUIDES, ENEMY_SPAWNS, LAKE, PLAYER_SPAWN, regionAt, seededRandom } from "./layout.js";

class BasicCharacterController extends player_entity.BasicCharacterController {
  _FindIntersections(position) {
    return this._params.world.canWalk(position.x, position.z) ? super._FindIntersections(position) : [true];
  }
}

class BasicCharacterControllerInput extends player_input.BasicCharacterControllerInput {
  _onKeyDown(event) {
    if (event.target.closest("input, select, dialog")) return;
    if (event.code === "KeyE" && !event.repeat) {
      event.preventDefault();
      this._params.game.talkToGuide();
      return;
    }
    if (event.target.closest("button, a, summary")) return;
    if (["Space", "KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) event.preventDefault();
    super._onKeyDown(event);
  }

  _onMouseUp() {
    // Keep V2 interaction keyboard-only instead of using Classic's picker.
  }
}

class SpatialGridController extends spatial_grid_controller.SpatialGridController {
  FindNearbyEntities(range) {
    // Shared melee controllers stop four units away but query a two-unit box.
    return range === 2 ? findMeleeTargets(this._grid, this._parent) : super.FindNearbyEntities(range);
  }
}

class QuestComponent extends entity.Component {
  constructor(game) { super(); this.game = game; }
  InitComponent() {
    this._RegisterHandler("input.picked", () => this.game.talk(this._parent));
  }
}

class GuideController extends entity.Component {
  constructor(game, home) {
    super();
    this.game = game;
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
    const loader = new FBXLoader();
    const load = url => new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
    const [model, idle, walk] = await Promise.all([
      load("./resources/girl/peasant_girl.fbx"),
      load("./resources/girl/Standing Idle.fbx"),
      load("./resources/guard/Sword And Shield Walk.fbx"),
    ]);
    this.model = model;
    model.scale.setScalar(0.035);
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
    const walkClip = walk.animations[0].clone();
    walkClip.tracks = walkClip.tracks.filter(track => model.getObjectByName(track.name.split(".")[0]));
    for (const track of walkClip.tracks.filter(track => track.name.endsWith("Hips.position"))) {
      for (let i = 3; i < track.values.length; i += 3) {
        track.values[i] = track.values[0];
        track.values[i + 2] = track.values[2];
      }
    }
    this.actions = { idle: this.mixer.clipAction(idle.animations[0]), walk: this.mixer.clipAction(walkClip) };
    this.action = this.actions.idle;
    this.action.play();
    this.syncModel();
  }

  syncModel() {
    this.model.position.copy(this._parent._position);
    this.model.position.y = 0.35;
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
  _OnDeath() {
    if (this._stateMachine._currentState?.Name === "death") return;
    this._stateMachine.SetState("death");
    this._params.game.defeated++;
    document.getElementById("defeated").textContent = this._params.game.defeated;
    this._params.game.grade();
    this._params.game.respawns.schedule(this._parent);
  }

  _FindIntersections(position) {
    return this._params.world.canWalk(position.x, position.z) ? super._FindIntersections(position) : [true];
  }

  _FindPlayer() {
    const player = this.FindEntity("player");
    if (Math.abs(player._position.x) < 58 && Math.abs(player._position.z) < 46) {
      return new THREE.Vector3();
    }
    if (player._position.distanceTo(this._parent._position) > 36) return new THREE.Vector3();
    return super._FindPlayer();
  }
}

class HealthComponent extends health_component.HealthComponent {
  _OnDamage(message) {
    if (!this.IsAlive()) return;
    super._OnDamage(message);
    if (this._params.updateUI) {
      document.getElementById("health-value").textContent = `${this._health} / ${this._maxHealth}`;
      if (!this.IsAlive()) this._params.game.status("You fell in battle. Return to the village to recover.");
    }
  }
}

class EquipWeapon extends equip_weapon_component.EquipWeapon {
  _OnEquip(message) {
    if (!message.value) {
      this._UnloadModels();
      this._name = null;
      return;
    }
    super._OnEquip(message);
  }
}

class Game {
  constructor() {
    this.api = new GameApi({ baseUrl });
    this.manager = new entity_manager.EntityManager();
    this.grid = new spatial_hash_grid.SpatialHashGrid([[-200, -200], [200, 200]], [80, 80]);
    this.respawns = new MonsterRespawns();
    this.defeated = 0;
    this.ready = false;
    this.talking = false;
    this.conversation = "";
    this.quality = localStorage.getItem("aws-warrior:v2:quality") || "medium";
    this.markers = [];
    this.cameraDistance = 29;
    this.clock = new THREE.Clock();
    this.bindUI();
  }

  status(message) { document.getElementById("status").textContent = message; }

  bindUI() {
    const dialog = document.getElementById("key-dialog");
    document.getElementById("key-button").onclick = () => {
      document.getElementById("api-key").value = localStorage.getItem("api_key") || "";
      dialog.showModal();
    };
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
    const slots = document.getElementById("inventory-slots");
    for (let i = 1; i <= 32; i++) {
      const slot = document.createElement("div");
      slot.id = i <= 24 ? `inventory-${i}` : `inventory-equip-${i - 24}`;
      slot.className = "inventory-slot";
      slot.draggable = true;
      slot.title = i <= 24 ? `Inventory slot ${i}` : `Equipment slot ${i - 24}`;
      slots.appendChild(slot);
    }
    window.addEventListener("blur", () => {
      if (this.player) Object.keys(this.player.GetComponent("BasicCharacterControllerInput")._keys)
        .forEach(key => { this.player.GetComponent("BasicCharacterControllerInput")._keys[key] = false; });
    });
    window.addEventListener("storage", event => {
      if (event.key === MARKS_RESET_KEY) {
        this.showQuest();
        this.status("Your marks were reset. Press E near a guide to start again.");
      }
    });
    window.addEventListener("wheel", event => {
      if (!event.target.closest(".v2-ui")) {
        this.cameraDistance = THREE.MathUtils.clamp(this.cameraDistance + event.deltaY * 0.02, 18, 46);
      }
    }, { passive: true });
    this.showQuest();
  }

  async start() {
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
    await assets.preload();
    this.world = new World(this.scene, await assets.templates());
    this.cameraBoxes = BUILDINGS.map(b => new THREE.Box3(
      new THREE.Vector3(b.x - 8.5, 0, b.z - 8.5),
      new THREE.Vector3(b.x + 8.5, 16, b.z + 8.5)));
    this.spawnPlayer();
    this.spawnGuides();
    this.spawnEnemies();
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
    return { health: updateUI ? 100 : 50, maxHealth: updateUI ? 100 : 50,
      strength: updateUI ? 50 : 2, wisdomness: 5, benchpress: 20, curl: 10,
      experience: 0, level: 1, updateUI, game: this };
  }

  spawnPlayer() {
    const params = { camera: this.camera, scene: this.scene, world: this.world, game: this };
    const spawner = new entity.Entity();
    spawner.AddComponent(new level_up_component.LevelUpComponentSpawner(params));
    this.manager.Add(spawner, "level-up-spawner");
    for (const [name, icon] of [["Sword", "pointy-sword-64.png"], ["Axe", "war-axe-64.png"]]) {
      const item = new entity.Entity();
      item.AddComponent(new inventory_controller.InventoryItem({
        type: "weapon", damage: 3, renderParams: { name, scale: 0.25, icon },
      }));
      this.manager.Add(item, name);
    }
    const player = new entity.Entity();
    player.AddComponent(new BasicCharacterControllerInput(params));
    player.AddComponent(new BasicCharacterController(params));
    player.AddComponent(new EquipWeapon({ anchor: "RightHandIndex1" }));
    player.AddComponent(new inventory_controller.InventoryController(params));
    player.AddComponent(new HealthComponent(this.stats(true)));
    player.AddComponent(new SpatialGridController({ grid: this.grid }));
    player.AddComponent(new attack_controller.AttackController({ timing: 0.7 }));
    player.SetPosition(new THREE.Vector3(PLAYER_SPAWN[0], 0, PLAYER_SPAWN[1]));
    player.SetQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    this.manager.Add(player, "player");
    this.player = player;
    for (const name of ["Sword", "Axe"]) player.Broadcast({ topic: "inventory.add", value: name });
    player.Broadcast({ topic: "inventory.equip", value: "Sword" });
  }

  spawnGuides() {
    for (const guide of GUIDES) {
      const npc = new entity.Entity();
      npc.AddComponent(new GuideController(this, guide));
      npc.AddComponent(new SpatialGridController({ grid: this.grid }));
      npc.AddComponent(new QuestComponent(this));
      npc.SetPosition(new THREE.Vector3(guide.x, 0, guide.z));
      this.manager.Add(npc, guide.name);
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
    }
  }

  spawnEnemies() {
    const names = ["Ghost", "GreenDemon", "Cyclops", "Skull"];
    ENEMY_SPAWNS.forEach(([x, z], index) => {
      const name = names[index % names.length];
      const monster = new entity.Entity();
      monster.AddComponent(new NPCController({
        camera: this.camera, scene: this.scene, game: this, world: this.world,
        resourceName: `${name}.fbx`, resourceTexture: `${name}_Texture.png`,
      }));
      monster.AddComponent(new HealthComponent(this.stats()));
      monster.AddComponent(new SpatialGridController({ grid: this.grid }));
      monster.AddComponent(new attack_controller.AttackController({ timing: 0.35 }));
      monster.SetPosition(new THREE.Vector3(x, 0, z));
      this.manager.Add(monster);
    });
  }

  respawnEnemy(monster) {
    const position = findMonsterSpawn({
      canWalk: (x, z) => this.world.canWalk(x, z),
      player: this.player._position,
      occupied: this.manager.Filter(actor => actor !== monster &&
        (actor.GetComponent("QuestComponent") || actor.GetComponent("HealthComponent")?.IsAlive()))
        .map(actor => actor._position),
    });
    if (!position) return false;
    const controller = monster.GetComponent("NPCController");
    const health = monster.GetComponent("HealthComponent");
    health._health = health._maxHealth;
    controller._velocity.set(0, 0, 0);
    Object.keys(controller._input._keys).forEach(key => { controller._input._keys[key] = false; });
    controller._mixer.stopAllAction();
    controller._stateMachine.SetState("idle");
    controller._position.set(position.x, 0, position.z);
    monster.SetPosition(controller._position);
    controller._target.rotation.set(0, Math.random() * Math.PI * 2, 0);
    monster.SetQuaternion(controller._target.quaternion);
    return true;
  }

  showQuest(completed = false) {
    const quest = this.api.quest;
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
    const quest = this.api.quest;
    if (!quest) return;
    this.showReader(quest.name.split(".").pop().replace(/_/g, " "), quest.instruction, "task");
  }

  showConversation(message = this.conversation) {
    if (!message) return;
    this.conversation = message;
    document.getElementById("conversation-button").hidden = false;
    this.showReader("Conversation with your guide", message, "conversation");
  }

  showReader(title, text, kind) {
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

  talkToGuide() {
    if (this.api.quest) {
      this.showInstructions();
      return;
    }
    const guide = this.nearbyGuide();
    if (guide) {
      this.renderer.domElement.focus();
      guide.Broadcast({ topic: "input.picked" });
    } else {
      this.status("Move closer to a character with a golden marker, then press E.");
    }
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

  async grade() {
    if (!this.api.quest) {
      this.status("Press E near a guide to get an AWS task, complete its instructions, then defeat a monster to grade it.");
      return;
    }
    if (this.api.grading) return;
    this.status("Grading your AWS quest. You can keep exploring...");
    try {
      const result = await this.api.gradeQuest();
      this.showQuest();
      this.status(result.isSuccess
        ? "Quest passed! Your marks are saved. Press E near a guide for the next challenge."
        : "Task not passed. Fix your AWS resources, then defeat another monster to retry. Your task instructions are still saved.");
      const link = document.getElementById("result-link");
      try {
        const url = new URL(result.logUrl);
        link.hidden = !["https:", "http:"].includes(url.protocol);
        if (!link.hidden) link.href = url.href;
      } catch {
        link.hidden = true;
      }
    } catch (error) {
      this.status(`${error.message} Your task is saved; defeat another monster to retry grading.`);
    }
  }

  returnHome() {
    if (!this.player || !this.ready) return;
    const controller = this.player.GetComponent("BasicCharacterController");
    controller._target.position.set(PLAYER_SPAWN[0], 0, PLAYER_SPAWN[1]);
    controller._velocity.set(0, 0, 0);
    controller._target.rotation.y = Math.PI;
    controller._stateMachine.SetState("idle");
    this.player.SetPosition(controller._target.position);
    this.player.SetQuaternion(controller._target.quaternion);
    const health = this.player.GetComponent("HealthComponent");
    health._health = health._maxHealth;
    health._UpdateUI();
    document.getElementById("health-value").textContent = "100 / 100";
    this.status("Welcome back to Cloudhaven. Your active quest is still saved.");
    this.renderer.domElement.focus();
  }

  updateCamera(dt) {
    const target = this.player._position.clone().add(new THREE.Vector3(0, 5, 0));
    const desired = new THREE.Vector3(0, this.cameraDistance * 0.65, -this.cameraDistance)
      .applyQuaternion(this.player._rotation).add(this.player._position);
    this.camera.position.lerp(desired, 1 - Math.pow(0.002, dt));
    const direction = this.camera.position.clone().sub(target);
    let distance = direction.length();
    const ray = new THREE.Ray(target, direction.normalize());
    for (const box of this.cameraBoxes) {
      const intersection = ray.intersectBox(box, new THREE.Vector3());
      if (intersection && intersection.distanceTo(target) < distance) {
        distance = Math.max(0.5, intersection.distanceTo(target) - 0.8);
        this.camera.position.copy(target).addScaledVector(direction, distance);
      }
    }
    this.camera.lookAt(target);
  }

  drawMap() {
    const ctx = document.getElementById("map").getContext("2d");
    ctx.fillStyle = "#294940";
    ctx.fillRect(0, 0, 200, 200);
    const point = (x, z) => [100 + x * 0.55, 100 + z * 0.55];
    ctx.strokeStyle = "#a19064";
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(100, 10); ctx.lineTo(100, 190);
    ctx.moveTo(60, 100); ctx.lineTo(140, 100); ctx.stroke();
    ctx.fillStyle = "#4c8994";
    ctx.beginPath(); ctx.ellipse(...point(LAKE.x, LAKE.z), LAKE.rx * 0.55, LAKE.rz * 0.55, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#c9ac79";
    BUILDINGS.forEach(b => ctx.fillRect(...point(b.x - 8, b.z - 8), 9, 9));
    ctx.fillStyle = "#83d6cf";
    ctx.fillRect(...point(83, -96), 13, 13);
    ctx.fillStyle = "#ffda88";
    this.markers.forEach(marker => {
      const guide = marker.userData.guide._position;
      ctx.beginPath(); ctx.arc(...point(guide.x, guide.z), 2.5, 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(...point(this.player._position.x, this.player._position.z), 3.5, 0, Math.PI * 2); ctx.fill();
  }

  frame() {
    if (this.failed) return;
    requestAnimationFrame(() => this.frame());
    const dt = Math.min(this.clock.getDelta(), 1 / 30);
    const time = this.clock.elapsedTime;
    const controller = this.player.GetComponent("BasicCharacterController");
    if (!this.ready && controller._stateMachine._currentState) {
      this.ready = true;
      controller._target.position.copy(this.player._position);
      controller._target.rotation.y = Math.PI;
      clearTimeout(this.loadTimeout);
      document.getElementById("loading").hidden = true;
      document.body.dataset.ready = "true";
    }
    this.manager.Update(dt);
    this.respawns.update(dt, monster => this.respawnEnemy(monster));
    this.world.update(time, this.player._position);
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
    this.sun.position.set(position.x - 55, 95, position.z + 40);
    this.sun.target.position.copy(position);
    document.getElementById("region").textContent = regionAt(position.x, position.z);
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
