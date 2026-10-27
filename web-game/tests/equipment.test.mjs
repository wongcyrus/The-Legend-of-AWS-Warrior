import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { WEAPONS } from '../v2/adventure.js';
import { SHIELDS, ShieldGuard } from '../v2/shields.js';
import { findMeleeTargets } from '../v2/combat.js';
import { equipmentIcon, nextWeapon } from '../v2/equipment-ui.js';

test('all existing melee models and five shields are selectable, without adding bows or arrows', () => {
  assert.equal(Object.keys(WEAPONS).length, 15);
  assert.equal(Object.keys(SHIELDS).length, 5);
  for (const [name, weapon] of Object.entries(WEAPONS)) {
    assert.ok(weapon.damage > 0 && weapon.speed > 0);
    assert.ok((weapon.reach || 5) > 4);
    assert.doesNotMatch(name, /Bow|Arrow/);
    if (name !== 'Unarmed') {
      assert.ok(existsSync(new URL('../resources/weapons/FBX/' + name + '.fbx', import.meta.url)), name);
    }
  }
  for (const name of Object.keys(SHIELDS)) {
    assert.ok(existsSync(new URL('../resources/weapons/FBX/' + name + '.fbx', import.meta.url)), name);
  }
  assert.ok(WEAPONS.Dagger.speed > WEAPONS.Sword.speed);
  assert.ok(WEAPONS.Hammer_Double.damage > WEAPONS.Axe.damage);
  assert.ok(WEAPONS.Spear.reach > WEAPONS.Claymore.reach);
});

function guard() {
  const result = new ShieldGuard();
  result.equipped = result.held = true;
  return result;
}

test('new players equip a round shield after their inventory is populated', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const spawn = main.match(/  spawnPlayer\(\) \{[\s\S]*?(?=\n  spawnGuides)/)[0];
  assert.ok(spawn.indexOf('this.selectShield("Shield_Round")') > spawn.indexOf('topic: "inventory.add"'));
  const messages = [], buttons = Object.keys(SHIELDS).map(name => ({
    dataset: { shield: name }, setAttribute(key, value) { this[key] = value; },
  }));
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', {
    SHIELDS, document: { querySelectorAll() { return buttons; } },
  });
  const game = {
    guard: { release() {} },
    player: { Broadcast(message) { messages.push(message); } },
    sound: { play() {} },
  };
  assert.equal(Game.prototype.selectShield.call(game, 'Shield_Round'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ topic: 'inventory.shield', value: 'Shield_Round' }]);
  assert.equal(buttons[0]['aria-pressed'], 'true');
  assert.ok(buttons.slice(1).every(button => button['aria-pressed'] === 'false'));
});

test('equipment has accessible icon bars instead of dropdown menus', () => {
  const html = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /weapon-select|shield-select|equipment-panel/);
  assert.match(html, /id="weapon-bar"[^>]+role="group" aria-label="Equip a weapon"/);
  assert.match(html, /id="shield-bar"[^>]+role="group" aria-label="Equip a shield"/);
  for (const name of [...Object.keys(WEAPONS), ...Object.keys(SHIELDS), 'None']) {
    const icon = equipmentIcon(name);
    assert.match(icon, /<svg[^>]+aria-hidden="true"/);
    assert.match(icon, /<(?:path|circle)/);
    assert.doesNotMatch(icon, /undefined|NaN|script|https?:/);
  }
});

test('weapon cycling goes in both directions and wraps at either end', () => {
  const names = Object.keys(WEAPONS);
  assert.equal(nextWeapon(names, 'Sword', 1), 'Axe');
  assert.equal(nextWeapon(names, 'Axe', -1), 'Sword');
  assert.equal(nextWeapon(names, 'Scythe', 1), 'Sword');
  assert.equal(nextWeapon(names, 'Sword', -1), 'Scythe');
});

