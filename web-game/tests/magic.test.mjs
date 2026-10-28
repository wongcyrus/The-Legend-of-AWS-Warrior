import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { MagicWallet, MagicCombat, SPELLS, spellDamage } from '../v2/magic.js';
import { WEAPONS } from '../v2/adventure.js';
import { MONSTERS, SUPER_MONSTERS, superMonsterProfile, monsterFor } from '../v2/monsters.js';
import { MAPS } from '../v2/maps.js';

const walletData = (balance = 10, revision = 1) => ({ balance, max: 100, earned: 20, spent: 20 - balance, revision });
const success = data => ({ ok: true, json: async () => data });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
function walletHarness(fetcher, uuid = randomUUID) {
  let key = 'student-one', effects = 0, ready = true;
  const wallet = new MagicWallet({ baseUrl: 'https://example.test/api/', readKey: () => key, fetcher, uuid });
  return { wallet, key(value) { key = value; }, ready(value) { ready = value; },
    get effects() { return effects; },
    cast(spell = 'lightning', level = 1) {
      return wallet.cast({ spell, level, valid: () => ready,
        execute: pay => { if (!pay(level)) return false; effects++; return true; } });
    } };
}
const authorization = (request, wallet = walletData(9, 2)) => ({
  ...JSON.parse(request.body), cost: JSON.parse(request.body).level, wallet,
});

test('MP loads only from the server with the masked key header, never reading accrual or saved balances', async () => {
  const requests = [];
  const h = walletHarness(async (url, request) => {
    requests.push({ url, request });
    return success(walletData());
  });
  assert.equal(h.wallet.wallet, null);
  assert.equal(await h.cast(), false);
  assert.equal(requests.length, 0);
  assert.equal(await h.wallet.refresh(), true);
  assert.equal(h.wallet.wallet.balance, 10);
  assert.equal(requests[0].url.pathname, '/api/voice/wallet');
  assert.equal(requests[0].url.search, '');
  assert.equal(requests[0].request.headers['x-api-key'], 'student-one');
  assert.equal(requests[0].request.cache, 'no-store');
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../v2/magic.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main + source, /MagicBadges|MAGIC_SPENT_KEY|magicTesting|magicTest|unlimited|Free test cast/);
  assert.doesNotMatch(source, /localStorage|readServices|storage\.setItem/);
  assert.match(main, /refreshVoiceWallet\(\)/);
});

test('wallet failures fail closed without inventing MP', async () => {
  for (const fetcher of [
    async () => ({ ok: false, status: 403 }),
    async () => ({ ok: false, status: 503 }),
    async () => { throw new TypeError('offline'); },
    async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
    async () => success({ ...walletData(), balance: 101 }),
    async () => success({ ...walletData(), revision: -1 }),
    async () => success({ balance: 10 }),
  ]) {
    const h = walletHarness(fetcher);
    assert.equal(await h.wallet.refresh(), false);
    assert.equal(h.wallet.wallet, null);
    assert.equal(h.wallet.checking, 0);
    assert.ok(h.wallet.error);
    assert.equal(await h.cast(), false);
    assert.equal(h.effects, 0);
  }
});

test('cast checks validity and affordability before reserving; double clicks cannot double pay or apply', async () => {
  const response = deferred(), requests = [];
  const h = walletHarness(async (url, request) => {
    if (request.method === 'GET') return success(walletData(2));
    requests.push(request);
    return response.promise;
  });
  await h.wallet.refresh();
  h.ready(false);
  assert.equal(await h.cast(), false);
  h.ready(true);
  assert.equal(await h.cast('lightning', 3), false);
  for (const level of [0, 4, 1.5, '1']) assert.equal(await h.cast('lightning', level), false);
  assert.equal(await h.cast('constructor'), false);
  assert.equal(requests.length, 0);
  const cast = h.cast();
  assert.equal(h.wallet.busy, true);
  assert.equal(h.effects, 0);
  assert.equal(await h.cast(), false);
  assert.equal(await h.cast('frost'), false);
  assert.equal(requests.length, 1);
  assert.match(JSON.parse(requests[0].body).requestId, /^[0-9a-f-]{36}$/);
  response.resolve(success(authorization(requests[0], walletData(1, 2))));
  assert.equal(await cast, true);
  assert.equal(h.effects, 1);
  assert.equal(h.wallet.wallet.balance, 1);
  assert.equal(h.wallet.busy, false);
});

