import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { GameApi, QUEST_KEY, MARKS_RESET_KEY } from '../v2/api.js';
import { clearShot } from '../v2/monsters.js';
import { createRenderer, WebGLUnavailableError } from '../v2/renderer.js';
import { findMeleeTargets, findMovementBlockers, MELEE_RANGE } from '../v2/combat.js';
import { GuidePatrol, GUIDE_ROAM_RADIUS, GUIDE_WALK_SPEED } from '../v2/guides.js';
import { findMonsterSpawn, MonsterRespawns } from '../v2/spawning.js';
import { spatial_hash_grid } from '../src/spatial-hash-grid.js';
import {
  BUILDINGS, GUIDES, ENEMY_SPAWNS, LAKE, PLAYER_SPAWN, WORLD_LIMIT,
  seededRandom, createScenery, isPath, isWalkable, regionAt,
} from '../v2/layout.js';

function storage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  };
}

function api(fetcher, initial = {}) {
  return new GameApi({
    baseUrl: 'https://example.com/Prod/',
    storage: storage(initial),
    keys: storage({ api_key: 'example-key', filter: 'classic-quest' }),
    fetcher,
  });
}

const task = { name: 'Tests.Vpc', filter: 'test=Vpc', instruction: 'Build a VPC.' };
const response = body => ({ ok: true, json: async () => body });

test('talking without a key opens a clear reminder instead of contacting the NPC or reopening a saved task', () => {
  const keys = storage();
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', { localStorage: keys });
  let reminders = 0, requests = 0, instructions = 0, status;
  const guide = { Broadcast: () => { requests++; } };
  const game = {
    api: { quest: null }, nearbyGuide: () => guide, renderer: { domElement: { focus() {} } },
    status: message => { status = message; }, showKeyDialog: message => {
      reminders++;
      assert.match(message, /Set your API key first/);
    }, showInstructions: () => { instructions++; },
  };
  for (const key of [null, '', '   ']) {
    if (key === null) keys.removeItem('api_key'); else keys.setItem('api_key', key);
    Game.prototype.talkToGuide.call(game);
  }
  assert.equal(reminders, 3);
  assert.equal(requests, 0);
  game.api.quest = task;
  game.nearbyGuide = () => null;
  Game.prototype.talkToGuide.call(game);
  assert.equal(reminders, 4);
  assert.equal(instructions, 0);
  game.api.quest = null;
  Game.prototype.talkToGuide.call(game);
  assert.match(status, /Move closer/);
  assert.equal(reminders, 4);
  keys.setItem('api_key', 'example-key');
  game.nearbyGuide = () => guide;
  Game.prototype.talkToGuide.call(game);
  assert.equal(requests, 1);
  game.api.quest = task;
  Game.prototype.talkToGuide.call(game);
  assert.equal(instructions, 1);
});

test('the key reminder focuses the key input, clears held movement and dodge, and safely reuses an open dialog', () => {
  const keys = storage();
  let opened = 0, focused = 0;
  const dialog = { open: false, showModal() { this.open = true; opened++; } };
  const input = { value: 'stale', focus: () => { focused++; } }, help = {};
  const document = { getElementById: id => ({ 'key-dialog': dialog, 'api-key': input, 'key-help': help })[id] };
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', { localStorage: keys, document });
  const held = { forward: true, backward: false, space: true };
  const game = { dodge: { remaining: 0.2 }, guard: { held: true, release() { this.held = false; } },
    player: { GetComponent: () => ({ _keys: held }) } };
  Game.prototype.showKeyDialog.call(game, 'Set your API key first.');
  assert.equal(help.textContent, 'Set your API key first.');
  assert.equal(input.value, '');
  assert.equal(game.dodge.remaining, 0);
  assert.equal(game.guard.held, false);
  assert.ok(Object.values(held).every(value => value === false));
  assert.equal(opened, 1);
  keys.setItem('api_key', 'example-key');
  Game.prototype.showKeyDialog.call(game);
  assert.match(help.textContent, /Classic and V2 share/);
  assert.equal(input.value, 'example-key');
  assert.equal(opened, 1);
  assert.equal(focused, 2);
});

