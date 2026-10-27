import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { AdventureProgress, DodgeMotion, WEAPONS, FINISHES } from '../v2/adventure.js';
import { CombatFeedback } from '../v2/feedback.js';
import { BOSS, CHESTS, SECRET_PATH, createScenery, isWalkable } from '../v2/layout.js';

function fixture() {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  const options = { storage, digest: async key => 'hashed-' + key };
  return { entries, options, progress: new AdventureProgress(options) };
}

test('weapons have meaningful damage and speed tradeoffs', () => {
  assert.ok(WEAPONS.Axe.damage > WEAPONS.Sword.damage);
  assert.ok(WEAPONS.Axe.speed < WEAPONS.Sword.speed);
  assert.ok(WEAPONS.Unarmed.damage < WEAPONS.Sword.damage);
  assert.ok(WEAPONS.Unarmed.speed > WEAPONS.Sword.speed);
});

test('AWS victories persist once per task, restore progress and unlock cosmetic finishes', async () => {
  const { progress, options } = fixture();
  await progress.selectAccount('student-a');
  assert.equal(progress.selectFinish('gold'), false);
  assert.equal(progress.pass('Vpc'), true);
  assert.equal(progress.pass('Vpc'), false);
  assert.equal(progress.unlocked('verdant'), true);
  progress.pass('S3'); progress.pass('Lambda');
  assert.equal(progress.selectFinish('gold'), true);
  const restored = new AdventureProgress(options);
  await restored.selectAccount('student-a');
  assert.deepEqual(restored.data.passed, ['Vpc', 'S3', 'Lambda']);
  assert.equal(restored.data.finish, 'gold');
  assert.equal(restored.unlocked('crystal'), false);
});

test('exploration and boss rewards are deduplicated cosmetics, not AWS victories', async () => {
  const { progress } = fixture();
  await progress.selectAccount(null);
  assert.equal(progress.openChest('forest-cache'), true);
  assert.equal(progress.openChest('forest-cache'), false);
  assert.equal(progress.selectFinish('verdant'), true);
  assert.equal(progress.defeatBoss(), true);
  assert.equal(progress.defeatBoss(), false);
  assert.equal(progress.selectFinish('crystal'), true);
  assert.equal(progress.selectFinish('not-a-finish'), false);
  assert.deepEqual(progress.data.passed, []);
});

test('account changes isolate rewards and marks reset removes old rewards and finishes', async () => {
  const { progress } = fixture();
  await progress.selectAccount('student-a');
  progress.pass('Vpc'); progress.openChest('forest-cache'); progress.defeatBoss();
  progress.selectFinish('crystal');
  await progress.selectAccount('student-b');
  assert.deepEqual(progress.data.passed, []);
  assert.deepEqual(progress.data.chests, []);
  assert.equal(progress.data.boss, false);
  await progress.selectAccount('student-a');
  assert.deepEqual(progress.data.passed, ['Vpc']);
  await progress.selectAccount('student-a', 'new-reset');
  assert.deepEqual(progress.data.passed, []);
  assert.deepEqual(progress.data.chests, []);
  assert.equal(progress.data.boss, false);
  assert.equal(progress.data.finish, 'plain');
});

test('a late account digest cannot restore another account over the current one', async () => {
  let finish;
  const progress = new AdventureProgress({
    storage: null, digest: key => key === 'old' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve('current'),
  });
  const stale = progress.selectAccount('old');
  assert.equal(await progress.selectAccount('new'), true);
  finish('stale');
  assert.equal(await stale, false);
  assert.ok(progress.scope.endsWith('current'));
});

test("one student's reset does not erase another account's saved adventure", async () => {
  const { progress } = fixture();
  await progress.selectAccount('a'); progress.pass('Vpc');
  await progress.selectAccount('b'); progress.pass('S3');
  const reset = JSON.stringify({ owner: 'hashed-a', stamp: 'new-reset' });
  await progress.selectAccount('a', reset);
  assert.deepEqual(progress.data.passed, []);
  await progress.selectAccount('b', reset);
  assert.deepEqual(progress.data.passed, ['S3']);
});

