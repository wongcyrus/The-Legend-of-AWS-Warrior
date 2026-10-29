import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { MagicWallet, MagicCombat, SPELLS, spellDamage } from '../v2/magic.js';
import { MONSTERS, SUPER_MONSTERS, superMonsterProfile, monsterFor } from '../v2/monsters.js';
import { MAPS } from '../v2/maps.js';

const walletData = (balance = 20, revision = 1) => ({ balance, max: 100, earned: 100, spent: 100 - balance, revision });
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
        execute: pay => { if (!pay(SPELLS[spell].cost)) return false; effects++; return true; } });
    } };
}
const authorization = (request, wallet = walletData(9, 2)) => ({
  ...JSON.parse(request.body), cost: SPELLS[JSON.parse(request.body).spell].cost, wallet,
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
  assert.equal(h.wallet.wallet.balance, 20);
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

test('combined authorization retries the same selection and charges one payment before simultaneous effects', async () => {
  const posts = [];
  let effects = 0;
  const h = walletHarness(async (url, request) => {
    if (request.method === 'GET') return success(walletData(100));
    posts.push(JSON.parse(request.body));
    if (posts.length === 1) throw new TypeError('lost response');
    return success({ ...posts.at(-1), cost: 87, wallet: walletData(13, 2) });
  });
  await h.wallet.refresh();
  const run = spells => h.wallet.cast({ spells, valid: () => true,
    execute: pay => { assert.equal(pay(87), true); assert.equal(pay(87), false); effects++; return true; } });
  assert.equal(await run(Object.keys(SPELLS)), false);
  assert.equal(await run(['frost']), false);
  assert.equal(posts.length, 1);
  assert.equal(await run(Object.keys(SPELLS).reverse()), true);
  assert.deepEqual(posts[0], posts[1]);
  assert.equal(effects, 1);
  assert.equal(h.wallet.wallet.balance, 13);
});

test('combined combat reserves total cost once and retains all five effects with maximum cooldown', () => {
  const h = harness();
  const ids = Object.keys(SPELLS);
  let payments = 0;
  const pay = cost => { payments++; assert.equal(cost, 87); return true; };
  assert.equal(h.magic.castCombination(ids, 1, { x: 0, z: 0 }, { x: 0, z: 1 }, () => false), false);
  assert.equal(h.hits.length, 0);
  assert.equal(h.magic.castCombination(ids, 1, { x: 0, z: 0 }, { x: 0, z: 1 }, pay), true);
  assert.equal(payments, 1);
  assert.equal(h.magic.clones.length, 5);
  assert.equal(h.magic.fields.length, 2);
  assert.ok(h.magic.anchor);
  assert.equal(h.magic.cooldown, 60);
  assert.equal(h.magic.castCombination(ids, 1, { x: 0, z: 0 }, { x: 0, z: 1 }, pay), false);
  assert.equal(payments, 1);
});

test('deployment waves execute only when reaching targets within 128 units, respecting walls', () => {
  const targets = [{ id: 'ordinary', x: 0, z: 80 }, { id: 'boss', x: 128, z: 0, boss: true },
    { id: 'outside', x: 0, z: 128.01 }, { id: 'wall', x: -80, z: 0 }];
  const h = harness(targets), defeated = [];
  h.magic.clear = (from, target) => target.id !== 'wall';
  h.magic.waveClear = h.magic.clear;
  h.magic.defeat = target => defeated.push(target.id);
  h.magic.castCombination(Object.keys(SPELLS), 1, { x: 0, z: 0 }, { x: 0, z: 1 }, () => true);
  h.magic.update(0.69);
  assert.deepEqual(defeated, []);
  h.magic.update(0.01);
  assert.deepEqual(defeated, []);
  h.magic.update(0.6);
  assert.deepEqual(defeated, [], 'targets outside the expanding ring are not hit early');
  h.magic.update(0.16);
  assert.deepEqual(defeated, ['ordinary']);
  h.magic.update(0.46);
  assert.deepEqual(defeated, ['ordinary', 'boss']);
  h.magic.update(3.6);
  assert.equal(defeated.length, 6);
  assert.ok(defeated.every(id => ['ordinary', 'boss'].includes(id)));
  assert.equal(h.effects.filter(([kind]) => kind === 'release-wave').length, 12);
  assert.equal(h.magic.release, null);
  h.magic.cooldown = 0;
  h.magic.castCombination(Object.keys(SPELLS), 1, { x: 0, z: 0 }, { x: 0, z: 1 }, () => true);
  h.magic.clearProjectiles();
  h.magic.update(6);
  assert.equal(defeated.length, 6);
  h.magic.cooldown = 0;
  h.magic.castCombination(['lightning', 'frost'], 1, { x: 0, z: 0 }, { x: 0, z: 1 }, () => true);
  assert.equal(h.magic.release, null);
});

test('all immediate and delayed hits from a cast share one grading batch, but new casts get a fresh batch', () => {
  const h = harness();
  const batches = [];
  h.magic.damage = (target, value, batch) => batches.push(batch);
  h.magic.defeat = (target, batch) => batches.push(batch);
  h.magic.castCombination(Object.keys(SPELLS), 1, { x: 0, z: 0 }, { x: 0, z: 1 }, () => true);
  for (let i = 0; i < 8; i++) h.magic.update(1);
  assert.ok(batches.length > 10);
  assert.ok(batches.every(batch => batch === batches[0]));
  const previous = batches[0];
  h.magic.cooldown = 0;
  h.cast('lightning');
  assert.notEqual(batches.at(-1), previous);
});

test('a later kill from the same cast cannot repeat a completed or failed AJAX check', async () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', {
    localStorage: { getItem: () => 'same-account' }, MARKS_RESET_KEY: 'reset',
    document: { getElementById: () => ({}) }, URL,
  });
  let calls = 0;
  const game = { api: { quest: { filter: 'task' }, gradeQuest: async () => {
    calls++;
    if (calls === 2) throw new Error('network failure');
    return { isSuccess: false };
  } }, progress: { version: 1 }, status() {}, showQuest() {}, sound: { play() {} } };
  const first = {};
  await Game.prototype.grade.call(game, first);
  await Game.prototype.grade.call(game, first);
  assert.equal(calls, 1);
  const second = {};
  await Game.prototype.grade.call(game, second);
  await Game.prototype.grade.call(game, second);
  assert.equal(calls, 2);
  await Game.prototype.grade.call(game, {});
  await Game.prototype.grade.call(game);
  assert.equal(calls, 4, 'new spells and ordinary melee kills can retry');
});