test('V2 displays both supplied logos from the shared branding directory with accessible image labels', () => {
  const html = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  for (const name of ['hkiit-logo.png', 'it114115-logo.png']) {
    assert.ok(existsSync(new URL('../resources/branding/' + name, import.meta.url)));
    assert.equal(existsSync(new URL('../' + name, import.meta.url)), false);
    assert.match(html, new RegExp(`<img src="\\./resources/branding/${name.replace('.', '\\.')}" alt="[^"]+" width="\\d+" height="\\d+">`));
  }
});

test('the game title uses the supplied AWS logo while keeping Warrior as text', () => {
  const html = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  assert.ok(existsSync(new URL('../resources/branding/aws-logo.webp', import.meta.url)));
  assert.match(html, /<h1><img class="aws-title-logo" src="\.\/resources\/branding\/aws-logo\.webp" alt="AWS" width="400" height="360"> Warrior /);
  assert.match(html, /<title>AWS Warrior - V2<\/title>/);
  assert.match(html, /Warrior <span>V2<\/span>/);
  assert.doesNotMatch(html, /\bbeta\b/i);
});

test('V2 versions the entry point and new combat dependency to avoid stale cached exports', () => {
  const html = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  assert.match(html, /src="\.\/v2\/main\.js\?v=[^"]+" type="module"/);
  assert.match(main, /import \{ findMeleeTargets, findMovementBlockers \} from "\.\/combat\.js\?v=[^"]+";/);
});

test('Adventure rewards panel is removed without removing weapons or village progress', () => {
  const html = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /Adventure rewards|adventure-journal|weapon-finish/);
  assert.doesNotMatch(main, /getElementById\("weapon-finish"\)/);
  assert.match(html, /id="village-progress"/);
  assert.match(html, /id="weapon-bar"/);
  assert.match(main, /Sword: "1", Axe: "2", Unarmed: "0"/);
});

test('V2 ignores mouse picking and only a non-repeated E outside a dialog requests a task', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const source = main.match(/class BasicCharacterControllerInput[\s\S]*?(?=\nclass SpatialGridController)/)[0];
  const movement = [];
  let interactions = 0, prevented = 0;
  const Input = runInNewContext(source + '\nBasicCharacterControllerInput;', {
    player_input: {
      BasicCharacterControllerInput: class {
        _onMouseUp() { assert.fail('V2 must not invoke the Classic mouse picker'); }
        _onKeyDown(event) { movement.push(event.code); }
      },
    },
  });
  const input = new Input();
  input._params = { game: { talkToGuide: () => { interactions++; } } };
  for (const button of [0, 1, 2]) {
    input._onMouseUp({ button, target: { closest: () => null } });
  }
  assert.equal(interactions, 0);
  const press = (code, { repeat = false, closest = () => null } = {}) => input._onKeyDown({
    code, repeat, target: { closest }, preventDefault: () => { prevented++; },
  });
  press('KeyE');
  assert.equal(interactions, 1);
  assert.equal(prevented, 1);
  press('KeyE', { repeat: true });
  for (const tag of ['input', 'select', 'dialog']) {
    press('KeyE', { closest: selector => selector.includes(tag) ? {} : null });
  }
  assert.equal(interactions, 1);
  press('KeyE', { closest: selector => selector.includes('button') ? {} : null });
  assert.equal(interactions, 2);
  press('KeyW');
  press('Space');
  assert.ok(movement.includes('KeyW'));
  assert.ok(movement.includes('Space'));
  assert.doesNotMatch(main, /PickableComponent|pickerPanel|intersectObjects/);
});

test('guides wander within their home area without crossing blocked terrain', () => {
  const canStep = (x, z) => x >= 0 && z >= 0;
  const patrol = new GuidePatrol({ home: { x: 2, z: 2 }, canStep, random: seededRandom(42) });
  let moved = false;
  for (let i = 0; i < 3000; i++) {
    const before = patrol.position;
    patrol.update(0.1);
    assert.ok(canStep(patrol.position.x, patrol.position.z));
    assert.ok(Math.hypot(patrol.position.x - 2, patrol.position.z - 2) <= GUIDE_ROAM_RADIUS + 0.001);
    assert.ok(Math.hypot(patrol.position.x - before.x, patrol.position.z - before.z) <= GUIDE_WALK_SPEED * 0.1 + 0.001);
    moved ||= patrol.walking;
  }
  assert.ok(moved);
});