test('corrupt saved rewards, denied storage and unavailable crypto fail safely', async () => {
  const { progress, entries, options } = fixture();
  entries.set('aws-warrior:v2:adventure:hashed-a', '{broken');
  await progress.selectAccount('a');
  assert.deepEqual(progress.data.passed, []);
  entries.set(progress.scope, JSON.stringify({ reset: null, passed: ['Vpc', 'Vpc', 5], chests: null, finish: 'crystal' }));
  const restored = new AdventureProgress(options);
  await restored.selectAccount('a');
  assert.deepEqual(restored.data.passed, ['Vpc']);
  assert.equal(restored.data.finish, 'plain');
  const denied = new AdventureProgress({
    storage: { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Denied'); } },
    digest: async () => 'safe',
  });
  assert.equal(await denied.selectAccount('a'), true);
  assert.doesNotThrow(() => denied.pass('Vpc'));
  const noCrypto = new AdventureProgress({ storage: null, digest: async () => { throw new Error('Unavailable'); } });
  assert.equal(await noCrypto.selectAccount('a'), true);
  assert.equal(noCrypto.scope, null);
});

test('six real AWS victories unlock crystal without requiring optional combat', async () => {
  const { progress } = fixture();
  await progress.selectAccount('a');
  for (let i = 0; i < 6; i++) progress.pass('task-' + i);
  assert.equal(progress.unlocked('crystal'), true);
  assert.equal(progress.data.boss, false);
});

test('dodge is bounded, has invulnerability duration and cannot be spammed', () => {
  const dodge = new DodgeMotion();
  assert.equal(dodge.start({ x: 0, z: 0 }), false);
  assert.equal(dodge.start({ x: 1, z: 0 }), true);
  assert.equal(dodge.active, true);
  assert.equal(dodge.start({ x: 0, z: 1 }), false);
  let position = { x: 0, z: 0 };
  for (let i = 0; i < 3; i++) position = dodge.update(0.1, position, () => true);
  assert.ok(Math.abs(position.x - 7) < 0.001);
  assert.equal(dodge.active, false);
  assert.equal(dodge.start({ x: 1, z: 0 }), false);
  for (let i = 0; i < 20; i++) dodge.update(0.1, position, () => true);
  assert.equal(dodge.start({ x: 0, z: 1 }), true);
});

test('dodge uses small collision-checked steps and never tunnels across walls or long frames', () => {
  const dodge = new DodgeMotion();
  dodge.start({ x: 1, z: 0 });
  const position = dodge.update(10, { x: 0, z: 0 }, x => x < 1 || x > 2);
  assert.ok(position.x < 1);
  const before = dodge.remaining;
  dodge.update(NaN, position, () => true);
  assert.equal(dodge.remaining, before);
});

test('dodge checks each collision against the last accepted substep', () => {
  const dodge = new DodgeMotion();
  dodge.start({ x: 1, z: 0 });
  let accepted = { x: 0, z: 0 }, checks = 0;
  const position = dodge.update(0.1, accepted, (x, z, from) => {
    assert.deepEqual(from, accepted);
    checks++;
    if (x > 1) return false;
    accepted = { x, z };
    return true;
  });
  assert.equal(checks, 3);
  assert.deepEqual(position, { x: 0.8, z: 0 });
});

test('all optional rewards and the secret route are reachable on clear terrain', () => {
  const { trees } = createScenery();
  for (const point of [...CHESTS, BOSS]) {
    assert.ok(isWalkable(point.x + 4, point.z, 1.5, trees), point.id || point.name);
  }
  const [a, b] = SECRET_PATH;
  for (let i = 0; i <= 30; i++) {
    assert.ok(isWalkable(a.x + (b.x - a.x) * i / 30, a.z + (b.z - a.z) * i / 30, 1.5, trees));
  }
});

test('weapon model loads cannot race or reattach an unequipped stale weapon', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const source = main.match(/class EquipWeapon[\s\S]*?(?=\nclass InventoryController)/)[0];
  const loads = [], attached = [];
  const inventory = { GetItemByName: name => ({ GetComponent: () => ({ RenderParams: { name, scale: 0.25 } }) }) };
  const Component = runInNewContext(source + '\nEquipWeapon;', {
    FINISHES,
    THREE: { LoadingManager: class {} },
    FBXLoader: class { setPath() {} load(name, callback) { loads.push({ name, callback }); } },
    equip_weapon_component: { EquipWeapon: class {
      constructor(params) { this._params = params; this._name = null; }
      GetComponent() { return inventory; }
      _AttachTarget() { attached.push(this._target.name); this._target.parent = { remove() {} }; }
    } },
  });
  const weapon = new Component({ game: { progress: { data: { finish: 'plain' } } } });
  const model = name => ({
    name, disposed: false, scale: { setScalar() {} }, rotateX() {}, rotateY() {},
    traverse(callback) { callback({ geometry: { dispose: () => { this.disposed = true; } } }); },
  });
  weapon._OnEquip({ value: 'Sword' });
  weapon._OnEquip({ value: 'Axe' });
  const sword = model('Sword'), axe = model('Axe');
  loads[0].callback(sword);
  loads[1].callback(axe);
  assert.deepEqual(attached, ['Axe']);
  assert.equal(sword.disposed, true);
  weapon._OnEquip({ value: null });
  assert.equal(weapon._name, null);
  assert.equal(weapon._target, null);
  assert.equal(axe.disposed, true);
  weapon._OnEquip({ value: 'Sword' });
  weapon._OnEquip({ value: null });
  loads[2].callback(model('stale'));
  assert.deepEqual(attached, ['Axe']);
});

