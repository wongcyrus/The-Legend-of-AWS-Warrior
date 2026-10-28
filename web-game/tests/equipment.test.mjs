import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { WEAPONS } from '../v2/adventure.js';
import { SHIELDS, ShieldGuard } from '../v2/shields.js';
import { findMeleeTargets } from '../v2/combat.js';
import { equipmentIcon, nextWeapon } from '../v2/equipment-ui.js';
import { SPELLS, spellDamage } from '../v2/magic.js';

test('combat manual lists live weapon stats, all spell powers and shields, and pauses safely', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  const node = () => ({
    children: [], open: false, scrollTop: 99,
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    showModal() { this.open = true; },
  });
  const elements = Object.fromEntries(['manual-mode', 'manual-strength', 'manual-weapons',
    'manual-spells', 'manual-shields', 'combat-manual', 'manual-content'].map(id => [id, node()]));
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', {
    WEAPONS, SPELLS, spellDamage, SHIELDS,
    document: { getElementById: id => elements[id], createElement: node },
  });
  const keys = { forward: true, space: true };
  let power = 50, released = false;
  const game = {
    magicTesting: true, guard: { release() { released = true; } },
    player: { GetComponent: name => name === 'HealthComponent' ? { _params: { strength: power } } : { _keys: keys } },
  };
  Game.prototype.showCombatManual.call(game);
  const values = id => elements[id].children.map(row => row.children.map(cell => cell.textContent));
  const weapons = values('manual-weapons');
  assert.equal(weapons.length, 15);
  Object.entries(WEAPONS).forEach(([name, weapon], index) => {
    assert.deepEqual(weapons[index], [weapon.label,
      Math.round(power * (name === 'Unarmed' ? 1 : weapon.damage)),
      `${name === 'Unarmed' ? 1 : weapon.damage}x`, `${weapon.speed}x`, weapon.reach || 5, weapon.style]);
  });
  const spells = values('manual-spells');
  assert.equal(spells.length, 5);
  Object.values(SPELLS).forEach((spell, index) => {
    assert.equal(spells[index][0], spell.label);
    assert.equal(spells[index][1], [1, 2, 3].map(level => spell.damage * level).join(' / '));
    assert.equal(spells[index][2], [0, 1, 2].map(level => spell.range + level * 4).join(' / '));
    assert.equal(spells[index][3], `${spell.cooldown}s`);
    assert.ok(spells[index][4].length > 20);
    assert.equal(spells[index][5], `${spell.bestFor}. ${spell.tradeoff}`);
  });
  Object.values(SHIELDS).forEach(label => assert.ok(elements['manual-shields'].textContent.includes(label)));
  assert.match(elements['manual-mode'].textContent, /1 \/ 2 \/ 3 MP.*reserved on the server/);
  assert.doesNotMatch(elements['manual-mode'].textContent, /free|unlimited/i);
  assert.ok(released && !keys.forward && !keys.space && elements['combat-manual'].open);
  assert.equal(elements['manual-content'].scrollTop, 0);
  game.magicTesting = false; power = 80;
  Game.prototype.showCombatManual.call(game);
  assert.equal(values('manual-weapons').length, 15);
  assert.equal(values('manual-weapons')[0][1], 96);
  assert.equal(values('manual-spells')[0][1], '512 / 1024 / 1536');
  assert.match(elements['manual-mode'].textContent, /1 \/ 2 \/ 3 MP/);
  assert.match(main, /if \(this.readingService \|\| document.getElementById\("combat-manual"\).open\)/);
  assert.match(html, /id="manual-button"[^>]+aria-haspopup="dialog"/);
  assert.match(html, /id="combat-manual"[^>]+aria-labelledby="manual-title"/);
});

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
    saveCheckpoint() {},
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

test('equipment panel omits repeated controls and only shows active guard and dodge status', () => {
  const html = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  const hud = html.match(/<div class="v2-ui player-hud">[\s\S]*?(?=<footer)/)[0];
  assert.doesNotMatch(hud, /Hold R|Q:|Walk to|Click \/ scroll|equipped at start/);
  assert.doesNotMatch(html, /block-button/);
  assert.doesNotMatch(html, /id="(?:weapon-summary|magic-summary|magic-tactics|magic-help|magic-feedback)"/);
  assert.match(html, /<kbd>R<\/kbd> Block/);
  assert.match(html, /<kbd>Q<\/kbd> Dodge/);
  assert.match(html, /<kbd>T<\/kbd> Travel gate/);
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /block-button|blockButton/);
  const source = main.match(/    document.getElementById\("shield-state"\).textContent[\s\S]*?(?=\n    const chest =)/)[0];
  const elements = { 'shield-state': {}, 'dodge-state': {} };
  const update = runInNewContext('(function () {' + source + '\n})', {
    document: { getElementById: id => elements[id] },
  });
  const game = { guard: { active: false, broken: 0 }, dodge: { active: false, cooldown: 0 } };
  update.call(game);
  assert.equal(elements['shield-state'].hidden, true);
  assert.equal(elements['dodge-state'].hidden, true);
  game.guard.active = game.dodge.active = true;
  update.call(game);
  assert.equal(elements['shield-state'].textContent, 'Blocking');
  assert.equal(elements['shield-state'].hidden, false);
  assert.equal(elements['dodge-state'].hidden, false);
  game.guard.active = game.dodge.active = false;
  game.guard.broken = 1.5; game.dodge.cooldown = 0.8;
  update.call(game);
  assert.equal(elements['shield-state'].textContent, 'Guard broken: 1.5s');
  assert.equal(elements['dodge-state'].textContent, 'Dodge: 0.8s');
});

test('magic messages stay in the manual and cast tooltip instead of covering gameplay', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const elements = { 'magic-cast': {}, 'manual-cast-status': {} };
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', {
    document: { getElementById: id => elements[id] },
  });
  Game.prototype.magicStatus.call({}, 'Need 3 reading badges.');
  assert.equal(elements['magic-cast'].title, 'Need 3 reading badges.');
  assert.equal(elements['manual-cast-status'].textContent, 'Need 3 reading badges.');
});

test('weapon cycling goes in both directions and wraps at either end', () => {
  const names = Object.keys(WEAPONS);
  assert.equal(nextWeapon(names, 'Sword', 1), 'Axe');
  assert.equal(nextWeapon(names, 'Axe', -1), 'Sword');
  assert.equal(nextWeapon(names, 'Scythe', 1), 'Sword');
  assert.equal(nextWeapon(names, 'Sword', -1), 'Scythe');
});

test('wheel zooms, Shift cycles weapons with throttling, and UI or modal scrolling is untouched', () => {
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
  scroll({ shiftKey: true });
  assert.equal(game.weapon, 'Axe');
  scroll({ shiftKey: true });
  assert.equal(selections, 1);
  time = 200;
  scroll({ shiftKey: true, deltaY: -100 });
  assert.equal(game.weapon, 'Sword');
  scroll();
  assert.equal(game.cameraDistance, 31);
  scroll({ deltaY: -10000 });
  assert.equal(game.cameraDistance, 18);
  scroll({ deltaY: 10000 });
  assert.equal(game.cameraDistance, 46);
  assert.equal(game.weapon, 'Sword');
  assert.equal(selections, 2);
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
  accept = false; scroll({ shiftKey: true });
  assert.equal(game.weapon, 'Sword');
  assert.equal(game.lastWeaponScroll, 200);
  accept = true; scroll({ shiftKey: true });
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
