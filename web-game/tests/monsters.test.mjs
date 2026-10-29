import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MONSTERS, monsterFor, monsterAnimations, clearShot, SpikeShots } from '../v2/monsters.js';

function modelClass(context) {
  const source = readFileSync(new URL('../v2/monster-models.js', import.meta.url), 'utf8');
  return runInNewContext(source.slice(source.indexOf('export class')).replace('export class', 'class') +
    '\nMonsterModels;', { monsterAnimations, ...context });
}

test('each map has a distinct roster without increasing its enemy count', () => {
  for (const [map, kind] of [['mountains', 'Yeti'], ['desert', 'Cactus'], ['dungeon', 'Bat']]) {
    const roster = Array.from({ length: 8 }, (_, index) => monsterFor(map, index));
    assert.equal(roster.length, 8);
    assert.ok(roster.filter(value => value === kind).length >= 5);
    assert.ok(roster.every(value => MONSTERS[value]));
  }
  assert.deepEqual(Array.from({ length: 4 }, (_, i) => monsterFor('village', i)),
    ['Ghost', 'GreenDemon', 'Cyclops', 'Skull']);
});

test('yetis are heavy and slow, bats are fast and fragile, cacti are stationary ranged enemies', () => {
  assert.ok(MONSTERS.Yeti.health > MONSTERS.Ghost.health);
  assert.ok(MONSTERS.Yeti.damage > MONSTERS.Ghost.damage);
  assert.ok(MONSTERS.Yeti.windup > MONSTERS.Ghost.windup);
  assert.ok(MONSTERS.Yeti.acceleration < MONSTERS.Ghost.acceleration);
  assert.ok(MONSTERS.Bat.health < MONSTERS.Ghost.health);
  assert.ok(MONSTERS.Bat.acceleration > MONSTERS.Ghost.acceleration);
  assert.equal(MONSTERS.Cactus.acceleration, 0);
  assert.equal(MONSTERS.Cactus.ranged, true);
  assert.ok(MONSTERS.Cactus.range > MONSTERS.Ghost.range * 4);
});

test('animation selection supports flying models and independent role fallbacks', () => {
  const clips = ['Idle', 'Fly', 'Attack', 'Death'].map(name => ({ name }));
  const roles = monsterAnimations(clips);
  assert.equal(roles.walk.name, 'Fly');
  assert.equal(roles.attack.name, 'Attack');
  assert.equal(roles.death.name, 'Death');
  const idle = { name: 'Idle' };
  assert.equal(monsterAnimations([idle]).attack, idle);
  assert.throws(() => monsterAnimations([]), /no animation/);
});

test('cacti cannot aim through terrain, including narrow walls', () => {
  assert.equal(clearShot({ x: 0, z: 0 }, { x: 20, z: 0 }, x => x < 9 || x > 10), false);
  assert.equal(clearShot({ x: 0, z: 0 }, { x: 20, z: 0 }, () => true), true);
});

test('melee enemy attacks require line of sight to wind up and land, and track enemy position', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  let clear = false;
  const hits = [];
  const Attack = runInNewContext(main.match(/class EnemyAttackController[\s\S]*?(?=\nclass HealthComponent)/)[0] +
    '\nEnemyAttackController;', {
    entity: { Component: class {} },
    isSafePosition: () => false,
    clearShot: () => clear,
  });
  const player = {
    _position: { x: 4, z: 0 },
    GetComponent: () => ({ IsAlive: () => true }),
    Broadcast: message => hits.push(message),
  };
  const attack = new Attack({
    map: 'dungeon', traveling: false, player,
    world: { canWalk: () => true },
    sound: { play() {} },
  });
  const parentPos = { x: 0, z: 0, distanceTo: other => Math.hypot(parentPos.x - other.x, parentPos.z - other.z) };
  attack._parent = { _position: parentPos };
  attack.ring = {
    visible: false,
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    scale: { setScalar() {} },
    material: { color: { setHex() {} } },
  };
  attack.aimLine = { visible: false };
  const components = {
    HealthComponent: { _params: { strength: 18 }, IsAlive: () => true },
    NPCController: {
      kind: 'Ghost', profile: { range: 5.5, reach: 6, windup: 0.5, cooldown: 1.5, ranged: false },
      _stateMachine: { _currentState: { Name: 'idle' }, SetState() {} },
      _velocity: { set() {} },
    },
  };
  attack.GetComponent = name => components[name];
  attack.Update(0.1);
  assert.equal(attack.remaining, null, 'melee windup must not start through a wall');
  clear = true;
  attack.Update(0.1);
  assert.equal(attack.remaining, 0.5);
  assert.equal(attack.ring.visible, true);
  parentPos.x = 1.5;
  clear = false;
  attack.Update(0.5);
  assert.equal(attack.ring.position.x, 1.5, 'warning ring follows pushed enemy position');
  assert.equal(hits.length, 0, 'melee hit must not land through a wall');
  attack.cooldown = 0;
  clear = true;
  attack.Update(0.1);
  attack.Update(0.5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].value, 18);
});

