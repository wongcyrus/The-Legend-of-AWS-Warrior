import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { SoundEffects } from '../v2/audio.js';
import { WEAPONS } from '../v2/adventure.js';

function fixture(initial = {}) {
  const entries = new Map(Object.entries(initial));
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  const parameter = () => ({
    value: 0,
    setValueAtTime(value) { this.value = value; },
    setTargetAtTime(value) { this.value = value; },
    exponentialRampToValueAtTime(value) { this.value = value; },
  });
  const node = () => ({
    gain: parameter(), frequency: parameter(), disconnected: false,
    connect() {}, disconnect() { this.disconnected = true; },
    start(time) { this.started = time; }, stop(time) { this.stopped = time; },
  });
  const sources = [];
  const source = () => { const result = node(); sources.push(result); return result; };
  const context = {
    state: 'suspended', currentTime: 10, sampleRate: 48000, destination: {},
    createGain: node, createOscillator: source, createBufferSource: source, createBiquadFilter: node,
    createBuffer: (_, length) => ({ getChannelData: () => new Float32Array(length) }),
    async resume() { this.state = 'running'; },
  };
  let created = 0;
  const sound = new SoundEffects({ storage, createContext: () => { created++; return context; } });
  return { sound, context, sources, storage, created: () => created };
}

test('sound does not create an audio context or autoplay before user interaction', async () => {
  const { sound, created } = fixture();
  assert.equal(sound.play('quest'), false);
  assert.equal(created(), 0);
  assert.equal(await sound.unlock(), true);
  assert.equal(await sound.unlock(), true);
  assert.equal(created(), 1);
});

test('all sound cues generate finite, short-lived audio sources and release their nodes', async () => {
  const { sound, sources } = fixture();
  await sound.unlock();
  for (const effect of ['step', 'swing', 'hit', 'hurt', 'death', 'quest', 'success', 'failure',
    'axe', 'punch', 'dodge', 'evade', 'equip', 'yeti', 'slam', 'cactus', 'spike', 'bat',
    'portal', 'chest', 'revive', 'hammer', 'block', 'guardBreak']) {
    const before = sources.length;
    assert.equal(sound.play(effect), true);
    assert.ok(sources.length > before, effect);
  }
  for (const source of sources) {
    assert.ok(Number.isFinite(source.started));
    assert.ok(source.stopped > source.started && source.stopped - source.started < 1);
    source.onended();
    assert.equal(source.disconnected, true);
  }
  assert.equal(sound.play('unknown'), false);
});

test('enemy cues are distance-attenuated and rate-limited without suppressing other sounds', async () => {
  const { sound, context } = fixture();
  await sound.unlock();
  const voices = [];
  sound.voice = (note, attenuation) => voices.push({ note, attenuation });
  assert.equal(sound.play('bat', 30), true);
  assert.ok(voices.every(voice => voice.attenuation === 0.5));
  assert.equal(sound.play('bat', 30), false);
  assert.equal(sound.play('spike', 30), true);
  context.currentTime += 0.4;
  assert.equal(sound.play('bat', 30), true);
  assert.equal(sound.play('bat', 60), false);
  assert.equal(sound.play('bat', NaN), false);
});

test('mute and volume affect the audio output and persist across game instances', async () => {
  const { sound, storage, context, sources } = fixture();
  await sound.unlock();
  sound.setVolume(0.25);
  assert.equal(sound.master.gain.value, 0.25);
  sound.setMuted(true);
  assert.equal(sound.master.gain.value, 0);
  assert.equal(sound.play('hit'), false);
  assert.equal(sources.length, 0);
  const restored = new SoundEffects({ storage, createContext: () => context });
  assert.equal(restored.muted, true);
  assert.equal(restored.volume, 0.25);
  sound.setMuted(false);
  assert.equal(sound.master.gain.value, 0.25);
  sound.setVolume(0);
  assert.equal(sound.play('quest'), false);
  sound.setVolume(2);
  assert.equal(sound.volume, 1);
  sound.setVolume(-1);
  assert.equal(sound.volume, 0);
  sound.setVolume(NaN);
  assert.equal(sound.volume, 0);
});