test('late grader failures cannot overwrite a changed account or reset progress display', async () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  for (const change of ['account', 'reset', 'version', 'loading']) {
    const values = { api_key: 'first', reset: 'old' }, pending = deferred(), messages = [];
    const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', {
      localStorage: { getItem: name => values[name] }, MARKS_RESET_KEY: 'reset',
    });
    const game = { api: { quest: { filter: 'task' }, gradeQuest: () => pending.promise },
      progress: { version: 1 }, status: text => messages.push(text) };
    const request = Game.prototype.grade.call(game, {});
    if (change === 'account') values.api_key = 'second';
    if (change === 'reset') values.reset = 'new';
    if (change === 'version') game.progress.version++;
    if (change === 'loading') game.progressChanging = true;
    pending.reject(new Error('old request failed'));
    await request;
    assert.equal(messages.length, 1, change);
    assert.doesNotMatch(messages[0], /old request failed/);
  }
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
    if (request.method === 'GET') return success(walletData(12));
    requests.push(request);
    return response.promise;
  });
  await h.wallet.refresh();
  h.ready(false);
  assert.equal(await h.cast(), false);
  h.ready(true);
  assert.equal(await h.cast('frost', 3), false);
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
    assert.equal(h.wallet.wallet.balance, 20);
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
  assert.equal(h.magic.clones.length, 0);
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
  assert.equal(nodes['magic-cast'].disabled, true);
  voiceWallet.wallet = walletData(20);
  update();
  assert.equal(nodes['magic-cast'].disabled, false);
  assert.match(nodes['magic-cast'].textContent, /12 MP/);
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