test('wheel cycles weapons with throttling, Shift zooms, and UI or modal scrolling never changes equipment', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  let time = 0, modal = false, alive = true, prevented = 0, accept = true, selections = 0;
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', {
    WEAPONS, nextWeapon, performance: { now: () => time },
    document: { querySelector: () => modal },
    THREE: { MathUtils: { clamp: (value, min, max) => Math.min(max, Math.max(min, value)) } },
  });
  const game = {
    ready: true, cameraDistance: 29, weapon: 'Sword',
    player: { GetComponent: () => ({ IsAlive: () => alive }) },
    selectWeapon(name) { selections++; if (accept) this.weapon = name; return accept; },
  };
  const scroll = (extra = {}) => Game.prototype.scrollEquipment.call(game, {
    deltaY: 100, target: { closest: () => false }, preventDefault() { prevented++; }, ...extra,
  });
  scroll();
  assert.equal(game.weapon, 'Axe');
  scroll();
  assert.equal(selections, 1);
  time = 200;
  scroll({ deltaY: -100 });
  assert.equal(game.weapon, 'Sword');
  scroll({ shiftKey: true });
  assert.equal(game.cameraDistance, 31);
  scroll({ shiftKey: true, deltaY: -10000 });
  assert.equal(game.cameraDistance, 18);
  scroll({ shiftKey: true, deltaY: 10000 });
  assert.equal(game.cameraDistance, 46);
  time = 400;
  const count = prevented;
  scroll({ target: { closest: () => true } });
  modal = true; scroll(); modal = false;
  alive = false; scroll(); alive = true;
  game.traveling = true; scroll(); game.traveling = false;
  game.progressChanging = true; scroll(); game.progressChanging = false;
  game.ready = false; scroll(); game.ready = true;
  scroll({ deltaY: 0 });
  assert.equal(prevented, count);
  assert.equal(selections, 2);
  accept = false; scroll();
  assert.equal(game.weapon, 'Sword');
  assert.equal(game.lastWeaponScroll, 200);
  accept = true; scroll();
  assert.equal(game.weapon, 'Axe');
});

const forward = { x: 0, z: 1 };
test('shields block frontal damage but leave the sides, back and unknown sources exposed', () => {
  const shield = guard();
  assert.equal(shield.block(12, { x: 0, z: 1 }, forward).damage, 0);
  assert.equal(shield.block(12, { x: 0.3, z: 1 }, forward).blocked, true);
  assert.equal(shield.block(12, { x: 0, z: -1 }, forward).damage, 12);
  assert.equal(shield.block(12, { x: 1, z: 0 }, forward).damage, 12);
  assert.equal(shield.block(12, null, forward).damage, 12);
  assert.equal(shield.block(12, { x: 0, z: 0 }, forward).damage, 12);
});

test('an unequipped, released or broken shield cannot provide invisible protection', () => {
  const shield = guard();
  shield.equipped = false;
  assert.equal(shield.block(12, forward, forward).blocked, false);
  shield.equipped = true;
  shield.release();
  assert.equal(shield.active, false);
  assert.equal(shield.block(12, forward, forward).damage, 12);
  shield.held = true;
  shield.broken = 1;
  assert.equal(shield.active, false);
});

test('heavy frontal blows break the guard, deal reduced damage and require a fresh block after recovery', () => {
  const shield = guard();
  assert.deepEqual(shield.block(22, forward, forward, true), { damage: 11, blocked: true, broken: true });
  assert.equal(shield.held, false);
  assert.equal(shield.active, false);
  assert.equal(shield.block(6, forward, forward).damage, 6);
  shield.update(1);
  assert.equal(shield.active, false);
  shield.update(1);
  assert.equal(shield.broken, 0);
  assert.equal(shield.active, false);
  shield.held = true;
  assert.equal(shield.active, true);
  assert.equal(shield.block(6, forward, forward).damage, 0);
});

test('weapon reach expands the broadphase and does not change standard sword range', () => {
  let size;
  const attacker = { _position: { x: 0, z: 0 } };
  const near = { entity: { _position: { x: 4.4, z: 0 } } };
  const far = { entity: { _position: { x: 8, z: 0 } } };
  const grid = { FindNear(position, dimensions) { size = dimensions; return [near, far]; } };
  assert.deepEqual(findMeleeTargets(grid, attacker), [near]);
  assert.deepEqual(findMeleeTargets(grid, attacker, WEAPONS.Spear.reach), [near, far]);
  assert.deepEqual(size, [17, 17]);
  assert.deepEqual(findMeleeTargets(grid, attacker, WEAPONS.Dagger.reach), [near]);
});

test('R key release clears blocking even when focus has moved into an input', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const source = main.match(/class BasicCharacterControllerInput[\s\S]*?(?=\nclass SpatialGridController)/)[0];
  const Input = runInNewContext(source + '\nBasicCharacterControllerInput;', {
    player_input: { BasicCharacterControllerInput: class { _onKeyUp() {} } },
  });
  const input = new Input(), shield = guard();
  input._params = { game: { guard: shield } };
  input._onKeyUp({ code: 'KeyR', target: { closest() { return true; } } });
  assert.equal(shield.active, false);
});
