import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MAPS, isMapWalkable, isSafePosition, nearbyGate, mapScenery, isMagicWaveClear } from '../v2/maps.js';
import { sharedResources, disposeMap, cleanupExpiredEffects } from '../v2/map-lifecycle.js';
import { drawMinimap } from '../v2/minimap.js';
import { WorldEvents, environmentModifier, OUTAGE_COOLDOWN } from '../v2/world-events.js';
import { findMonsterSpawn } from '../v2/spawning.js';
import { seededRandom, isWalkable, isPath, createScenery } from '../v2/layout.js';

test('all village gates and destinations are valid and preserve the original village layout', () => {
  assert.equal(MAPS.village.enemies.length, 24);
  assert.equal(MAPS.village.guides.length, 4);
  assert.deepEqual(MAPS.village.spawn, [0, 20]);
  assert.equal(MAPS.village.gates.length, 3);
  for (const map of Object.values(MAPS)) {
    for (const gate of map.gates) {
      assert.ok(MAPS[gate.to]);
      assert.ok(map.id === 'village' ? isWalkable(gate.x, gate.z) : isMapWalkable(map, gate.x, gate.z));
      assert.equal(nearbyGate(map, gate), gate);
      assert.equal(nearbyGate(map, { x: gate.x, z: gate.z + 9 }), null);
    }
    if (map.id !== 'village') assert.equal(map.gates[0].to, 'village');
  }
});

test('execution waves cross lakes and ground clutter but not buildings or solid walls', () => {
  assert.equal(isMagicWaveClear(MAPS.village, { x: 50, z: 56 }, { x: 110, z: 56 }), true);
  assert.equal(isWalkable(65, 56), false, 'lake is not walkable');
  assert.equal(isMagicWaveClear(MAPS.village, { x: 0, z: -15 }, { x: 0, z: 5 }), true);
  assert.equal(isMagicWaveClear(MAPS.village, { x: -27, z: -45 }, { x: -27, z: 0 }), false);
  assert.equal(isMagicWaveClear(MAPS.village, { x: 100, z: -110 }, { x: 100, z: -80 }), false);
  assert.equal(isMagicWaveClear(MAPS.dungeon, { x: 20, z: 30 }, { x: 20, z: 65 }), false);
  assert.equal(isMagicWaveClear(MAPS.dungeon, { x: 0, z: 30 }, { x: 0, z: 65 }), true);
  assert.equal(isMagicWaveClear(MAPS.village, { x: NaN, z: 0 }, { x: 0, z: 0 }), false);
});

test('doubled ordinary populations retain safe spaced village spawns and one expedition boss slot', () => {
  const trees = createScenery().trees;
  assert.equal(MAPS.village.enemies.length, 24);
  for (const [x, z] of MAPS.village.enemies.slice(12)) {
    assert.ok(isWalkable(x, z, 3, trees));
    assert.equal(isSafePosition(MAPS.village, x, z), false);
  }
  for (const map of Object.values(MAPS)) {
    if (map.id !== 'village') assert.equal(map.enemies.length - 1, 14);
    map.enemies.forEach(([x, z], index) => {
      assert.ok(map.enemies.slice(index + 1).every(([a, b]) => Math.hypot(a - x, b - z) >= 10));
      assert.ok(map.gates.every(gate => Math.hypot(gate.x - x, gate.z - z) >= 10));
    });
  }
});

test('expedition spawn camps, guides, monsters and gates are walkable and reachable through real corridors', () => {
  for (const map of Object.values(MAPS).filter(map => map.id !== 'village')) {
    const trees = map.id === 'mountains' ? mapScenery(map).filter((_, i) => i % 3 === 0) : [];
    const canWalk = (x, z) => isMapWalkable(map, x, z) && !trees.some(t => Math.hypot(x - t.x, z - t.z) < 2.5);
    const start = map.spawn.map(value => Math.round(value / 4) * 4);
    const queue = [start], visited = new Set([start.join(',')]);
    for (let i = 0; i < queue.length; i++) {
      const [x, z] = queue[i];
      for (const [dx, dz] of [[4, 0], [-4, 0], [0, 4], [0, -4]]) {
        const next = [x + dx, z + dz], key = next.join(',');
        if (!visited.has(key) && canWalk(...next)) {
          visited.add(key); queue.push(next);
        }
      }
    }
    assert.ok(queue.length > 2000, map.id);
    for (const point of [map.spawn, ...map.enemies, ...map.guides.map(g => [g.x, g.z]), ...map.gates.map(g => [g.x, g.z])]) {
      assert.ok(canWalk(...point), map.id + ' ' + point);
      assert.ok(queue.some(([x, z]) => Math.hypot(x - point[0], z - point[1]) < 6), map.id + ' unreachable ' + point);
    }
    assert.ok(isSafePosition(map, ...map.spawn));
    for (const point of map.enemies) assert.equal(isSafePosition(map, ...point), false);
  }
});