test('five fixed-cost cloud arts replace legacy labels, preserving saved IDs and Power scaling', () => {
  assert.equal(Object.keys(SPELLS).length, 5);
  for (const [id, spell] of Object.entries(SPELLS)) {
    assert.match(spell.label, /・/);
    for (const level of [1, 2, 3]) {
      const h = harness();
      assert.equal(h.cast(id, level), true);
      assert.deepEqual(h.paid, [spell.cost]);
      assert.equal(h.magic.cooldown, spell.cooldown);
      assert.equal(h.cast(id), false);
      h.magic.update(spell.cooldown);
      assert.equal(h.cast(id), true);
      assert.equal(spellDamage(id, level, 100), spell.damage * 2);
    }
  }
  const html = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /data-magic-level|Choose I, II or III/);
});

test('invalid input, denied payments, directional misses, walls and three-target chain limits', () => {
  for (const id of ['__proto__', 'constructor', 'unknown']) assert.equal(harness().cast(id), false);
  for (const level of [0, 4, NaN, 1.5]) assert.equal(harness().cast('lightning', level), false);
  const h = harness();
  assert.equal(h.cast('fireball', 1, () => false), false);
  assert.equal(h.magic.cooldown, 0);
  assert.equal(h.magic.clones.length, 0);
  const targets = [{ id: 'a', x: 0, z: 8 }, { id: 'b', x: 2, z: 10 },
    { id: 'c', x: -3, z: 12 }, { id: 'behind', x: 0, z: -9 }];
  for (const level of [1, 2, 3]) {
    const chain = harness(targets);
    chain.cast('lightning', level);
    assert.equal(chain.hits.length, 3);
    assert.equal(new Set(chain.hits.map(hit => hit.id)).size, 3);
  }
  const miss = harness([{ id: 'behind', x: 0, z: -8 }]);
  assert.equal(miss.cast('lightning'), true);
  assert.equal(miss.hits.length, 0);
  assert.deepEqual(miss.paid, [12]);
  for (const id of Object.keys(SPELLS)) {
    const wall = harness();
    wall.block();
    wall.cast(id);
    wall.magic.update(2);
    assert.equal(wall.hits.length, 0, id);
  }
});