test('guides pause during interaction and resume the same route afterward', () => {
  const patrol = new GuidePatrol({ home: { x: 0, z: 0 }, canStep: () => true, random: () => 0 });
  patrol.wait = 0;
  patrol.update(0.1);
  const before = { ...patrol.position };
  const target = patrol.target;
  for (let i = 0; i < 50; i++) patrol.update(0.1, true);
  assert.deepEqual(patrol.position, before);
  assert.equal(patrol.walking, false);
  assert.equal(patrol.target, target);
  patrol.update(0.1);
  assert.notDeepEqual(patrol.position, before);
  assert.equal(patrol.walking, true);
});

test('guides stop at newly blocked steps and never jump after long frames', () => {
  let blocked = false;
  const patrol = new GuidePatrol({ home: { x: 0, z: 0 }, canStep: () => !blocked, random: () => 0 });
  patrol.wait = 0;
  patrol.update(10);
  assert.ok(Math.hypot(patrol.position.x, patrol.position.z) <= GUIDE_WALK_SPEED * 0.1 + 0.001);
  blocked = true;
  const before = { ...patrol.position };
  patrol.update(0.1);
  assert.deepEqual(patrol.position, before);
  assert.equal(patrol.walking, false);
  assert.equal(patrol.target, null);
});

test('replacement monsters spawn randomly on walkable land away from the village and actors', () => {
  const player = { x: 90, z: -85 }, occupied = [{ x: -110, z: -80 }];
  const scenery = createScenery();
  const canWalk = (x, z) => isWalkable(x, z, 1.5, scenery.trees);
  const random = seededRandom(123);
  const positions = new Set();
  for (let i = 0; i < 100; i++) {
    const point = findMonsterSpawn({ canWalk, player, occupied, random });
    assert.ok(point);
    assert.ok(canWalk(point.x, point.z));
    assert.ok(Math.abs(point.x) >= 62 || Math.abs(point.z) >= 50);
    assert.ok(Math.hypot(point.x - player.x, point.z - player.z) >= 45);
    assert.ok(Math.hypot(point.x - occupied[0].x, point.z - occupied[0].z) >= 10);
    positions.add(JSON.stringify(point));
  }
  assert.equal(positions.size, 100);
});

test('unsafe spawn attempts are bounded instead of creating monsters in blocked terrain', () => {
  let attempts = 0;
  assert.equal(findMonsterSpawn({
    canWalk: () => { attempts++; return false; },
    player: { x: 0, z: 0 }, occupied: [], random: () => 1,
  }), null);
  assert.equal(attempts, 100);
});

test('monster replenishment waits, deduplicates deaths and retries when no safe position exists', () => {
  const queue = new MonsterRespawns(() => 0);
  const monster = {};
  queue.schedule(monster);
  queue.schedule(monster);
  assert.equal(queue.pending.size, 1);
  queue.update(7, () => assert.fail('Respawned before its delay'));
  let attempts = 0;
  queue.update(1, () => { attempts++; return false; });
  assert.equal(attempts, 1);
  assert.equal(queue.pending.size, 1);
  queue.update(0.5, () => assert.fail('Retried without waiting'));
  queue.update(0.5, actor => { assert.equal(actor, monster); return true; });
  assert.equal(queue.pending.size, 0);
  queue.schedule(monster);
  assert.equal(queue.pending.size, 1);
});

test('melee reaches monsters across V2 grid boundaries at collision distance', () => {
  for (const [x, z] of [[0, 85.5], [0, 87], [-85.5, 0], [87, -85.5]]) {
    for (const [dx, dz] of [[0, -4.2], [4.2, 0], [0, 4.2], [-4.2, 0]]) {
      const grid = new spatial_hash_grid.SpatialHashGrid([[-200, -200], [200, 200]], [80, 80]);
      const attacker = { _position: { x, z } };
      const target = { _position: { x: x + dx, z: z + dz } };
      for (const actor of [attacker, target]) {
        grid.NewClient([actor._position.x, actor._position.z], [1, 1]).entity = actor;
      }
      assert.deepEqual(findMeleeTargets(grid, attacker).map(client => client.entity), [target]);
    }
  }
});