test('floating damage feedback is capped and expires without accumulating DOM nodes', () => {
  const previous = globalThis.document;
  let removed = 0;
  globalThis.document = { createElement: () => ({ style: {}, remove() { removed++; } }) };
  try {
    const feedback = new CombatFeedback({ appendChild() {} });
    const point = { x: 0, y: 1, z: 0, clone() { return { ...this }; } };
    for (let i = 0; i < 30; i++) feedback.show(point, '10');
    assert.equal(feedback.numbers.length, 24);
    assert.equal(removed, 6);
    feedback.update(1, () => ({ x: 0, y: 0, z: 0 }));
    assert.equal(feedback.numbers.length, 0);
    assert.equal(removed, 30);
  } finally { globalThis.document = previous; }
});

test('only successful current-account grading awards AWS progression', async () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const source = main.match(/  async grade\(\)[\s\S]*?(?=\n  returnHome\()/)[0];
  const entries = new Map([['api_key', 'a']]);
  const { progress } = fixture();
  await progress.selectAccount('a');
  let result = { isSuccess: false };
  const grade = runInNewContext('({' + source + '}).grade', {
    localStorage: { getItem: key => entries.get(key) ?? null }, MARKS_RESET_KEY: 'reset',
    document: { getElementById: () => ({}) }, URL,
  });
  const game = {
    api: { quest: { filter: 'Vpc' }, grading: false, gradeQuest: async () => result },
    progress, progressChanging: false, status() {}, sound: { play() {} }, showQuest() {}, updateAdventure() {},
  };
  await grade.call(game);
  assert.deepEqual(progress.data.passed, []);
  progress.defeatBoss();
  progress.selectFinish('crystal');
  result = { isSuccess: true };
  await grade.call(game);
  assert.deepEqual(progress.data.passed, ['Vpc']);
  assert.equal(progress.data.finish, 'crystal');
  game.api.gradeQuest = async () => { entries.set('api_key', 'b'); return result; };
  game.api.quest.filter = 'S3';
  await grade.call(game);
  assert.deepEqual(progress.data.passed, ['Vpc']);
});