test('cloud arts have distinct persistent, delayed, chained and defensive behavior', () => {
  const targets = [{ id: 'front', x: 0, z: 8 }, { id: 'side', x: 8, z: 0 },
    { id: 'back', x: 0, z: -8 }];
  for (const id of Object.keys(SPELLS)) {
    const h = harness(targets);
    h.cast(id, 3);
    assert.deepEqual(h.paid, [SPELLS[id].cost]);
    assert.equal(h.cast(id === 'shockwave' ? 'lightning' : 'shockwave'), false);
    assert.deepEqual(h.paid, [SPELLS[id].cost]);
  }
  const distant = harness([{ id: 'far', x: 0, z: 39 }]);
  distant.cast('lightning');
  assert.deepEqual(distant.hits, [{ id: 'far', value: 320 }]);
  const chain = harness([{ id: 'a', x: 0, z: 8 }, { id: 'b', x: 1, z: 9 }, { id: 'c', x: 2, z: 10 }]);
  chain.cast('lightning', 3);
  assert.deepEqual(chain.hits.map(hit => hit.value), [320, 160, 80]);
  const blast = harness([{ id: 'a', x: 0, z: 8 }, { id: 'b', x: 3, z: 8 }]);
  blast.cast('fireball');
  blast.magic.update(1);
  assert.ok(blast.hits.length >= 3);
  assert.ok(blast.hits.every(hit => hit.value === 60));
  const frost = harness([...targets, { id: 'approaching', x: 0, z: 17 }]);
  frost.cast('frost');
  assert.equal(frost.hits.length, 0);
  for (let i = 0; i < 6; i++) frost.magic.update(1);
  assert.equal(frost.hits.filter(hit => hit.id === 'front').reduce((sum, hit) => sum + hit.value, 0), 600);
  assert.equal(frost.hits.some(hit => hit.id === 'approaching'), false);
  assert.equal(frost.slows.length, 18);
  assert.equal(frost.magic.fields.length, 0);
  const storm = harness([...targets, { id: 'spread', x: 14, z: 0 }]);
  storm.cast('storm');
  storm.magic.update(0.1);
  assert.equal(storm.hits.length, 3);
  storm.magic.update(0.1);
  assert.equal(storm.hits.length, 3, 'ward cannot hit an intruder twice');
  assert.equal(storm.magic.incomingDamage(21, { x: 0, z: 0 }, 100, 100), 11);
  assert.equal(storm.magic.incomingDamage(21, { x: 20, z: 0 }, 100, 100), 21);
  assert.equal(storm.pushes.length, 3);
  const escape = harness([...targets, { id: 'far', x: 14, z: 0 }]);
  escape.cast('shockwave');
  assert.equal(escape.hits.length, 0);
  assert.ok(escape.magic.anchor);
  assert.equal(escape.magic.cooldown, 60);
});

test('clones recheck living targets, reach and obstacles; fields and anchors clear safely on travel or death', () => {
  const targets = [{ id: 'a', x: 0, z: 8 }];
  const h = harness(targets);
  h.cast('fireball', 3);
  targets[0].z = 100;
  h.magic.update(3.2);
  assert.equal(h.hits.length, 0);
  assert.equal(h.magic.clones.length, 0);
  h.magic.update(60);
  targets[0].z = 8;
  h.cast('fireball');
  h.magic.cooldown = 0;
  h.cast('frost');
  h.magic.cooldown = 0;
  h.cast('shockwave');
  h.magic.clearProjectiles();
  assert.equal(h.magic.clones.length, 0);
  assert.equal(h.magic.fields.length, 0);
  assert.equal(h.magic.anchor, null);
  h.magic.update(5);
  assert.equal(h.hits.length, 0);
  const cooldown = h.magic.cooldown;
  h.magic.update(NaN);
  h.magic.update(-1);
  assert.equal(h.magic.cooldown, cooldown);
});

test('army always spawns five forward shadows with three strikes each, including empty casts', () => {
  const h = harness([]);
  h.cast('fireball');
  const shadows = [...h.magic.clones];
  assert.equal(shadows.length, 5);
  h.magic.update(3.2);
  assert.ok(shadows.every(shadow => shadow.strikes === 3 && shadow.done && shadow.z > 20));
  assert.equal(h.effects.filter(([kind]) => kind === 'seal').length, 15);
  assert.equal(h.magic.clones.length, 0);
  const blocked = harness();
  blocked.block();
  blocked.cast('fireball');
  const stopped = [...blocked.magic.clones];
  blocked.magic.update(3.2);
  assert.ok(stopped.every(shadow => shadow.z < 5));
  assert.equal(blocked.hits.length, 0);
});