test('melee excludes its attacker and actors beyond actual weapon reach', () => {
  const grid = new spatial_hash_grid.SpatialHashGrid([[-200, -200], [200, 200]], [80, 80]);
  const attacker = { _position: { x: 0, z: 0 } };
  const target = { _position: { x: MELEE_RANGE, z: 0 } };
  const far = { _position: { x: MELEE_RANGE + 0.1, z: 0 } };
  const diagonal = { _position: { x: MELEE_RANGE, z: MELEE_RANGE } };
  for (const actor of [attacker, target, far, diagonal]) {
    grid.NewClient([actor._position.x, actor._position.z], [1, 1]).entity = actor;
  }
  assert.deepEqual(findMeleeTargets(grid, attacker).map(client => client.entity), [target]);
});

function context(extensions = {}) {
  return { getExtension: name => extensions[name] || null };
}

test('movement lets overlapping actors separate without allowing deeper penetration or missed grid-boundary collisions', () => {
  for (const [x, z] of [[0, 85.5], [0, 87], [-85.5, 0], [87, -85.5]]) {
    const grid = new spatial_hash_grid.SpatialHashGrid([[-200, -200], [200, 200]], [80, 80]);
    const actor = { _position: { x, z } };
    const other = { _position: { x, z: z - 3.5 }, GetComponent: () => ({ IsAlive: () => true }) };
    grid.NewClient([x, z], [1, 1]).entity = actor;
    grid.NewClient([x, z - 3.5], [1, 1]).entity = other;
    assert.deepEqual(findMovementBlockers(grid, actor, { x, z: z + 0.1 }), []);
    assert.deepEqual(findMovementBlockers(grid, actor, { x, z: z - 0.1 }), [other]);
    assert.deepEqual(findMovementBlockers(grid, actor, { x: x + 0.1, z }), []);
    assert.deepEqual(findMovementBlockers(grid, actor, { x, z: z + 1 }), []);
    assert.deepEqual(findMovementBlockers(grid, actor, { x, z: z + 0.4 }, { x, z: z + 1 }), [other]);
    other.GetComponent = () => ({ IsAlive: () => false });
    assert.deepEqual(findMovementBlockers(grid, actor, { x, z: z - 0.1 }), []);
    other.GetComponent = () => undefined;
    assert.deepEqual(findMovementBlockers(grid, actor, { x, z: z - 0.1 }), [other]);
  }
});

test('movement blocks entry into a new actor, allows escape from exact overlap and respects a second blocker', () => {
  const grid = new spatial_hash_grid.SpatialHashGrid([[-200, -200], [200, 200]], [80, 80]);
  const actor = { _position: { x: 0, z: 0 } };
  const other = { _position: { x: 0, z: -4.1 }, GetComponent: () => undefined };
  const client = grid.NewClient([0, -4.1], [1, 1]);
  client.entity = other;
  assert.deepEqual(findMovementBlockers(grid, actor, { x: 0, z: -0.2 }), [other]);
  other._position.z = 0;
  client.position = [0, 0]; grid.UpdateClient(client);
  assert.deepEqual(findMovementBlockers(grid, actor, { x: 0, z: 0.1 }), []);
  const second = { _position: { x: 0, z: 4.1 }, GetComponent: () => undefined };
  grid.NewClient([0, 4.1], [1, 1]).entity = second;
  assert.deepEqual(findMovementBlockers(grid, actor, { x: 0, z: 0.2 }), [second]);
});