test('uncertain reservations reuse the request ID, while confirmed rejections do not execute', async () => {
  for (const failure of ['network', '503', 'json', 'authorization']) {
    const requests = [];
    const h = walletHarness(async (url, request) => {
      if (request.method === 'GET') return success(walletData());
      requests.push(request);
      if (requests.length > 1) return success(authorization(request));
      if (failure === 'network') throw new TypeError('lost response');
      if (failure === '503') return { ok: false, status: 503 };
      if (failure === 'json') return { ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } };
      return success({ wallet: walletData(9, 2) });
    });
    await h.wallet.refresh();
    assert.equal(await h.cast(), false);
    assert.equal(h.effects, 0);
    assert.ok(h.wallet.pending);
    assert.equal(await h.cast('frost'), false);
    assert.equal(await h.cast('lightning', 2), false);
    assert.equal(requests.length, 1);
    assert.equal(await h.cast(), true);
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(h.effects, 1);
    assert.equal(h.wallet.pending, null);
  }
  for (const status of [403, 409, 429]) {
    const h = walletHarness(async (url, request) => request.method === 'GET'
      ? success(walletData()) : { ok: false, status });
    await h.wallet.refresh();
    assert.equal(await h.cast(), false);
    assert.equal(h.effects, 0);
    assert.equal(h.wallet.pending, null);
    assert.ok(h.wallet.error);
  }
});

test('a paid reservation waits for valid gameplay and cannot replay its local effect', async () => {
  const pending = deferred();
  let post;
  const h = walletHarness(async (url, request) => {
    if (request.method === 'GET') return success(walletData());
    post = request;
    return pending.promise;
  }, () => 'fixed-test-id');
  await h.wallet.refresh();
  const cast = h.cast();
  h.ready(false);
  pending.resolve(success(authorization(post)));
  assert.equal(await cast, false);
  assert.equal(h.wallet.pending.authorized, true);
  assert.equal(h.effects, 0);
  h.ready(true);
  assert.equal(await h.cast(), true);
  assert.equal(h.effects, 1);
  assert.equal(await h.cast(), false);
  assert.equal(h.effects, 1);
});

test('key changes clear wallet, pending IDs and effects cache and ignore stale success and errors', async () => {
  for (const rejection of [false, true]) {
    const pending = deferred();
    let post;
    const h = walletHarness(async (url, request) => {
      if (request.method === 'GET') return success(walletData());
      post = request; return pending.promise;
    });
    await h.wallet.refresh();
    const cast = h.cast();
    h.key('student-two');
    await h.wallet.refresh();
    assert.equal(h.wallet.pending, null);
    assert.equal(h.wallet.applied.size, 0);
    if (rejection) pending.reject(new TypeError('old account failure'));
    else pending.resolve(success(authorization(post)));
    assert.equal(await cast, false);
    assert.equal(h.effects, 0);
    assert.equal(h.wallet.error, '');
    assert.equal(h.wallet.wallet.balance, 10);
  }
  const pending = deferred();
  const h = walletHarness(() => pending.promise);
  const request = h.wallet.refresh();
  h.key('');
  pending.resolve(success(walletData()));
  assert.equal(await request, false);
  assert.equal(h.wallet.wallet, null);
  assert.equal(h.wallet.checking, 0);
});