test('expedition super monsters use region-specific volley, glacial shockwave and shadow-step mechanics', () => {
  const { spikes, options } = shots();
  assert.equal(spikes.fireFan({ x: 0, z: 0 }, options.player, 22, { id: 'overlord' }), true);
  assert.equal(spikes.active.length, 3);

  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const effects = [], hits = [];
  let fanFired = 0;
  const Attack = runInNewContext(main.match(/class EnemyAttackController[\s\S]*?(?=\nclass HealthComponent)/)[0] +
    '\nEnemyAttackController;', {
    entity: { Component: class {} },
    isSafePosition: () => false,
    clearShot: () => true,
    findMovementBlockers: () => [],
  });
  const player = {
    _position: { x: 0, z: 16 },
    GetComponent: () => ({ IsAlive: () => true }),
    Broadcast: msg => hits.push(msg),
  };
  const game = {
    map: { id: 'dungeon' }, traveling: false, player,
    world: { canWalk: () => true },
    sound: { play() {} },
    magicEffects: { spawn: (...args) => effects.push(args) },
    spikes: {
      fire: () => false,
      fireFan: () => { fanFired++; return true; },
    },
  };
  const attack = new Attack(game, true);
  const parentPos = {
    x: 0, z: 0,
    set(x, y, z) { this.x = x; this.z = z; },
    distanceTo: other => Math.hypot(parentPos.x - other.x, parentPos.z - other.z),
  };
  attack._parent = { _position: parentPos, SetPosition(pos) { parentPos.x = pos.x; parentPos.z = pos.z; } };
  attack.ring = {
    visible: false,
    position: { set() {} },
    scale: { setScalar() {} },
    material: { color: { setHex() {} } },
  };
  attack.aimLine = {
    visible: false,
    geometry: { attributes: { position: { setXYZ() {}, needsUpdate: false } }, computeBoundingSphere() {} },
  };
  const controller = {
    elite: true, kind: 'Bat',
    profile: { label: 'Vault Nightlord', range: 8, reach: 7.5, windup: 1, cooldown: 1.2, ranged: false, color: 0xc98bff },
    _stateMachine: { _currentState: { Name: 'idle' }, SetState() {} },
    _velocity: { set() {} },
    _position: parentPos,
    _target: { visible: false, position: { set() {} } },
  };
  const health = { _health: 270, _maxHealth: 270, _params: { strength: 18 }, IsAlive: () => true };
  attack.GetComponent = name => name === 'NPCController' ? controller : health;

  attack.Update(0.1);
  assert.ok(Math.hypot(parentPos.x - player._position.x, parentPos.z - player._position.z) <= 4.6,
    'Vault Nightlord shadow-steps close to the player before winding up');
  assert.equal(attack.remaining, 1);

  game.map.id = 'mountains';
  controller.kind = 'Yeti';
  controller.profile = { label: 'Frostpeak Titan', range: 9, reach: 9, windup: 1, cooldown: 2, ranged: false, color: 0x7ddaff };
  attack.Update(1);
  assert.equal(hits.at(-1)?.chill, true);
  assert.ok(effects.some(([kind]) => kind === 'ward'));

  game.map.id = 'desert';
  controller.kind = 'Cactus';
  controller.profile = { label: 'Sunspire Overlord', range: 38, reach: 38, windup: 1, cooldown: 2, ranged: true, color: 0xff9b54 };
  attack.cooldown = 0;
  attack.Update(0.1);
  attack.Update(1);
  assert.equal(fanFired, 1);
});

function shots() {
  const removed = [], spawned = [], hits = [];
  const spikes = new SpikeShots({ spawn: shot => spawned.push(shot), remove: shot => removed.push(shot) });
  const options = { player: { x: 15, z: 0 }, canWalk: () => true,
    isSafe: () => false, hit: shot => hits.push(shot) };
  return { spikes, options, removed, spawned, hits };
}

test('spikes hit once without tunnelling and retain their actual attacker and damage', () => {
  const { spikes, options, hits, removed } = shots();
  const attacker = { id: 'cactus' };
  assert.equal(spikes.fire({ x: 0, z: 0 }, options.player, 12, attacker), true);
  spikes.update(1, options);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].damage, 12);
  assert.equal(hits[0].attacker, attacker);
  assert.equal(removed.length, 1);
  assert.equal(spikes.active.length, 0);
  spikes.update(1, options);
  assert.equal(hits.length, 1);
});