test('V2 player and NPC movement use overlap escape while retaining terrain collisions', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  for (const [name, next, namespace] of [
    ['BasicCharacterController', 'BasicCharacterControllerInput', 'player_entity'],
    ['NPCController', 'EnemyAttackController', 'npc_entity'],
  ]) {
    const source = main.match(new RegExp(`class ${name} extends[\\s\\S]*?(?=\\nclass ${next})`))[0];
    const Controller = runInNewContext(source + `\n${name};`, {
      [namespace]: { [name]: class { _FindIntersections() { assert.fail('Inherited collision locks overlaps'); } } },
      findMovementBlockers, clearShot,
    });
    const controller = new Controller();
    const actor = { _position: { x: 0, z: 0 } };
    const other = { _position: { x: 0, z: -3.5 }, GetComponent: () => undefined };
    controller._parent = actor;
    controller._params = {
      world: { canWalk: () => true }, game: { grid: { FindNear: () => [{ entity: other }] } },
    };
    assert.equal(controller._FindIntersections({ x: 0, z: 0.1 }).length, 0);
    assert.equal(controller._FindIntersections({ x: 0, z: -0.1 }).length, 1);
    controller._params.world.canWalk = () => false;
    assert.equal(controller._FindIntersections({ x: 0, z: 0.1 }).length, 1);
    controller._params.world.canWalk = (x, z) => z < 2 || z > 3;
    assert.equal(controller._FindIntersections({ x: 0, z: 4 }).length, 1,
      'a clear destination beyond a wall must not allow tunnelling');
  }
});

test('renderer uses the default GPU preference and passes the context to Three.js', () => {
  const gl = context();
  const canvas = { getContext(name, options) {
    assert.equal(name, 'webgl2');
    assert.equal(options.powerPreference, 'default');
    return gl;
  } };
  class Renderer {
    constructor(options) { this.options = options; }
  }
  const result = createRenderer(Renderer, () => canvas);
  assert.equal(result.renderer.options.context, gl);
  assert.equal(result.renderer.options.canvas, canvas);
  assert.equal(result.compatibilityMode, false);
});

test('renderer retries antialiasing failures with a fresh canvas and compatibility mode', () => {
  const canvases = [];
  class Renderer {}
  const result = createRenderer(Renderer, () => {
    const canvas = { getContext: (_, options) => options.antialias ? null : context() };
    canvases.push(canvas);
    return canvas;
  });
  assert.equal(canvases.length, 2);
  assert.notEqual(canvases[0], canvases[1]);
  assert.equal(result.compatibilityMode, true);
});

test('renderer supports WebGL 1 only when instanced rendering is available', () => {
  const calls = [];
  class Renderer {}
  const result = createRenderer(Renderer, () => ({
    getContext(name) {
      calls.push(name);
      return name === 'webgl' ? context({ ANGLE_instanced_arrays: {} }) : null;
    },
  }));
  assert.deepEqual(calls, ['webgl2', 'webgl2', 'webgl']);
  assert.equal(result.compatibilityMode, true);
});

test('unsupported WebGL produces an actionable error without constructing a renderer', () => {
  for (const getContext of [
    () => null,
    () => { throw new Error('GPU unavailable'); },
    name => name === 'webgl2' ? null : context(),
  ]) {
    let constructed = 0;
    assert.throws(() => createRenderer(class {
      constructor() { constructed++; }
    }, () => ({ getContext })), WebGLUnavailableError);
    assert.equal(constructed, 0);
  }
});

test('failed renderer initialization releases its context before retrying', () => {
  let released = 0;
  let attempts = 0;
  class Renderer {
    constructor() {
      if (++attempts === 1) throw new Error('Initialization failed');
    }
  }
  const result = createRenderer(Renderer, () => ({
    getContext: () => context({ WEBGL_lose_context: { loseContext() { released++; } } }),
  }));
  assert.equal(released, 1);
  assert.equal(attempts, 2);
  assert.equal(result.compatibilityMode, true);
});

test('world generation is deterministic, varied, and clear of paths and landmarks', () => {
  const first = createScenery();
  assert.deepEqual(first, createScenery());
  assert.notDeepEqual(first, createScenery(8));
  for (const [name, placements] of Object.entries(first)) {
    assert.ok(placements.length > 30, `${name} is underpopulated`);
    for (const p of placements) {
      assert.ok(isWalkable(p.x, p.z, 5));
      assert.equal(isPath(p.x, p.z, 9), false);
    }
  }
  const random = seededRandom();
  assert.ok(Array.from({ length: 100 }, random).every(n => n >= 0 && n < 1));
});