test('wallet revisions cannot roll back newer GET or cast results, including cached idempotent responses', async () => {
  const older = deferred(), newer = deferred();
  let gets = 0;
  const h = walletHarness(async (url, request) => {
    if (request.method === 'GET') return ++gets === 1 ? older.promise : newer.promise;
    return success(authorization(request, walletData(9, 2)));
  });
  const first = h.wallet.refresh(), second = h.wallet.refresh();
  newer.resolve(success(walletData(15, 5)));
  assert.equal(await second, true);
  older.resolve(success(walletData(10, 1)));
  assert.equal(await first, true);
  assert.equal(h.wallet.wallet.balance, 15);
  assert.equal(await h.cast(), true);
  assert.equal(h.wallet.wallet.balance, 15);
  assert.equal(h.wallet.wallet.revision, 5);
});

test('stale failed refreshes cannot erase a newer wallet and key changes also protect delayed JSON parsing', async () => {
  const old = deferred(), current = deferred();
  let count = 0;
  const h = walletHarness(() => ++count === 1 ? old.promise : current.promise);
  const first = h.wallet.refresh(), second = h.wallet.refresh();
  current.resolve(success(walletData(15, 5)));
  await second;
  old.reject(new TypeError('old failure'));
  await first;
  assert.equal(h.wallet.wallet.balance, 15);
  assert.equal(h.wallet.error, '');
  const json = deferred();
  const other = walletHarness(async () => ({ ok: true, json: () => json.promise }));
  const loading = other.wallet.refresh();
  await new Promise(resolve => setImmediate(resolve));
  other.key('changed-before-json');
  json.resolve(walletData(15, 5));
  assert.equal(await loading, false);
  assert.equal(other.wallet.wallet, null);
});

test('cast authorization must match the request and a synchronous one-use payment is required', async () => {
  for (const invalid of [
    { requestId: 'another-id' }, { spell: 'fireball' }, { level: 2 }, { cost: 0 },
    { wallet: { ...walletData(), balance: 101 } },
  ]) {
    let post;
    const h = walletHarness(async (url, request) => {
      if (request.method === 'GET') return success(walletData());
      post = request; return success({ ...authorization(request), ...invalid });
    });
    await h.wallet.refresh();
    assert.equal(await h.cast(), false);
    assert.equal(h.effects, 0);
    assert.equal(h.wallet.pending.requestId, JSON.parse(post.body).requestId);
  }
  const h = harness();
  assert.equal(h.cast('fireball', 1, () => Promise.resolve(true)), false);
  assert.equal(h.magic.projectiles.length, 0);
  assert.equal(h.magic.cooldown, 0);
});

test('MP UI exposes authoritative balance and disables unaffordable, checking and cooldown actions', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const nodes = Object.fromEntries(['mp-value', 'mp-bar', 'magic-badges', 'magic-cast']
    .map(id => [id, { style: {}, disabled: false, textContent: '' }]));
  const levels = [1, 2, 3].map(level => ({ dataset: { magicLevel: String(level) } }));
  const spells = Object.keys(SPELLS).map(spell => ({ dataset: { spell } }));
  const attributes = {};
  const meter = { setAttribute: (name, value) => { attributes[name] = value; } };
  const document = { getElementById: id => nodes[id], querySelector: () => meter,
    querySelectorAll: selector => selector === '[data-spell]' ? spells : levels };
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', { document, SPELLS });
  const voiceWallet = { syncKey() {}, wallet: walletData(2), checking: 0, busy: false, pending: null };
  const game = { ready: true, spell: 'lightning', magicLevel: 1, magic: { cooldown: 0 }, voiceWallet };
  const update = () => Game.prototype.updateMagicUI.call(game);
  update();
  assert.equal(nodes['mp-value'].textContent, '2 / 100');
  assert.equal(nodes['mp-bar'].style.width, '2%');
  assert.equal(attributes['aria-valuenow'], '2');
  assert.equal(nodes['magic-cast'].disabled, false);
  assert.equal(levels[2].disabled, true);
  voiceWallet.checking = 1;
  update();
  assert.equal(nodes['magic-cast'].disabled, true);
  assert.match(nodes['magic-cast'].textContent, /Checking MP/);
  voiceWallet.checking = 0;
  game.magic.cooldown = 1.2;
  update();
  assert.equal(nodes['magic-cast'].disabled, true);
  assert.match(nodes['magic-cast'].textContent, /Cooldown 1.2s/);
  game.magic.cooldown = 0;
  voiceWallet.busy = true;
  update();
  assert.match(nodes['magic-cast'].textContent, /Reserving MP/);
  voiceWallet.busy = false;
  voiceWallet.wallet = walletData(0, 3);
  voiceWallet.pending = { spell: 'lightning', level: 1 };
  update();
  assert.equal(nodes['magic-cast'].disabled, false, 'a charged retry can finish even with no MP left');
  assert.equal(spells[1].disabled, true);
  voiceWallet.wallet = null;
  voiceWallet.pending = null;
  update();
  assert.equal(nodes['mp-bar'].style.width, '0%');
  assert.equal(nodes['magic-cast'].disabled, true);
  assert.match(main, /localStorage\.setItem\("api_key", key\);[\s\S]*?refreshVoiceWallet\(\);[\s\S]*?dispatchEvent\(new Event\("voice-owner-changed"\)\)/);
});