test('recovery requires windup, catches one low-HP or lethal hit, expires and fails closed at blocked anchors', () => {
  const h = harness();
  const recalls = [];
  h.magic.recover = (anchor, health) => { recalls.push({ anchor, health }); return true; };
  h.cast('shockwave');
  assert.equal(h.magic.incomingDamage(200, { x: 5, z: 5 }, 100, 100), 200);
  h.magic.update(1);
  assert.equal(h.magic.incomingDamage(10, { x: 5, z: 5 }, 100, 100), 10);
  assert.equal(h.magic.incomingDamage(200, { x: 5, z: 5 }, 100, 100), 0);
  assert.equal(recalls[0].health, 35);
  assert.equal(recalls[0].anchor.x, 0);
  assert.equal(h.magic.anchor, null);
  assert.equal(h.magic.incomingDamage(200, { x: 5, z: 5 }, 35, 100), 200);
  h.magic.update(60);
  h.cast('shockwave');
  h.magic.update(13);
  assert.equal(h.magic.anchor, null);
  h.magic.update(60);
  h.cast('shockwave');
  h.magic.update(1);
  h.magic.canWalk = () => false;
  assert.equal(h.magic.incomingDamage(200, { x: 5, z: 5 }, 100, 100), 200);
  h.magic.canWalk = () => true;
  h.magic.recover = () => false;
  assert.equal(h.magic.incomingDamage(200, { x: 5, z: 5 }, 100, 100), 200);
});

test('domain applies shorter boss control and ward expires without leaving protection', () => {
  const h = harness([{ id: 'boss', x: 0, z: 8, boss: true }]);
  h.cast('frost');
  h.magic.update(1);
  assert.equal(h.slows[0].duration, 0.25);
  h.magic.clearProjectiles();
  h.magic.cooldown = 0;
  h.cast('storm');
  h.magic.update(1);
  assert.equal(h.pushes[0].distance, 1);
  h.magic.update(8);
  assert.equal(h.magic.incomingDamage(20, { x: 0, z: 0 }, 100, 100), 20);
});