test('player, guides and enemies spawn on walkable terrain', () => {
  assert.ok(isWalkable(...PLAYER_SPAWN));
  for (const guide of GUIDES) assert.ok(isWalkable(guide.x, guide.z), guide.name);
  for (const point of ENEMY_SPAWNS) assert.ok(isWalkable(...point), `${point}`);
});

test('buildings, water and world edges block movement, but the bridge stays open', () => {
  for (const building of BUILDINGS) assert.equal(isWalkable(building.x, building.z), false);
  assert.equal(isWalkable(LAKE.x + 12, LAKE.z), false);
  assert.equal(isWalkable(LAKE.x, LAKE.z), true);
  assert.equal(isWalkable(WORLD_LIMIT, 0), false);
  assert.equal(isWalkable(-WORLD_LIMIT, 0), false);
  assert.equal(isWalkable(0, WORLD_LIMIT), false);
});

test('map regions have distinct names', () => {
  assert.equal(regionAt(0, 20), 'Cloudhaven Village');
  assert.equal(regionAt(90, -85), 'The Crystal Ruins');
  assert.equal(regionAt(78, 56), 'Mirrorwater Lake');
  assert.equal(regionAt(-90, -80), 'Whispering Forest');
});

test('tree trunks block actors without blocking their surrounding clearings', () => {
  const trees = [{ x: -90, z: -80, scale: 1 }];
  assert.equal(isWalkable(-90, -80, 1.5, trees), false);
  assert.equal(isWalkable(-88, -80, 1.5, trees), false);
  assert.equal(isWalkable(-84, -80, 1.5, trees), true);
});

test('V2 uses an isolated quest key and preserves the classic filter', async () => {
  const client = api(async () => response([task]));
  await client.requestQuest();
  assert.deepEqual(client.quest, task);
  assert.equal(client.keys.getItem('filter'), 'classic-quest');
  assert.equal(client.storage.getItem('filter'), null);
  assert.equal(client.storage.getItem(QUEST_KEY), JSON.stringify(task));
});

test('quest requests use original task requirements, not randomized NPC dialogue mode', async () => {
  const original = {
    ...task,
    instruction: 'Create a VPC in us-east-1.\nUse CIDR 10.0.0.0/16.\nTag it Name=<AWS Warrior>.',
  };
  const client = api(async url => {
    assert.equal(url.pathname, '/Prod/game');
    assert.equal(url.search, '');
    return response([original, { ...task, filter: 'test=Next' }]);
  });
  assert.deepEqual(await client.requestQuest(), { task: original });
  assert.equal(client.quest.instruction, original.instruction);
});

test('refreshing a saved V2 quest replaces old rewritten dialogue with original instructions', async () => {
  const client = api(async () => response([task]), {
    [QUEST_KEY]: JSON.stringify({ ...task, instruction: 'Talk to another villager.' }),
  });
  await client.requestQuest();
  assert.deepEqual(client.quest, task);
});

test('default fetch uses the global receiver required by browsers', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async function (url, options) {
    assert.equal(this, globalThis);
    assert.equal(url.pathname, '/Prod/game');
    assert.equal(options.headers['x-api-key'], 'example-key');
    return response([task]);
  });
  const client = new GameApi({
    baseUrl: 'https://example.com/Prod/',
    storage: storage(),
    keys: storage({ api_key: 'example-key' }),
  });
  await client.requestQuest();
  assert.deepEqual(client.quest, task);
  assert.equal(fetch.mock.callCount(), 1);
});

test('API requests preserve the shared key, controller path and encoded filter', async () => {
  let request;
  const client = api(async (url, options) => {
    request = { url, options };
    return response({ isSuccess: false });
  }, { [QUEST_KEY]: JSON.stringify(task) });
  await client.gradeQuest();
  assert.equal(request.url.pathname, '/Prod/grader');
  assert.equal(request.url.searchParams.get('filter'), task.filter);
  assert.equal(request.options.headers['x-api-key'], 'example-key');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(request.options.cache, 'no-store');
  assert.deepEqual(client.quest, task);
});

test('missing keys never trigger a network request', async () => {
  const client = api(() => assert.fail('Unexpected network request'));
  client.keys.removeItem('api_key');
  await assert.rejects(client.requestQuest(), /Set your API key/);
});