function harness(targets = [{ id: 'a', x: 0, z: 8 }], power = () => 50) {
  const hits = [], slows = [], pushes = [], effects = [], paid = [];
  let blocked = false;
  const magic = new MagicCombat({
    power,
    targets: () => targets,
    canWalk: (x, z) => !blocked || z < 5,
    clear: () => !blocked,
    damage: (target, value) => hits.push({ id: target.id, value }),
    slow: (target, duration) => slows.push({ id: target.id, duration }),
    push: (target, from, distance) => pushes.push({ id: target.id, distance }),
    effect: (...args) => effects.push(args),
  });
  return { magic, hits, slows, pushes, effects, paid, block() { blocked = true; },
    cast(id, level = 1, pay = cost => { paid.push(cost); return true; }) {
      return magic.cast(id, level, { x: 0, z: 0 }, { x: 0, z: 1 }, pay);
    } };
}

test('all spells scale with current Power and exceed the strongest melee hit at every level', () => {
  let power = 50;
  for (const id of Object.keys(SPELLS)) {
    const h = harness(undefined, () => power);
    for (power of [25, 50, 80, 125]) for (const level of [1, 2, 3]) {
      h.magic.update(10);
      assert.equal(h.cast(id, level), true);
      if (id === 'fireball') {
        power += 10;
        h.magic.update(2);
        power -= 10;
      }
      const expected = Math.round(SPELLS[id].damage * power / 50 * level);
      assert.equal(h.hits.at(-1).value, expected, `${id}, Power ${power}, level ${level}`);
      assert.equal(spellDamage(id, level, power), expected);
      assert.ok(expected > Math.max(...Object.values(WEAPONS).map(weapon => Math.round(power * weapon.damage))));
    }
  }
});

for (const id of Object.keys(SPELLS)) {
  for (const level of [1, 2, 3]) test(`${id} power ${level}: cost, damage and cooldown`, () => {
    const h = harness();
    assert.equal(h.cast(id, level), true);
    assert.deepEqual(h.paid, [level]);
    if (id === 'fireball') {
      assert.equal(h.hits.length, 0);
      for (let i = 0; i < 30; i++) h.magic.update(1 / 30);
      assert.equal(h.magic.projectiles.length, 0);
    }
    assert.deepEqual(h.hits, [{ id: 'a', value: SPELLS[id].damage * level }]);
    assert.equal(h.cast(id, level), false);
    assert.deepEqual(h.paid, [level]);
    h.magic.update(10);
    assert.equal(h.magic.cooldown, 0);
    assert.equal(h.cast(id, level), true);
    if (id === 'frost') assert.equal(h.slows[0].duration, 3 + level);
    if (id === 'shockwave') assert.equal(h.pushes[0].distance, 3 + level * 2);
    assert.ok(h.effects.length);
  });
}