test('each expedition upgrades its last spawn without changing ordinary models or base stats', () => {
  for (const map of Object.values(MAPS).filter(map => map.id !== 'village')) {
    const name = monsterFor(map.id, map.enemies.length - 1);
    const profile = superMonsterProfile(name, map.id);
    assert.equal(profile.label, SUPER_MONSTERS[map.id].label);
    assert.ok(profile.health > MONSTERS[name].health);
    assert.ok(profile.damage > MONSTERS[name].damage);
    assert.equal(profile.scale, MONSTERS[name].scale * 1.65 * 2);
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
  assert.match(main, /target\.actor\.Broadcast\(\{ topic: "health.damage", value, attacker: this.player, gradingBatch \}\)/);
  assert.match(main, /event.code === "KeyX"[\s\S]*?!event.repeat[\s\S]*?castMagic/);
  assert.match(main, /controller\.magicSlow = 0/);
});

test('cloud art visuals reduce detail, expire, remain bounded and dispose shared materials once', () => {
  class Resource {
    constructor(options) { Object.assign(this, options); this.disposed = 0; }
    dispose() { this.disposed++; }
    clone() { return new Resource({ ...this, disposed: 0 }); }
    setFromPoints() { return this; }
  }
  class Object3D {
    constructor(geometry, material) {
      Object.assign(this, { geometry, material, rotation: {}, position: { set() {} }, scale: { setScalar() {} } });
      this.children = [];
    }
    add(item) { this.children.push(item); }
    traverse(fn) { fn(this); this.children.forEach(item => item.traverse(fn)); }
  }
  const scene = { add(object) { object.parent = this; }, remove(object) { object.parent = null; } };
  const THREE = {
    MeshBasicMaterial: Resource, LineBasicMaterial: Resource, BufferGeometry: Resource,
    SphereGeometry: Resource, RingGeometry: Resource, TubeGeometry: Resource,
    BoxGeometry: Resource, OctahedronGeometry: Resource,
    CatmullRomCurve3: class {}, Mesh: Object3D, Line: Object3D, Group: Object3D,
    Vector3: class {}, DoubleSide: 2, AdditiveBlending: 2,
  };
  const source = readFileSync(new URL('../v2/magic-effects.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace('export class', 'class');
  const MagicEffects = runInNewContext(source + '\nMagicEffects;', { THREE, SPELLS });
  const effects = new MagicEffects(scene);
  const from = { x: 0, z: 0 }, to = { x: 0, z: 5, range: 10 };
  for (const id of ['lightning', 'domain', 'ward', 'clone', 'anchor', 'recall', 'seal', 'cast'])
    effects.spawn(id, from, { ...to, duration: 2 });
  const objects = [], resources = new Set();
  for (const effect of effects.active) {
    objects.push(effect.object);
    effect.object.traverse(item => {
      if (item.geometry) resources.add(item.geometry);
      if (item.material) resources.add(item.material);
    });
  }
  effects.update(3);
  assert.equal(effects.active.length, 0);
  for (const object of objects) assert.equal(object.parent, null);
  for (const resource of resources) assert.equal(resource.disposed, 1);
  for (let i = 0; i < 45; i++) effects.spawn('domain', { x: 0, z: 0 }, to, 1);
  assert.equal(effects.active.length, 40);
  effects.clear();
  assert.equal(effects.active.length, 0);

  effects.spawn('domain', from, to);
  const reduced = new MagicEffects(scene, { low: () => true });
  reduced.spawn('domain', from, to);
  assert.ok(reduced.active[0].object.children.length < effects.active[0].object.children.length);
  effects.update(NaN);
  assert.equal(effects.active[0].age, 0);
  effects.clear();
  reduced.clear();
});

test('game casts are server-reserved even when old testing flags are supplied', async () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', {
    document: { querySelector: () => false, getElementById: () => null }, SPELLS,
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
    guard: { release() {} }, sound: { play() {}, speakAttack() {} }, updateMagicUI() {}, magicStatus() {},
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
    document: { querySelector: () => dialog, getElementById: () => null }, SPELLS,
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
    guard: { release() {} }, sound: { play() {}, speakAttack() {} }, updateMagicUI() {}, magicStatus: message => notices.push(message),
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

test('setupMagic recovery rejects occupied anchors and castMagic reports empty spell selection', async () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const { findMovementBlockers } = await import('../v2/combat.js');
  const healthText = {};
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', {
    MagicEffects: class {},
    MagicCombat: class { constructor(options) { Object.assign(this, options); } },
    findMovementBlockers,
    THREE: { Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } } },
    document: { getElementById: () => healthText },
    matchMedia: () => ({ matches: false }),
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
  });
  const blocker = { _position: { x: 10, z: 10 }, GetComponent: () => ({ IsAlive: () => true }) };
  const controller = {
    _target: { position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; },
      clone: () => ({ add: () => ({}) }) } },
    _velocity: { set() {} },
  };
  const health = { _health: 10, _maxHealth: 100, _UpdateUI() {} };
  const notices = [];
  const game = {
    scene: {},
    grid: { FindNear: () => [{ entity: blocker }] },
    player: {
      _position: { x: 0, z: 0 },
      SetPosition() {},
      GetComponent: name => name === 'BasicCharacterController' ? controller : health,
    },
    dodge: { remaining: 0.2 },
    guard: { release() {} },
    feedback: { show() {} },
    sound: { play() {} },
    canCastMagic: () => true,
    selectedSpells: [],
    magicStatus: msg => notices.push(msg),
  };
  Game.prototype.setupMagic.call(game);
  assert.equal(game.magic.recover({ x: 10, z: 12 }, 35), false, 'occupied recovery anchor must fail closed');
  assert.equal(health._health, 10);
  blocker._position = { x: 25, z: 25 };
  assert.equal(game.magic.recover({ x: 10, z: 12 }, 35), true);
  assert.equal(health._health, 35);
  assert.equal(controller._target.position.x, 10);
  assert.equal(controller._target.position.z, 12);
  assert.equal(await Game.prototype.castMagic.call(game), false);
  assert.match(notices.at(-1), /Select at least one cloud art/);
});