test('dialogue responses do not overwrite an active quest', async () => {
  const client = api(async () => response('Keep going, warrior!'),
    { [QUEST_KEY]: JSON.stringify(task) });
  assert.deepEqual(await client.requestQuest(), { message: 'Keep going, warrior!' });
  assert.deepEqual(client.quest, task);
});

test('passing a quest clears only V2 quest state', async () => {
  const client = api(async () => response({ isSuccess: true }),
    { [QUEST_KEY]: JSON.stringify(task) });
  await client.gradeQuest();
  assert.equal(client.quest, null);
  assert.equal(client.keys.getItem('filter'), 'classic-quest');
});

test('failed grading retains the same instructions and filter for the next monster kill', async () => {
  const calls = [];
  const client = api(async url => {
    calls.push(url);
    if (url.pathname.endsWith('/game')) return response([task]);
    return response({ isSuccess: calls.length > 2 });
  });
  await client.requestQuest();
  assert.deepEqual(await client.gradeQuest(), { isSuccess: false });
  assert.deepEqual(client.quest, task);
  assert.deepEqual(await client.gradeQuest(), { isSuccess: true });
  assert.equal(client.quest, null);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].searchParams.get('filter'), task.filter);
  assert.equal(calls[2].searchParams.get('filter'), task.filter);
});

test('completing every task clears V2 quest state without suggesting another task', async () => {
  const client = api(async () => response([]), { [QUEST_KEY]: JSON.stringify(task) });
  assert.deepEqual(await client.requestQuest(), { completed: true, message: 'You have completed all tasks!' });
  assert.equal(client.quest, null);
  assert.equal(client.keys.getItem('filter'), 'classic-quest');
});

test('a marks reset clears the old quest in another V2 tab on its next access', () => {
  const client = api(() => assert.fail('Unexpected request'), { [QUEST_KEY]: JSON.stringify(task) });
  client.keys.setItem(MARKS_RESET_KEY, 'reset-1');
  assert.equal(client.quest, null);
  assert.equal(client.storage.getItem(QUEST_KEY), null);
  assert.equal(client.keys.getItem('api_key'), 'example-key');
});

test('quests accepted after a marks reset remain active', async () => {
  const client = api(async () => response([task]), { [QUEST_KEY]: JSON.stringify(task) });
  client.keys.setItem(MARKS_RESET_KEY, 'reset-1');
  await client.requestQuest();
  assert.deepEqual(client.quest, task);
});

test('a pending guide response cannot restore a quest after changing accounts', async () => {
  let finish;
  const client = api(() => new Promise(resolve => { finish = resolve; }));
  const pending = client.requestQuest();
  client.keys.setItem('api_key', 'another-example-key');
  finish(response([task]));
  await assert.rejects(pending, /API key changed/);
  assert.equal(client.quest, null);
});

test('a pending guide response cannot restore a quest after marks were reset', async () => {
  let finish;
  const client = api(() => new Promise(resolve => { finish = resolve; }));
  const pending = client.requestQuest();
  client.keys.setItem(MARKS_RESET_KEY, 'reset-1');
  finish(response([task]));
  await assert.rejects(pending, /marks were reset/);
  assert.equal(client.quest, null);
});

test('a pending grade cannot report old success or clear a new quest after reset', async () => {
  let finish;
  const client = api(() => new Promise(resolve => { finish = resolve; }),
    { [QUEST_KEY]: JSON.stringify(task) });
  const pending = client.gradeQuest();
  client.keys.setItem(MARKS_RESET_KEY, 'reset-1');
  assert.equal(client.quest, null);
  client.storage.setItem(QUEST_KEY, JSON.stringify(task));
  finish(response({ isSuccess: true }));
  await assert.rejects(pending, /marks were reset/);
  assert.deepEqual(client.quest, task);
  assert.equal(client.grading, null);
});

test('an old grading response cannot clear a newly accepted quest', async () => {
  let finish;
  const client = api(() => new Promise(resolve => { finish = resolve; }),
    { [QUEST_KEY]: JSON.stringify(task) });
  const pending = client.gradeQuest();
  const next = { ...task, filter: 'test=Next' };
  client.storage.setItem(QUEST_KEY, JSON.stringify(next));
  finish(response({ isSuccess: true }));
  await pending;
  assert.deepEqual(client.quest, next);
});