test('aim is locked before firing so moving sideways avoids a spike', () => {
  const { spikes, options, hits } = shots();
  spikes.fire({ x: 0, z: 0 }, options.player, 12, {});
  options.player = { x: 15, z: 5 };
  spikes.update(2, options);
  assert.equal(hits.length, 0);
  assert.equal(spikes.active.length, 0);
});

test('terrain and safe camps stop spikes before player damage', () => {
  for (const property of ['canWalk', 'isSafe']) {
    const { spikes, options, hits, removed } = shots();
    spikes.fire({ x: 0, z: 0 }, options.player, 12, {});
    options[property] = x => property === 'canWalk' ? x < 9 : x > 9;
    spikes.update(1, options);
    assert.equal(hits.length, 0);
    assert.equal(removed.length, 1);
    assert.equal(spikes.active.length, 0);
  }
});

test('spikes have a fixed cap and travel cleanup removes every visible projectile', () => {
  const { spikes, options, spawned, removed } = shots();
  assert.equal(spikes.fire(options.player, options.player, 12, {}), false);
  for (let i = 0; i < 30; i++) spikes.fire({ x: 0, z: 0 }, options.player, 12, {});
  assert.equal(spikes.active.length, 24);
  assert.equal(spawned.length, 24);
  spikes.clear();
  assert.equal(removed.length, 24);
  assert.equal(spikes.active.length, 0);
});

test('model preparation deduplicates downloads and validates animations before exposing a template', async () => {
  let downloads = 0, textures = 0;
  const template = { animations: [{ name: 'Idle' }], traverse() {} };
  const Models = modelClass({
    FBXLoader: class {
      constructor(manager) { assert.ok(manager); }
      load(url, resolve) { downloads++; resolve(template); }
    },
    THREE: {
      LoadingManager: class {},
      TextureLoader: class {
        constructor(manager) { assert.ok(manager); }
        load(url, resolve) { textures++; resolve({}); }
      },
    },
  });
  const models = new Models();
  assert.equal(models.ready(['Yeti']), false);
  await Promise.all([models.prepare(['Yeti', 'Yeti']), models.prepare(['Yeti'])]);
  assert.equal(downloads, 1);
  assert.equal(textures, 1);
  assert.equal(models.ready(['Yeti']), true);
});

test('a failed on-demand model download can be retried without exposing an incomplete template', async () => {
  let attempts = 0;
  const Models = modelClass({
    FBXLoader: class {
      load(url, resolve, progress, reject) {
        if (++attempts === 1) reject(new Error('Offline'));
        else resolve({ animations: [{ name: 'Idle' }], traverse() {} });
      }
    },
    THREE: {
      LoadingManager: class {},
      TextureLoader: class { load(url, resolve) { resolve({}); } },
    },
  });
  const models = new Models();
  await assert.rejects(models.load('Yeti'), /Offline/);
  assert.equal(models.ready(['Yeti']), false);
  assert.equal(models.pending.has('Yeti'), false);
  await models.load('Yeti');
  assert.equal(models.ready(['Yeti']), true);
  assert.equal(attempts, 2);
});

test('model swaps release unique materials and skeleton textures but preserve cached model resources', () => {
  let releasedMaterials = 0, releasedBones = 0, detached = 0;
  const shared = {
    clone() { return { dispose() { releasedMaterials++; } }; },
    dispose() { throw new Error('Shared material must remain cached'); },
  };
  const skeleton = { boneTexture: { dispose() { releasedBones++; } } };
  const geometry = { dispose() { throw new Error('Shared geometry must remain cached'); } };
  const children = [{ material: shared, skeleton, geometry }, { material: shared, skeleton, geometry }];
  const clone = { traverse(fn) { children.forEach(fn); }, parent: { remove() { detached++; } } };
  const Models = modelClass({
    THREE: { LoadingManager: class {} }, SkeletonUtils: { clone: () => clone },
  });
  const models = new Models();
  models.templates.set('Yeti', { animations: [{ name: 'Idle' }] });
  const { model } = models.create('Yeti');
  assert.notEqual(children[0].material, shared);
  assert.equal(children[0].material, children[1].material);
  models.release(model);
  assert.equal(releasedMaterials, 1);
  assert.equal(releasedBones, 1);
  assert.equal(detached, 1);
  assert.equal(models.ready(['Yeti']), true);
});