test('invalid input, blocked casts, directional misses, walls and chain limits', () => {
  for (const id of ['__proto__', 'constructor', 'unknown']) assert.equal(harness().cast(id), false);
  for (const level of [0, 4, NaN, 1.5]) assert.equal(harness().cast('lightning', level), false);
  const h = harness();
  assert.equal(h.cast('fireball', 1, () => false), false);
  assert.equal(h.magic.cooldown, 0);
  assert.equal(h.magic.projectiles.length, 0);
  const targets = [{ id: 'a', x: 0, z: 8 }, { id: 'b', x: 2, z: 10 },
    { id: 'c', x: -3, z: 12 }, { id: 'behind', x: 0, z: -9 }];
  for (const level of [1, 2, 3]) {
    const chain = harness(targets);
    chain.cast('lightning', level);
    assert.equal(chain.hits.length, level);
    assert.equal(new Set(chain.hits.map(hit => hit.id)).size, level);
  }
  const miss = harness([{ id: 'behind', x: 0, z: -8 }]);
  assert.equal(miss.cast('frost'), true);
  assert.equal(miss.hits.length, 0);
  assert.deepEqual(miss.paid, [1]);
  for (const id of Object.keys(SPELLS)) {
    const wall = harness();
    wall.block();
    wall.cast(id);
    wall.magic.update(2);
    assert.equal(wall.hits.length, 0, id);
  }
});

test('equal MP costs have distinct situational strengths and a shared cooldown', () => {
  const targets = [{ id: 'front', x: 0, z: 8 }, { id: 'side', x: 8, z: 0 },
    { id: 'back', x: 0, z: -8 }];
  for (const id of Object.keys(SPELLS)) {
    const h = harness(targets);
    h.cast(id, 3);
    assert.deepEqual(h.paid, [3]);
    assert.equal(h.cast(id === 'shockwave' ? 'lightning' : 'shockwave'), false);
    assert.deepEqual(h.paid, [3]);
  }
  const distant = harness([{ id: 'far', x: 0, z: 39 }]);
  distant.cast('lightning');
  assert.deepEqual(distant.hits, [{ id: 'far', value: 320 }]);
  const chain = harness([{ id: 'a', x: 0, z: 8 }, { id: 'b', x: 1, z: 9 }, { id: 'c', x: 2, z: 10 }]);
  chain.cast('lightning', 3);
  assert.deepEqual(chain.hits.map(hit => hit.value), [960, 480, 240]);
  const blast = harness([{ id: 'a', x: 0, z: 8 }, { id: 'b', x: 3, z: 8 }]);
  blast.cast('fireball');
  blast.magic.update(1);
  assert.deepEqual(blast.hits.map(hit => hit.value), [260, 260]);
  const frost = harness([...targets, { id: 'approaching', x: 0, z: 17 }]);
  frost.cast('frost');
  assert.deepEqual(frost.hits.map(hit => hit.id), ['front', 'approaching']);
  assert.deepEqual(frost.slows.map(slow => slow.duration), [4, 4]);
  const storm = harness([...targets, { id: 'spread', x: 14, z: 0 }]);
  storm.cast('storm');
  assert.equal(storm.hits.length, 4);
  assert.equal(storm.magic.cooldown, 9);
  const escape = harness([...targets, { id: 'far', x: 14, z: 0 }]);
  escape.cast('shockwave');
  assert.equal(escape.hits.length, 3);
  assert.equal(escape.pushes.length, 3);
  assert.equal(escape.magic.cooldown, 2);
  assert.ok(SPELLS.lightning.damage > SPELLS.fireball.damage);
  assert.ok(SPELLS.fireball.damage > SPELLS.storm.damage);
  assert.ok(SPELLS.storm.range > SPELLS.shockwave.range);
  assert.ok(SPELLS.frost.range > SPELLS.storm.range);
});