test('simultaneous monster kills share one in-flight grading request', async () => {
  let calls = 0;
  const client = api(async () => {
    calls++;
    return response({ isSuccess: false });
  }, { [QUEST_KEY]: JSON.stringify(task) });
  const first = client.gradeQuest();
  assert.equal(first, client.gradeQuest());
  await first;
  assert.equal(calls, 1);
});

test('a grading response cannot clear the quest after changing accounts', async () => {
  let finish;
  const client = api(() => new Promise(resolve => { finish = resolve; }),
    { [QUEST_KEY]: JSON.stringify(task) });
  const pending = client.gradeQuest();
  client.keys.setItem('api_key', 'another-example-key');
  finish(response({ isSuccess: true }));
  await pending;
  assert.deepEqual(client.quest, task);
});

test('network, HTTP and malformed responses preserve the quest for retry', async () => {
  for (const fetcher of [
    async () => { throw new Error('Offline'); },
    async () => ({ ok: false, status: 403 }),
    async () => response('Invalid result'),
  ]) {
    const client = api(fetcher, { [QUEST_KEY]: JSON.stringify(task) });
    await assert.rejects(client.gradeQuest());
    assert.deepEqual(client.quest, task);
    assert.equal(client.grading, null);
  }
});

test('timed-out requests abort cleanly without losing the active quest', async () => {
  const client = api((_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    });
  }), { [QUEST_KEY]: JSON.stringify(task) });
  await assert.rejects(client.request('game', { mode: 'game' }, 5), /timed out/);
  assert.deepEqual(client.quest, task);
});

test('invalid quest responses and corrupt saved state fail safely', async () => {
  for (const data of [null, [null], [{}], ...['name', 'filter', 'instruction'].map(field => [{ ...task, [field]: ' ' }])]) {
    const client = api(async () => response(data), { [QUEST_KEY]: '{invalid' });
    assert.equal(client.quest, null);
    await assert.rejects(client.requestQuest(), /No task instructions/);
  }
});

test('no active quest means no grading request', async () => {
  const client = api(() => assert.fail('Unexpected network request'));
  assert.equal(await client.gradeQuest(), null);
});

test('both entry points stay separate and V2 assets include their licenses', () => {
  const classic = readFileSync(new URL('../game.html', import.meta.url), 'utf8');
  const beta = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  assert.match(classic, /src="\.\/src\/main\.js"/);
  assert.doesNotMatch(classic, /v2\/main/);
  assert.match(beta, /src="\.\/v2\/main\.js\?v=[^"]+"/);
  assert.match(beta, /href="\.\/game\.html"/);
  assert.doesNotMatch(beta, /href="\.\/marks"/);
  assert.match(beta, /id="sound-button"/);
  assert.match(beta, /id="sound-volume"/);
  assert.match(beta, /<dialog id="task-dialog"/);
  assert.match(beta, /id="task-instructions"/);
  assert.match(beta, /id="conversation-button"/);
  assert.match(beta, /id="task-instructions"[^>]*role="region"/);
  assert.doesNotMatch(beta, /id="grade-button"|Retry quest grading/);
  assert.doesNotMatch(beta, /id="talk-button"/);
  assert.match(beta, /<kbd>E<\/kbd> Get task/);
  assert.doesNotMatch(beta, /click them/i);
  const models = fileURLToPath(new URL('../v2/assets/kenney/', import.meta.url));
  const files = readdirSync(models).filter(name => name.endsWith('.glb'));
  assert.equal(files.length, 26);
  for (const file of files) {
    const bytes = readFileSync(`${models}/${file}`);
    assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
    assert.equal(bytes.readUInt32LE(4), 2);
    const length = bytes.readUInt32LE(12);
    const metadata = JSON.parse(bytes.toString('utf8', 20, 20 + length));
    for (const image of metadata.images || []) {
      if (image.uri) assert.ok(existsSync(`${models}/${image.uri}`));
    }
  }
  assert.match(readFileSync(`${models}/License.txt`, 'utf8'), /Creative Commons Zero/);
});