test('village gates stand outside the village at clear outer road ends', () => {
  const trees = createScenery().trees;
  for (const gate of MAPS.village.gates) {
    assert.equal(isSafePosition(MAPS.village, gate.x, gate.z), false);
    assert.ok(Math.hypot(gate.x, gate.z) >= 145);
    assert.ok(isPath(gate.x, gate.z));
    assert.ok(isWalkable(gate.x, gate.z, 3, trees));
  }
});

test('entering a gate automatically travels once, rearming only after leaving the ring', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', { MAPS, nearbyGate });
  const gate = MAPS.village.gates[0], destinations = [];
  const game = { map: MAPS.village, ready: true, api: {}, dodge: {},
    player: { _position: { x: gate.x, z: gate.z }, GetComponent: () => ({
      IsAlive: () => true, _stateMachine: { _currentState: { Name: 'walk' } },
    }) }, switchMap: id => { destinations.push(id); return true; } };
  game.readingService = true;
  assert.equal(Game.prototype.updateGateTravel.call(game), false);
  game.readingService = false;
  assert.equal(Game.prototype.updateGateTravel.call(game), true);
  assert.equal(Game.prototype.updateGateTravel.call(game), false);
  game.player._position.z += 10;
  assert.equal(Game.prototype.updateGateTravel.call(game), false);
  game.player._position.z -= 10;
  assert.equal(Game.prototype.updateGateTravel.call(game), true);
  assert.deepEqual(destinations, ['mountains', 'mountains']);
  for (const map of Object.values(MAPS)) assert.equal(nearbyGate(map, { x: map.spawn[0], z: map.spawn[1] }), null);
});

test('expedition bounds and walls block walking and malformed coordinates', () => {
  for (const map of Object.values(MAPS).filter(map => map.id !== 'village')) {
    assert.equal(isMapWalkable(map, map.limit, 0), false);
    assert.equal(isMapWalkable(map, 0, -map.limit), false);
    assert.equal(isMapWalkable(map, NaN, 0), false);
    assert.equal(isMapWalkable(map, 0, Infinity), false);
    for (const block of map.obstacles) assert.equal(isMapWalkable(map, block.x, block.z), false);
  }
  assert.equal(isMapWalkable(MAPS.dungeon, 0, 48), true);
  assert.equal(isMapWalkable(MAPS.dungeon, 20, 48), false);
});

test('expedition scenery is deterministic, bounded and keeps the central trail clear', () => {
  for (const map of [MAPS.mountains, MAPS.desert]) {
    const props = mapScenery(map);
    assert.deepEqual(props, mapScenery(map));
    assert.ok(props.length > 20 && props.length <= 180);
    assert.ok(props.every(p => Math.abs(p.x) >= 13 && !isSafePosition(map, p.x, p.z)));
  }
});

test('monster replenishment uses each map extent and its actual safe camp', () => {
  for (const map of Object.values(MAPS).filter(map => map.id !== 'village')) {
    const random = seededRandom(951);
    let beyondOriginalExtent = false;
    for (let i = 0; i < 30; i++) {
      const point = findMonsterSpawn({
        canWalk: (x, z) => isMapWalkable(map, x, z), player: { x: map.spawn[0], z: map.spawn[1] },
        occupied: [], random, extent: map.limit - 20, isSafe: (x, z) => isSafePosition(map, x, z),
      });
      assert.ok(point, map.id);
      assert.ok(isMapWalkable(map, point.x, point.z));
      assert.equal(isSafePosition(map, point.x, point.z), false);
      assert.ok(Math.hypot(point.x - map.spawn[0], point.z - map.spawn[1]) >= 45);
      beyondOriginalExtent ||= Math.abs(point.x) > 145 || Math.abs(point.z) > 145;
    }
    if (map.limit > 200) assert.ok(beyondOriginalExtent);
  }
});

