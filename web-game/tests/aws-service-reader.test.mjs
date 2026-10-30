import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { AWS_SERVICES, BUILDING_SERVICES } from '../v2/aws-theme.js';
import { bindServiceReader, loadReadServices } from '../v2/aws-service-reader.js';

test('individual service descriptions include practical examples and official links, without a catalog', () => {
  for (const service of Object.values(AWS_SERVICES)) {
    assert.ok(service.description.length >= 40);
    assert.ok(service.example.length >= 100);
    assert.ok(['aws.amazon.com', 'docs.aws.amazon.com'].includes(new URL(service.url).hostname));
  }
  for (const id of BUILDING_SERVICES) {
    assert.ok(AWS_SERVICES[id].description.length >= 100);
    assert.ok(AWS_SERVICES[id].example.length >= 100);
    assert.ok(AWS_SERVICES[id].benefit.length >= 100);
  }
  const html = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const world = readFileSync(new URL('../v2/aws-world.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /catalog-|All services|service-grid|block-button/);
  assert.doesNotMatch(main + world, /AWS_GALLERIES|loadGalleryImages|galleryImagesReady|bindCatalog|hologram/);
  assert.doesNotMatch(world, /RingGeometry/);
  assert.match(html, /id="service-example"/);
  assert.doesNotMatch(html, /id="service-read"|Mark as read/);
  assert.match(html, /id="service-explain"/);
  assert.match(main, /if \(this\.readingService(?:\s*\|\||\))/);
  for (const name of ['aws-catalog.js', 'aws-catalog-data.js', 'aws-service-info.js']) {
    assert.equal(existsSync(new URL('../v2/' + name, import.meta.url)), false);
  }
});

test('read badges recover from corrupt or unavailable browser storage and reject unknown IDs', () => {
  const load = value => loadReadServices({ getItem: () => value });
  for (const value of [null, '{}', 'true', 'broken']) assert.equal(load(value).size, 0);
  assert.deepEqual([...load('["s3","s3","vpc","fake","__proto__","constructor"]')], ['s3', 'vpc']);
  assert.equal(loadReadServices({ getItem() { throw new Error('blocked'); } }).size, 0);
  assert.deepEqual([...load('["s3","ecs","cloudfront","rds","ecs","unknown"]')], ['s3', 'ecs', 'cloudfront', 'rds']);
});

test('icon clicks check current voice availability without marking completion from reading or scrolling', async () => {
  const previous = { document: globalThis.document, window: globalThis.window,
    localStorage: globalThis.localStorage, requestAnimationFrame: globalThis.requestAnimationFrame };
  const elements = new Map(), listeners = new Map(), values = new Map(), frames = [];
  class Element {
    constructor() {
      this.events = new Map(); this.style = {}; this.dataset = {}; this.scrollTop = 0;
      this.clientHeight = 100; this.scrollHeight = 300; this.textContent = '';
    }
    addEventListener(name, fn) { this.events.set(name, fn); }
    showModal() { this.open = true; }
    close() { this.open = false; this.events.get('close')?.(); }
    focus() { globalThis.document.activeElement = this; }
  }
  globalThis.document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    addEventListener(name, fn) { listeners.set(name, fn); },
    querySelector() { return [...elements.values()].find(element => element.open) || null; },
  };
  globalThis.window = { addEventListener() {} };
  globalThis.localStorage = { getItem: key => values.get(key) || null,
    setItem(key, value) { values.set(key, value); } };
  globalThis.requestAnimationFrame = fn => frames.push(fn);
  try {
    const get = id => document.getElementById(id);
    const canvas = new Element();
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
    const plaque = { visible: true, userData: { awsService: 'ecs', setRead(value) { this.serviceRead = value; } } };
    const hidden = { visible: false, userData: { awsService: 'vpc', setRead(value) { this.serviceRead = value; } } };
    const keys = { forward: true, space: true };
    const quest = { name: 'unchanged' };
    const voiceRequests = [];
    const availabilityRequests = [];
    let readingLocked = false;
    const game = { ready: true, guard: { release() {} }, player: { GetComponent: () => ({ _keys: keys }) },
      renderer: { domElement: canvas }, world: { servicePlaques: [plaque, hidden] }, api: { quest } };
    let target = plaque;
    bindServiceReader(game, {
      Vector2: class { set() {} },
      Raycaster: class {
        setFromCamera() {}
        intersectObjects(objects) { assert.deepEqual(objects, [plaque]); return target ? [{ object: target }] : []; }
      },
    }, { bindVoice: () => ({
      open: id => voiceRequests.push(id),
      async getAvailability(id) {
        availabilityRequests.push(id);
        return [
          { type: 'read_aloud', onCooldown: readingLocked },
          { type: 'question_answer', available: true, languages: ['en-US'], onCooldown: false },
        ];
      },
    }) });
    const event = { target: canvas, button: 0, pointerId: 1, clientX: 40, clientY: 40 };
    const click = () => { listeners.get('pointerdown')(event); listeners.get('pointerup')(event); frames.splice(0).forEach(fn => fn()); };
    listeners.get('pointermove')(event);
    assert.equal(canvas.style.cursor, 'pointer');
    assert.match(canvas.title, /Click to learn/);
    listeners.get('pointerdown')(event); listeners.get('pointerup')({ ...event, clientX: 60 });
    assert.equal(get('service-dialog').open, undefined);
    click();
    assert.equal(game.readingService, true);
    assert.deepEqual(keys, { forward: false, space: false });
    assert.equal(get('service-title').textContent, 'Amazon ECS');
    assert.equal(get('service-example').textContent, AWS_SERVICES.ecs.example);
    assert.equal(get('service-explain').hidden, false);
    assert.equal(get('service-explain').disabled, true);
    await Promise.resolve();
    assert.deepEqual(availabilityRequests, ['ecs']);
    assert.equal(get('service-explain').textContent, 'Available: Read aloud / Q&A');
    assert.equal(get('service-explain').disabled, false);
    get('service-explain').onclick();
    assert.deepEqual(voiceRequests, ['ecs']);
    voiceRequests.length = 0;
    assert.equal(elements.has('service-read'), false);
    assert.equal(game.readServices.size, 0);
    get('service-close').onclick();
    assert.equal(game.readingService, false);
    assert.equal(values.size, 0);
    click();
    get('service-content').scrollTop = 200;
    get('service-content').events.get('scroll')?.();
    assert.equal(game.readServices.size, 0);
    get('service-close').onclick();
    assert.equal(game.readingService, false);
    assert.equal(plaque.userData.serviceRead, undefined);
    assert.equal(values.size, 0);
    game.readServices.add('ecs');
    readingLocked = true;
    click();
    await Promise.resolve();
    assert.equal(get('service-explain').textContent, 'Available: Q&A');
    assert.equal(get('service-read-state').textContent, 'Read');
    assert.equal(get('service-explain').hidden, false);
    get('service-explain').onclick();
    assert.deepEqual(voiceRequests, ['ecs']);
    voiceRequests.length = 0;
    get('service-close').onclick();
    assert.equal(game.api.quest, quest);
    const missionClick = id => get('mission-services').events.get('click')({
      target: { closest: () => ({ dataset: { awsService: id } }) },
    });
    get('service-content').scrollHeight = 80;
    missionClick('route53'); frames.splice(0).forEach(fn => fn());
    assert.equal(get('service-title').textContent, 'Amazon Route 53');
    assert.equal(get('service-explain').hidden, false);
    globalThis.localStorage.setItem = () => { throw new Error('blocked'); };
    get('service-explain').onclick();
    assert.deepEqual(voiceRequests, ['route53']);
    voiceRequests.length = 0;
    assert.equal(game.readServices.has('route53'), false);
    assert.equal(game.readingService, true);
    missionClick('s3'); frames.splice(0).forEach(fn => fn());
    assert.equal(get('service-explain').hidden, false);
    get('service-explain').onclick();
    assert.deepEqual(voiceRequests, ['s3']);
    assert.equal(game.readServices.has('s3'), false);
    assert.equal(game.readingService, true);
    missionClick('__proto__');
    assert.equal(game.readingService, true);
    get('service-close').onclick();
    assert.equal(game.readingService, false);
    target = null;
    listeners.get('pointermove')(event);
    assert.equal(canvas.style.cursor, '');
    game.traveling = true;
    missionClick('iam');
    assert.equal(game.readingService, false);
    game.traveling = false;
    target = plaque;
    const container = get('container');
    const containerEvent = { target: container, button: 0, pointerId: 2, clientX: 40, clientY: 40 };
    listeners.get('pointerdown')(containerEvent);
    listeners.get('pointerup')(containerEvent);
    frames.splice(0).forEach(fn => fn());
    assert.equal(get('service-dialog').open, true);
    assert.equal(get('service-title').textContent, 'Amazon ECS');
    get('service-close').onclick();
    assert.equal(get('service-dialog').open, false);

    listeners.get('click')({
      target: { closest: selector => selector === '[data-aws-service]' ? { dataset: { awsService: 'dynamodb' } } : null },
    });
    frames.splice(0).forEach(fn => fn());
    assert.equal(get('service-dialog').open, true);
    assert.equal(get('service-title').textContent, 'Amazon DynamoDB');
    get('service-close').onclick();
  } finally { Object.assign(globalThis, previous); }
});