test('fireballs cannot tunnel past enemies and clear safely on travel or death', () => {
  const h = harness();
  h.cast('fireball', 3);
  const shot = h.magic.projectiles[0];
  h.magic.update(1);
  assert.equal(h.hits.length, 1);
  assert.equal(shot.done, true);
  h.magic.update(10);
  h.cast('fireball');
  const next = h.magic.projectiles[0];
  h.magic.clearProjectiles();
  assert.equal(next.done, true);
  assert.equal(h.magic.projectiles.length, 0);
  const cooldown = h.magic.cooldown;
  h.magic.update(NaN);
  h.magic.update(-1);
  assert.equal(h.magic.cooldown, cooldown);
});

test('each expedition upgrades its last spawn without changing ordinary models or base stats', () => {
  for (const map of Object.values(MAPS).filter(map => map.id !== 'village')) {
    const name = monsterFor(map.id, map.enemies.length - 1);
    const profile = superMonsterProfile(name, map.id);
    assert.equal(profile.label, SUPER_MONSTERS[map.id].label);
    assert.ok(profile.health > MONSTERS[name].health);
    assert.ok(profile.damage > MONSTERS[name].damage);
    assert.ok(profile.scale > MONSTERS[name].scale);
    assert.ok(profile.windup > MONSTERS[name].windup);
  }
  assert.equal(superMonsterProfile('Yeti', 'village'), null);
  assert.equal(superMonsterProfile('constructor', 'mountains'), null);
});

test('magic game actions reject blocked states before spending and use normal damage events', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', {
    document: { querySelector: () => false },
  });
  const notices = [];
  const game = { ready: false, magic: {}, magicStatus: message => notices.push(message),
    player: { GetComponent: () => ({ IsAlive: () => true }) } };
  assert.equal(Game.prototype.canCastMagic.call(game), false);
  assert.ok(notices.at(-1).length > 10);
  for (const key of ['traveling', 'progressChanging', 'readingService', 'talking']) {
    game.ready = true; game[key] = true;
    assert.equal(Game.prototype.canCastMagic.call(game), false);
    game[key] = false;
  }
  assert.match(main, /target\.actor\.Broadcast\(\{ topic: "health.damage", value, attacker: this.player \}\)/);
  assert.match(main, /event.code === "KeyX"[\s\S]*?!event.repeat[\s\S]*?castMagic/);
  assert.match(main, /controller\.magicSlow = 0/);
});