test('unloading a map disposes owned GPU resources once and never disposes shared templates', () => {
  const disposed = [];
  const resource = name => ({ dispose: () => disposed.push(name) });
  const sharedGeometry = resource('shared-geometry'), sharedTexture = { ...resource('shared-texture'), isTexture: true };
  const sharedUniformTexture = { ...resource('shared-uniform-texture'), isTexture: true };
  const sharedMaterial = {
    ...resource('shared-material'), map: sharedTexture,
    uniforms: { diffuseTexture: { value: sharedUniformTexture } },
  };
  const geometry = resource('terrain'), texture = { ...resource('sign-texture'), isTexture: true };
  const uniformTexture = { ...resource('particle-uniform-texture'), isTexture: true };
  const material = {
    ...resource('sign'), map: texture, normalMap: texture, shared: sharedTexture,
    uniforms: { diffuseTexture: { value: uniformTexture }, sharedUniform: { value: sharedUniformTexture } },
  };
  const shared = sharedResources({ rock: { traverse: callback => callback({ geometry: sharedGeometry, material: sharedMaterial }) } });
  let detached = false;
  const root = {
    children: [{}, {}], parent: { remove: () => { detached = true; } },
    traverse: callback => [
      { geometry, material }, { geometry, material }, { geometry: sharedGeometry, material: sharedMaterial },
    ].forEach(callback),
    remove(child) { this.children.splice(this.children.indexOf(child), 1); },
  };
  disposeMap(root, shared);
  assert.deepEqual(disposed.sort(), ['particle-uniform-texture', 'sign', 'sign-texture', 'terrain']);
  assert.equal(root.children.length, 0);
  assert.equal(detached, true);
});

test('instanced scenery owns disposable buffer geometry for both GLB and legacy procedural meshes', () => {
  const source = readFileSync(new URL('../v2/assets.js', import.meta.url), 'utf8')
    .match(/export function instances[\s\S]*/)[0].replace('export ', '');
  const buffer = () => ({ attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
  const instances = runInNewContext(source + '\ninstances;', { THREE: {
    Object3D: class {
      constructor() {
        this.position = { set() {} }; this.rotation = { set() {} }; this.scale = { setScalar() {} }; this.matrix = {};
      }
      updateMatrix() {}
    },
    Matrix4: class { multiplyMatrices() {} },
    BufferGeometry: class { fromGeometry() { return buffer(); } },
    InstancedMesh: class {
      constructor(geometry) { this.geometry = geometry; this.instanceMatrix = {}; }
      setMatrixAt() {}
    },
  } });
  for (const isBufferGeometry of [true, false]) {
    const geometry = { isBufferGeometry, clone: buffer };
    const mesh = { isMesh: true, geometry, material: {} };
    const model = { updateMatrixWorld() {}, traverse: callback => callback(mesh) };
    let added;
    instances({ add: value => { added = value; } }, model, [{ x: 1, z: 2, scale: 1 }]);
    assert.notEqual(added.geometry, geometry);
    assert.equal(added.geometry.attributes.mapInstanceMatrix, added.instanceMatrix);
    assert.equal(added.instanceMatrix.needsUpdate, true);
  }
});

test('map transitions reject invalid, premature or busy travel without altering the quest', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', { MAPS });
  const quest = { filter: 'existing-task' };
  const game = { ready: false, api: { quest }, travelStatus() {}, mapActorsReady: () => true };
  assert.equal(Game.prototype.switchMap.call(game, 'unknown'), false);
  assert.equal(Game.prototype.switchMap.call(game, 'mountains'), false);
  game.ready = true;
  game.api.grading = Promise.resolve();
  assert.equal(Game.prototype.switchMap.call(game, 'mountains'), false);
  game.api.grading = null; game.mapActorsReady = () => false;
  assert.equal(Game.prototype.switchMap.call(game, 'mountains'), false);
  assert.equal(game.api.quest, quest);
});

test('T is a separate gate action and G is the guide interaction', () => {
  const html = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /travel-button|click Travel|Walk into gates to travel/);
  assert.doesNotMatch(main, /travel-button/);
  assert.match(main, /event.code === "KeyT"[\s\S]*?this._params.game.useGate\(\)/);
  assert.match(main, /event.code === "KeyG"[\s\S]*?this._params.game.talkToGuide\(\)/);
  for (const name of ['assets', 'world', 'spawning', 'maps', 'map-lifecycle']) {
    assert.match(main, new RegExp(`from "\\./${name}\\.js\\?v=[^"]+"`));
  }
});

test('travel shortcut supports key-only events and reports account-sync blocking through the gate action', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const Input = runInNewContext(
    main.match(/class BasicCharacterControllerInput[\s\S]*?(?=\nclass SpatialGridController)/)[0] +
      '\nBasicCharacterControllerInput;',
    { player_input: { BasicCharacterControllerInput: class { _onKeyDown() {} } } });
  let travels = 0, prevented = 0;
  const input = new Input();
  input._params = { game: { progressChanging: true, useGate() { travels++; } } };
  const event = { target: { closest() { return false; } }, preventDefault() { prevented++; } };
  input._onKeyDown({ ...event, code: 'KeyT' });
  input._onKeyDown({ ...event, key: 't' });
  input._onKeyDown({ ...event, key: 'T' });
  input._onKeyDown({ ...event, keyCode: 84 });
  input._onKeyDown({ ...event, target: {}, key: 't' });
  input._onKeyDown({ ...event, code: 'KeyT', repeat: true });
  assert.equal(travels, 5);
  assert.equal(prevented, 5);
});