test('muted games do not initialize audio until unmuted', async () => {
  const { sound, created } = fixture({ 'aws-warrior:v2:sound-muted': 'true' });
  assert.equal(await sound.unlock(), false);
  assert.equal(created(), 0);
  sound.setMuted(false);
  assert.equal(await sound.unlock(), true);
});

test('first-gesture cues wait for audio resume and do not duplicate context resumes', async () => {
  const { sound, context, sources } = fixture();
  let resume;
  context.resume = () => new Promise(resolve => { resume = () => { context.state = 'running'; resolve(); }; });
  const first = sound.unlock();
  const second = sound.unlock();
  assert.equal(sound.play('quest'), true);
  assert.equal(sources.length, 0);
  resume();
  await Promise.all([first, second]);
  assert.equal(sources.length, 2);
  assert.equal(sound.pending.length, 0);
});

test('pausing a hidden game silences output without changing the saved mute preference', async () => {
  const { sound, storage } = fixture();
  await sound.unlock();
  sound.setPaused(true);
  assert.equal(sound.master.gain.value, 0);
  assert.equal(sound.play('success'), false);
  assert.equal(storage.getItem('aws-warrior:v2:sound-muted'), null);
  sound.setPaused(false);
  assert.equal(sound.master.gain.value, sound.volume);
});

test('footsteps track actual distance and ignore idle frames and teleports', () => {
  const { sound } = fixture();
  const cues = [];
  sound.play = effect => cues.push(effect);
  sound.step(1);
  sound.step(0);
  sound.step(1);
  assert.equal(cues.length, 0);
  sound.step(1);
  assert.deepEqual(cues, ['step']);
  sound.step(100);
  sound.step(2, true);
  assert.equal(cues.length, 1);
  sound.step(1, true);
  assert.deepEqual(cues, ['step', 'step']);
});

test('unsupported audio, storage denial, and resume failures do not break gameplay', async () => {
  const unsupported = new SoundEffects({ storage: null, createContext: null });
  assert.equal(unsupported.available, false);
  assert.equal(await unsupported.unlock(), false);
  assert.equal(unsupported.play('hit'), false);
  const denied = new SoundEffects({
    storage: { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Denied'); } },
    createContext: () => { throw new Error('No audio device'); },
  });
  assert.equal(denied.volume, 0.45);
  assert.doesNotThrow(() => denied.setMuted(true));
  denied.setMuted(false);
  assert.equal(await denied.unlock(), false);
  const { sound, context } = fixture();
  context.resume = async () => { throw new Error('Blocked'); };
  assert.equal(await sound.unlock(), false);
  assert.equal(sound.play('hit'), false);
  context.resume = async () => { context.state = 'running'; };
  assert.equal(await sound.unlock(), true);
});

test('attack sound plays once per actual swing, not once per animation frame', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const source = main.match(/class SoundComponent[\s\S]*?(?=\nclass Game)/)[0];
  const Component = runInNewContext(source + '\nSoundComponent;', {
    WEAPONS,
    entity: { Component: class { _RegisterHandler(topic, handler) { this.handler = handler; } } },
  });
  const cues = [];
  const component = new Component({ play: effect => cues.push(effect) });
  component.InitComponent();
  for (const [action, time] of [['idle', 0], ['attack', 0.01], ['attack', 0.3],
    ['attack', 0.7], ['attack', 0.01], ['idle', 0], ['attack', 0.02]]) {
    component.handler({ action, time });
  }
  assert.deepEqual(cues, ['swing', 'swing', 'swing']);
});

test('axe and unarmed attacks use different cues without repeating every frame', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const source = main.match(/class SoundComponent[\s\S]*?(?=\nclass Game)/)[0];
  const Component = runInNewContext(source + '\nSoundComponent;', {
    WEAPONS,
    entity: { Component: class { _RegisterHandler(topic, handler) { this.handler = handler; } } },
  });
  const cues = [];
  let weapon = 'Axe';
  const component = new Component({ play: effect => cues.push(effect) }, () => weapon);
  component.InitComponent();
  component.handler({ action: 'attack', time: 0.1 });
  component.handler({ action: 'attack', time: 0.4 });
  component.handler({ action: 'idle', time: 0 });
  weapon = 'Unarmed';
  component.handler({ action: 'attack', time: 0.1 });
  component.handler({ action: 'attack', time: 0.5 });
  assert.deepEqual(cues, ['axe', 'punch']);
});