test('spell visuals follow projectiles, expire, remain bounded and dispose owned GPU resources', () => {
  class Resource {
    constructor(options) { Object.assign(this, options); this.disposed = 0; }
    dispose() { this.disposed++; }
    setFromPoints() { return this; }
  }
  class Object3D {
    constructor(geometry, material) {
      Object.assign(this, { geometry, material, rotation: {}, position: { set() {} }, scale: { setScalar() {} } });
    }
  }
  const scene = { add(object) { object.parent = this; }, remove(object) { object.parent = null; } };
  const THREE = {
    MeshBasicMaterial: Resource, LineBasicMaterial: Resource, BufferGeometry: Resource,
    SphereGeometry: Resource, RingGeometry: Resource, TubeGeometry: Resource,
    CatmullRomCurve3: class {}, Mesh: Object3D, Line: Object3D,
    Vector3: class {}, DoubleSide: 2, AdditiveBlending: 2,
  };
  const source = readFileSync(new URL('../v2/magic-effects.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace('export class', 'class');
  const MagicEffects = runInNewContext(source + '\nMagicEffects;', { THREE, SPELLS });
  const effects = new MagicEffects(scene);
  const from = { x: 0, z: 0 }, to = { x: 0, z: 5, range: 10 };
  for (const id of [...Object.keys(SPELLS), 'explosion', 'cast']) effects.spawn(id, from, to, 3);
  const objects = effects.active.map(effect => effect.object);
  effects.update(1);
  assert.equal(effects.active.length, 1);
  assert.equal(effects.active[0].kind, 'fireball');
  from.done = true;
  effects.update(0.01);
  assert.equal(effects.active.length, 0);
  for (const object of objects) {
    assert.equal(object.parent, null);
    assert.equal(object.material.disposed, 1);
    assert.equal(object.geometry.disposed, 1);
  }
  for (let i = 0; i < 45; i++) effects.spawn('frost', { x: 0, z: 0 }, to, 1);
  effects.spawn('storm', from, to, 3);
  assert.equal(effects.active.length, 40);
  effects.clear();
  assert.equal(effects.active.length, 0);

  const shot = { x: 2, z: 4 };
  effects.spawn('fireball', shot, null, 2);
  effects.spawn('explosion', shot, null, 2);
  const explosion = effects.active[1];
  shot.done = true;
  effects.update(0.01);
  assert.equal(effects.active.length, 1);
  assert.equal(effects.active[0].kind, 'explosion');
  assert.equal(explosion.object.geometry.disposed, 0);
  assert.ok(explosion.object.material.opacity > 0.9);
  effects.update(1);
  assert.equal(explosion.object.geometry.disposed, 1);
});

test('game casts are server-reserved even when old testing flags are supplied', async () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', {
    document: { querySelector: () => false }, SPELLS,
    THREE: { Vector3: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } applyQuaternion() { return this; } } },
    location: { search: '?magicTest=1' },
  });
  let requests = 0;
  const combat = harness();
  const wallet = walletHarness(async (url, request) => {
    requests++;
    return success(request.method === 'GET' ? walletData() : authorization(request));
  });
  await wallet.wallet.refresh();
  const game = {
    magicTesting: true, ready: true, magic: combat.magic, dodge: { active: false },
    spell: 'lightning', magicLevel: 1, map: {},
    player: { _position: { clone: () => ({ x: 0, z: 0 }) }, GetComponent: () => ({
      IsAlive: () => true, _stateMachine: { _currentState: { Name: 'idle' } },
    }) },
    voiceWallet: wallet.wallet, canCastMagic: Game.prototype.canCastMagic,
    guard: { release() {} }, sound: { play() {} }, updateMagicUI() {}, magicStatus() {},
  };
  assert.equal(await Game.prototype.castMagic.call(game), true);
  assert.equal(combat.magic.cooldown, SPELLS.lightning.cooldown);
  assert.equal(wallet.wallet.wallet.balance, 9);
  assert.equal(await Game.prototype.castMagic.call(game), false);
  assert.equal(requests, 2);
  game.magic.cooldown = 0;
  game.dodge.active = true;
  assert.equal(await Game.prototype.castMagic.call(game), false);
  assert.equal(requests, 2);
});