test('travel failures explain the reason in the existing status area', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', { MAPS });
  let message = '';
  const game = { ready: false, travelStatus(value) { message = value; }, api: {}, mapActorsReady: () => true };
  assert.equal(Game.prototype.switchMap.call(game, 'mountains'), false);
  assert.match(message, /still loading/);
  game.ready = true;
  game.progressChanging = true;
  assert.equal(Game.prototype.switchMap.call(game, 'mountains'), false);
  assert.match(message, /before travelling/);
  game.progressChanging = false;
  game.player = { GetComponent() { return { IsAlive: () => false }; } };
  assert.equal(Game.prototype.switchMap.call(game, 'mountains'), false);
  assert.match(message, /Return to village/);
  assert.doesNotMatch(html, /id="travel-status"/);
  assert.match(html, /id="status" role="status"/);
  Game.prototype.travelStatus.call({ status(value) { message = value; } }, 'Gate is loading.');
  assert.equal(message, 'Gate is loading.');
});

test('expired level-up particle systems immediately dispose GPU resources and entity map entries', () => {
  const disposed = [];
  let detached = false;
  const makeEffect = (name, active) => ({
    Name: name,
    _active: active,
    SetActive(value) { this._active = value; },
    GetComponent(kind) {
      if (kind !== 'LevelUpComponent') return null;
      return {
        _particles: {
          _points: { parent: { remove() { detached = true; } } },
          _geometry: { dispose: () => disposed.push(`${name}-geometry`) },
          _material: {
            dispose: () => disposed.push(`${name}-material`),
            uniforms: { diffuseTexture: { value: { isTexture: true, dispose: () => disposed.push(`${name}-texture`) } } },
          },
        },
      };
    },
  });
  const manager = {
    _entitiesMap: {
      expired: makeEffect('expired', false),
      active: makeEffect('active', true),
      player: { Name: 'player', _active: true, GetComponent: () => null },
    },
  };
  assert.equal(cleanupExpiredEffects(manager), 1);
  assert.equal(detached, true);
  assert.deepEqual(disposed.sort(), ['expired-geometry', 'expired-material', 'expired-texture']);
  assert.equal('expired' in manager._entitiesMap, false);
  assert.equal('active' in manager._entitiesMap, true);
  assert.equal(cleanupExpiredEffects(manager, true), 1);
  assert.equal('active' in manager._entitiesMap, false);
  assert.equal('player' in manager._entitiesMap, true);
});

test('minimap module renders village and expedition layouts, gates, visible guides and player position', () => {
  for (const map of Object.values(MAPS)) {
    const rects = [], arcs = [];
    const ctx = {
      fillStyle: '', strokeStyle: '', lineWidth: 0,
      fillRect: (...args) => rects.push(args),
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, ellipse() {},
      arc: (...args) => arcs.push(args),
    };
    const markers = [
      { visible: true, userData: { guide: { _position: { x: 10, z: -10 } } } },
      { visible: false, userData: { guide: { _position: { x: 20, z: -20 } } } },
    ];
    drawMinimap(ctx, map, markers, { x: 0, z: 20 });
    assert.ok(rects.length >= 2, map.id);
    assert.equal(arcs.length, map.gates.length + 2, map.id);
    drawMinimap(ctx, map, markers, { x: 0, z: 20 }, { mapId: map.id, x: 10, z: 10, radius: 28 });
    assert.equal(arcs.length, (map.gates.length + 2) * 2 + 1, map.id);
  }
});

test('region environmental modifiers and AZ outage world events grant buffs and oasis healing', () => {
  assert.equal(environmentModifier('mountains', { x: 0, z: -50 }).id, 'tailwind');
  assert.equal(environmentModifier('desert', { x: 45, z: -35 }).id, 'oasis');
  assert.equal(environmentModifier('dungeon', { x: 0, z: 0 }).id, 'overclock');
  assert.equal(environmentModifier('village', { x: 0, z: 0 }).id, null);

  const events = new WorldEvents({ random: () => 0 });
  const step1 = events.update(OUTAGE_COOLDOWN, 'desert', { x: 45, z: -35 });
  assert.ok(step1.started);
  assert.equal(step1.started.mapId, 'desert');
  assert.equal(step1.heal, 48);
  assert.equal(events.recordKill({ x: step1.started.x, z: step1.started.z }).resolved, false);
  const resolved = events.recordKill({ x: step1.started.x + 2, z: step1.started.z });
  assert.equal(resolved.resolved, true);
  assert.equal(events.outage, null);
  assert.ok(events.surge > 0);
  assert.ok(events.speedMultiplier > 1);
  assert.ok(events.attackSpeedMultiplier > 1);
});