test('hidden Control+Alt/Option+M toggles free cooldown-free casts without changing the wallet', async () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  let dialog = false;
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', {
    document: { querySelector: () => dialog }, SPELLS,
    THREE: { Vector3: class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } applyQuaternion() { return this; } } },
  });
  const combat = harness(), notices = [];
  let requests = 0, prevented = 0;
  const game = {
    infinitiveMagic: false, ready: true, magic: combat.magic, dodge: { active: false },
    spell: 'lightning', magicLevel: 3, map: {},
    player: { _position: { clone: () => ({ x: 0, z: 0 }) }, GetComponent: () => ({
      IsAlive: () => true, _stateMachine: { _currentState: { Name: 'idle' } },
    }) },
    voiceWallet: { wallet: walletData(0), cast: async () => { requests++; return false; } },
    canCastMagic: Game.prototype.canCastMagic,
    guard: { release() {} }, sound: { play() {} }, updateMagicUI() {}, magicStatus: message => notices.push(message),
  };
  const event = { code: 'KeyM', ctrlKey: true, altKey: true, preventDefault() { prevented++; } };
  for (const overrides of [{ repeat: true }, { isComposing: true }, { metaKey: true }, { shiftKey: true },
    { ctrlKey: false }, { altKey: false }, { code: 'KeyX' }, { target: { closest: () => true } }]) {
    Game.prototype.toggleInfinitiveMagic.call(game, { ...event, ...overrides });
    assert.equal(game.infinitiveMagic, false);
  }
  dialog = true;
  Game.prototype.toggleInfinitiveMagic.call(game, event);
  assert.equal(game.infinitiveMagic, false);
  dialog = false;
  for (const field of ['busy', 'pending']) {
    game.voiceWallet[field] = true;
    Game.prototype.toggleInfinitiveMagic.call(game, event);
    assert.equal(game.infinitiveMagic, false);
    game.voiceWallet[field] = false;
  }
  game.magic.cooldown = 6;
  Game.prototype.toggleInfinitiveMagic.call(game, event);
  assert.equal(game.infinitiveMagic, true);
  assert.equal(game.magic.cooldown, 0);
  assert.match(notices.at(-1), /Infinitive Magic Mode enabled/);
  const wallet = JSON.stringify(game.voiceWallet.wallet);
  for (const spell of Object.keys(SPELLS)) {
    game.spell = spell;
    assert.equal(await Game.prototype.castMagic.call(game), true);
    assert.equal(game.magic.cooldown, 0);
  }
  assert.equal(requests, 0);
  assert.equal(JSON.stringify(game.voiceWallet.wallet), wallet);
  game.dodge.active = true;
  assert.equal(await Game.prototype.castMagic.call(game), false);
  game.dodge.active = false;
  game.traveling = true;
  assert.equal(await Game.prototype.castMagic.call(game), false);
  game.traveling = false;
  Game.prototype.toggleInfinitiveMagic.call(game, event);
  assert.equal(game.infinitiveMagic, false);
  assert.equal(await Game.prototype.castMagic.call(game), false);
  assert.equal(requests, 1);
  assert.ok(prevented >= 2);
  assert.match(main, /this\.infinitiveMagic = false/);
  const save = main.match(/  saveCheckpoint\(\) \{[\s\S]*?(?=\n  restoreCheckpoint)/)[0];
  assert.doesNotMatch(save, /infinitiveMagic/);
});

test('super monster nameplates show name and health, reuse textures and hide for ordinary or dead monsters', () => {
  const text = [], sprites = [];
  const ctx = { clearRect() {}, fillRect() {}, strokeRect() {}, fillText(value) { text.push(value); } };
  const document = { createElement: () => ({ getContext: () => ctx }) };
  const THREE = {
    CanvasTexture: class { constructor(image) { this.image = image; } },
    SpriteMaterial: class { constructor(options) { Object.assign(this, options); } },
    Sprite: class {
      constructor(material) {
        this.material = material; this.userData = {};
        this.position = { copy() {} }; this.scale = { set() {} };
        sprites.push(this);
      }
    },
  };
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const Attack = runInNewContext(main.match(/class EnemyAttackController[\s\S]*?(?=\nclass HealthComponent)/)[0] +
    '\nEnemyAttackController;', { document, THREE, entity: { Component: class {} } });
  const attack = new Attack({ scene: { add() {} } });
  attack._parent = { _position: {} };
  const controller = { elite: true, _target: { visible: true }, profile: { label: 'Frostpeak Titan' } };
  const health = { _health: 540, _maxHealth: 540, IsAlive() { return this._health > 0; } };
  attack.updateSuperLabel(controller, health);
  assert.ok(text.includes('SUPER MONSTER'));
  assert.ok(text.includes('Frostpeak Titan'));
  assert.ok(text.includes('540 / 540 HP'));
  const drawn = text.length;
  attack.updateSuperLabel(controller, health);
  assert.equal(text.length, drawn);
  health._health = 100;
  attack.updateSuperLabel(controller, health);
  assert.ok(text.includes('100 / 540 HP'));
  health._health = 0;
  attack.updateSuperLabel(controller, health);
  assert.equal(attack.superLabel.visible, false);
  health._health = 360; health._maxHealth = 360;
  controller.profile.label = 'Sunspire Overlord';
  attack.updateSuperLabel(controller, health);
  assert.equal(attack.superLabel.visible, true);
  assert.ok(text.includes('Sunspire Overlord'));
  assert.equal(sprites.length, 1);
  controller.elite = false;
  attack.updateSuperLabel(controller, health);
  assert.equal(attack.superLabel.visible, false);
});
