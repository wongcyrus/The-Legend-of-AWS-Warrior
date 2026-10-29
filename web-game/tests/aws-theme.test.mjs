import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { AWS_SERVICES, BUILDING_SERVICES, CLOUD_REGIONS, AWS_LANDMARKS, missionServices, plaqueObscuresPlayer } from '../v2/aws-theme.js';
import { MAPS, isMapWalkable } from '../v2/maps.js';
import { BUILDINGS, CHESTS, BOSS, isWalkable } from '../v2/layout.js';
import { disposeMap } from '../v2/map-lifecycle.js';

test('AWS world themes cover existing buildings and all gate destinations without altering map layouts', () => {
  assert.equal(BUILDING_SERVICES.length, BUILDINGS.length);
  assert.equal(new Set(BUILDING_SERVICES).size, 6);
  for (const id of BUILDING_SERVICES) assert.ok(AWS_SERVICES[id]);
  for (const map of Object.values(MAPS)) {
    assert.ok(AWS_SERVICES[CLOUD_REGIONS[map.id].service]);
    for (const gate of map.gates) assert.ok(CLOUD_REGIONS[gate.to]);
  }
});

test('discovery and gate panels face the camera on every map without rotating wall plaques', () => {
  const source = readFileSync(new URL('../v2/world.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export class World', 'class World');
  const World = runInNewContext(source + '\nWorld;', { plaqueObscuresPlayer: () => false });
  const panel = landmark => ({
    rotation: { x: 0, y: 0.3, z: 0 }, userData: { awsLandmark: landmark, awsWidth: 6 },
    getWorldPosition(point) { Object.assign(point, { x: 5, y: 4.6, z: 8 }); },
    matrixWorld: { getMaxScaleOnAxis: () => 1 },
  });
  const sign = panel('s3'), wall = panel(null), gate = panel(null), scene = {};
  gate.parent = scene;
  const world = { scene, servicePlaques: [sign, wall, gate], plaquePoint: {}, animated: [], detail: {}, map: { limit: 165 } };
  for (const map of Object.values(MAPS)) {
    world.map = map;
    for (const [x, z] of [[5, 28], [25, 8], [5, -12], [-15, 8], [20, 20]]) {
    World.prototype.update.call(world, 0, { x: 0, z: 0 }, { position: { x, y: 35, z } });
    const dx = x - 5, dz = z - 8, length = Math.hypot(dx, dz);
    assert.ok(Math.abs(Math.sin(sign.rotation.y) - dx / length) < 1e-10);
    assert.ok(Math.abs(Math.cos(sign.rotation.y) - dz / length) < 1e-10);
    assert.equal(sign.rotation.x, 0);
    assert.equal(sign.rotation.z, 0);
    assert.equal(wall.rotation.y, 0.3);
    assert.equal(gate.rotation.y, sign.rotation.y);
    }
  }
});

test('AWS landmarks span every map away from gates, walls and existing interactions', () => {
  const discoveries = Object.values(AWS_LANDMARKS).flat().map(point => point.service);
  assert.equal(discoveries.length, 302);
  assert.equal(new Set(discoveries).size, discoveries.length, 'no repeated discoveries within or between maps');
  assert.deepEqual(new Set(discoveries), new Set(Object.keys(AWS_SERVICES)), 'every service is discoverable');
  for (const map of Object.values(MAPS)) {
    const landmarks = AWS_LANDMARKS[map.id];
    assert.ok(landmarks.length >= 30 && landmarks.length < 130);
    assert.ok(new Set(landmarks.map(point => point.service)).size >= 5);
    assert.ok(Math.max(...landmarks.map(point => point.z)) - Math.min(...landmarks.map(point => point.z)) > 150);
    for (const point of landmarks) {
      assert.ok(AWS_SERVICES[point.service]);
      assert.ok(point.label);
      assert.ok(isMapWalkable(map, point.x, point.z, 7), `${map.id}: ${point.label}`);
      if (map.id === 'village') assert.ok(isWalkable(point.x, point.z, 7));
      for (const target of [...map.gates, ...map.guides, ...(map.id === 'village' ? [...CHESTS, BOSS] : [])]) {
        assert.ok(Math.hypot(target.x - point.x, target.z - point.z) > 12);
      }
      for (const [x, z] of map.enemies) assert.ok(Math.hypot(x - point.x, z - point.z) > 12);
      for (const other of landmarks) if (point !== other) {
        assert.ok(Math.hypot(point.x - other.x, point.z - other.z) >= 12, `${map.id}: overlapping signs`);
      }
    }
  }
  const rooms = AWS_LANDMARKS.dungeon.map(({ x, z }) =>
    `${Math.round(x / 96)},${Math.round(z / 96)}`);
  assert.equal(new Set(rooms).size, 9);
  const world = readFileSync(new URL('../v2/world.js', import.meta.url), 'utf8');
  assert.equal((world.match(/buildServiceLandmarks\(this\)/g) || []).length, 2);
  assert.doesNotMatch(world, /type === "hologram"/);
});

test('every map builds only small individual AWS signs and safely disposes shared resources', () => {
  const source = readFileSync(new URL('../v2/aws-world.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
  class Owned {
    constructor(...args) { this.args = args; this.disposals = 0; this.events = new Map(); }
    addEventListener(name, callback) { this.events.set(name, callback); }
    dispose() { this.disposals++; this.events.get('dispose')?.(); }
  }
  class Material extends Owned {
    constructor(options) { super(); Object.assign(this, options); }
  }
  class Node {
    constructor() {
      this.children = []; this.userData = {}; this.rotation = {};
      this.position = { set(x, y, z) { Object.assign(this, { x, y, z }); } };
      this.scale = { setScalar(value) { this.value = value; } };
    }
    add(child) { this.children.push(child); child.parent = this; }
    remove(child) { this.children.splice(this.children.indexOf(child), 1); child.parent = null; }
    traverse(fn) { fn(this); this.children.forEach(child => child.traverse(fn)); }
  }
  const ctx = new Proxy({}, { get: (target, key) => target[key] || (() => {}) });
  const build = runInNewContext(source + '\nbuildServiceLandmarks;', {
    AWS_SERVICES, AWS_LANDMARKS, BUILDING_SERVICES, CLOUD_REGIONS,
    Image: class { set src(value) { this.onerror(); } },
    setTimeout() { return 1; }, clearTimeout() {},
    document: { createElement: () => ({ getContext: () => ctx }) },
    THREE: {
      BoxGeometry: Owned, PlaneGeometry: Owned,
      MeshBasicMaterial: Material,
      CanvasTexture: class extends Owned { constructor() { super(); this.isTexture = true; } },
    },
  });
  for (const map of Object.values(MAPS)) {
    const scene = new Node(), meshes = [];
    const world = {
      map, scene, servicePlaques: [], animated: [],
      material: (color, options) => new Material({ color, ...options }),
      mesh(geometry, material, x, y, z, parent = scene) {
        const mesh = new Node();
        Object.assign(mesh, { geometry, material });
        mesh.position.set(x, y, z);
        parent.add(mesh);
        meshes.push(mesh);
        return mesh;
      },
    };
    build(world);
    const landmarks = scene.children.filter(object => object.userData.awsLandmark);
    assert.equal(landmarks.length, AWS_LANDMARKS[map.id].length);
    assert.equal(world.servicePlaques.length, landmarks.length);
    assert.equal(world.animated.length, 0);
    assert.equal(meshes.length, landmarks.length * 2);
    assert.ok(landmarks.every(object => object.position.y === 4.6 && object.geometry.args[0] === 6));
    for (const sign of landmarks) {
      const post = meshes.find(object => object !== sign &&
        object.position.x === sign.position.x && object.position.z === sign.position.z);
      assert.ok(post, `${map.id}: sign has a centered support post`);
      const postTop = post.position.y + post.geometry.args[1] / 2;
      const panelBottom = sign.position.y - sign.geometry.args[1] / 2;
      assert.ok(postTop < panelBottom, `${map.id}: support stays below the rotating icon panel`);
    }
    assert.equal(world.servicePlaques.filter(plaque => plaque.userData.awsService).length, landmarks.length);
    assert.equal(world.servicePlaques.filter(plaque => plaque.userData.awsGallery).length, 0);
    const resources = new Set(meshes.flatMap(mesh => [mesh.geometry, mesh.material, mesh.material.map]).filter(Boolean));
    disposeMap(scene, { geometries: new Set(), materials: new Set(), textures: new Set() });
    for (const resource of resources) assert.equal(resource.disposals, 1);
    assert.equal(scene.children.length, 0);
  }
});

test('service badges use explicit service names, including CamelCase task identifiers, not broad category guesses', () => {
  for (const [name, id] of [
    ['Tests.Network.CreateVpc', 'vpc'], ['Tests.S3.CreateBucket', 's3'], ['Tests.EC2.RunInstance', 'ec2'],
    ['Tests.IAM.CreateRole', 'iam'], ['Tests.CreateLambda', 'lambda'], ['Tests.CreateDynamoDBTable', 'dynamodb'],
  ]) assert.deepEqual(missionServices({ name }), [id], name);
  assert.deepEqual(missionServices({ instruction: 'Amazon S3 with AWS IAM and Amazon VPC.' }), ['s3', 'iam', 'vpc']);
  assert.deepEqual(missionServices({ instruction: 'Create a bucket, a database and a role.' }), []);
  assert.deepEqual(missionServices({ name: 'ClaimsNotServices3', instruction: 'VPCache lambdas' }), []);
  assert.deepEqual(missionServices({ instruction: 'Build a virtual private cloud.' }), ['vpc']);
  assert.deepEqual(missionServices(null), []);
  assert.deepEqual(missionServices({ name: {}, instruction: null }), []);
});

test('official AWS PNG assets are local, small and separately attributed rather than marked CC0', () => {
  let total = 0;
  for (const service of Object.values(AWS_SERVICES)) {
    assert.match(service.icon, /^\.\/v2\/assets\/aws\/(?:services\/)?[a-z0-9-]+\.png$/);
    const bytes = readFileSync(new URL('../' + service.icon.slice(2), import.meta.url));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    total += bytes.length;
  }
  assert.ok(total < 5000000);
  const notice = readFileSync(new URL('../v2/assets/aws/NOTICE.txt', import.meta.url), 'utf8');
  assert.match(notice, /not covered by this project's license/);
  assert.match(notice, /does not imply AWS/);
  const html = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  assert.match(html, /AWS MISSION/);
  assert.match(html, /v2\/assets\/aws\/NOTICE.txt/);
});

test('all official service-icon entries map to one discoverable identity without duplicate badges', () => {
  const manifest = JSON.parse(readFileSync(new URL('../v2/assets/aws/service-manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.length, 305);
  assert.equal(new Set(manifest.map(entry => entry.archivePath)).size, 305);
  assert.deepEqual(new Set(manifest.map(entry => entry.service)), new Set(Object.keys(AWS_SERVICES)));
  const idsFor = name => new Set(manifest.filter(entry => entry.archivePath.includes(name)).map(entry => entry.service));
  assert.equal(idsFor('AWS-Marketplace').size, 1);
  assert.equal(idsFor('AWS-Compute-Optimizer').size, 1);
  assert.equal(idsFor('Amazon-Kinesis-Video-Streams').size, 1);
  for (const entry of manifest) {
    assert.equal(entry.icon, AWS_SERVICES[entry.service].icon);
    assert.match(entry.archivePath, /\/64\/Arch_.*_64@5x\.png$/);
  }
});

test('late icon loads redraw live plaques but never disposed map textures', async () => {
  const source = readFileSync(new URL('../v2/aws-world.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
  const requests = [], timers = [], textures = [], draws = [];
  const context = {
    AWS_SERVICES, AWS_LANDMARKS, BUILDING_SERVICES, CLOUD_REGIONS,
    document: { createElement: () => ({ getContext: () => new Proxy({}, {
      get: (target, key) => target[key] || ((...args) => { if (key === 'drawImage') draws.push(args); }),
    }) }) },
    Image: class { set src(value) { this.url = value; requests.push(this); } },
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    THREE: {
      CanvasTexture: class {
        constructor() { textures.push(this); }
        addEventListener(name, fn) { this.onDispose = fn; }
      },
      MeshBasicMaterial: class { constructor(options) { Object.assign(this, options); } },
      PlaneGeometry: class {},
    },
  };
  const { servicePlaque, loadServiceImages } = runInNewContext(source + '\n({ servicePlaque, loadServiceImages });', context);
  const world = { mesh(geometry, material) { return { geometry, material, rotation: {}, userData: {} }; } };
  servicePlaque(world, {}, 'aws-compute-optimizer', {});
  servicePlaque(world, {}, 'aws-compute-optimizer', {});
  assert.equal(requests.length, 1, 'one download shared by plaques');
  textures.forEach(texture => { texture.needsUpdate = false; });
  textures[0].onDispose();
  const pending = loadServiceImages(['aws-compute-optimizer']);
  timers.forEach(fn => fn());
  await pending;
  assert.equal(draws.length, 0);
  requests[0].onload();
  assert.equal(draws.length, 1);
  assert.equal(textures[0].needsUpdate, false);
  assert.equal(textures[1].needsUpdate, true);
});

test('foreground service signs hide when they would obstruct the player, not when behind or beside them', () => {
  const camera = { x: 0, y: 10, z: 20 }, player = { x: 0, y: 0, z: 0 };
  assert.equal(plaqueObscuresPlayer({ x: 0, y: 7, z: 10 }, 9, camera, player), true);
  assert.equal(plaqueObscuresPlayer({ x: 20, y: 7, z: 10 }, 9, camera, player), false);
  assert.equal(plaqueObscuresPlayer({ x: 0, y: 4, z: -10 }, 9, camera, player), false);
  assert.equal(plaqueObscuresPlayer({ x: 0, y: 11, z: 25 }, 9, camera, player), false);
  assert.equal(plaqueObscuresPlayer({ x: 0, y: 7, z: 10 }, 9, { x: 0, y: 4, z: 0 }, player), false);
});

test('AWS plaques fall back to text on image errors, remain map-owned, and release canvas textures on travel', async () => {
  const source = readFileSync(new URL('../v2/aws-world.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
  const calls = [], owned = [];
  const ctx = new Proxy({}, { get: (target, key) => target[key] || ((...args) => calls.push([key, ...args])) });
  const canvas = { getContext: () => ctx };
  let requests = 0, cleared = 0;
  const { servicePlaque, loadServiceImages } = runInNewContext(source + '\n({ servicePlaque, loadServiceImages });', {
    AWS_SERVICES, AWS_LANDMARKS, BUILDING_SERVICES, CLOUD_REGIONS,
    document: { createElement: () => canvas },
    setTimeout() { return 1; }, clearTimeout() { cleared++; },
    Image: class {
      set src(url) { requests++; if (url.endsWith('/s3.png')) this.onload(); else this.onerror(); }
    },
    THREE: {
      sRGBEncoding: 3001, DoubleSide: 2,
      CanvasTexture: class {
        constructor(image) { this.image = image; this.isTexture = true; }
        dispose() { this.disposed = true; }
      },
      MeshBasicMaterial: class {
        constructor(options) { Object.assign(this, options); }
        dispose() { this.disposed = true; }
      },
      PlaneGeometry: class {
        constructor(width, height) { this.width = width; this.height = height; }
        dispose() { this.disposed = true; }
      },
    },
  });
  const parent = {};
  const world = { mesh(geometry, material, x, y, z, container) {
    assert.equal(container, parent);
    const plaque = { geometry, material, position: { x, y, z }, rotation: {}, userData: {} };
    owned.push(plaque);
    return plaque;
  } };
  const plaque = servicePlaque(world, parent, 's3', { x: 0, y: 12, z: 0, width: 9 });
  assert.equal(plaque.userData.awsService, 's3');
  assert.equal(plaque.material.map.image, canvas);
  assert.equal(plaque.geometry.width, 9);
  assert.equal(plaque.userData.serviceRead, false);
  assert.ok(calls.some(([kind, text]) => kind === 'fillText' && text === 'NEW - Click to learn'));
  plaque.userData.setRead(true);
  assert.equal(plaque.userData.serviceRead, true);
  assert.equal(plaque.material.map.needsUpdate, true);
  assert.ok(calls.some(([kind, text]) => kind === 'fillText' && text === 'READ - Click to revisit'));
  assert.ok(calls.some(([kind, text]) => kind === 'fillText' && text === 'Amazon S3'));
  assert.ok(calls.some(([kind, text]) => kind === 'fillText' && text === 'AWS'));
  await loadServiceImages();
  const initialServices = new Set([...BUILDING_SERVICES,
    ...Object.values(CLOUD_REGIONS).map(region => region.service), ...AWS_LANDMARKS.village.map(point => point.service)]);
  assert.equal(requests, initialServices.size);
  assert.equal(cleared, initialServices.size);
  assert.ok(requests < Object.keys(AWS_SERVICES).length);
  servicePlaque(world, parent, 's3', { x: 0, y: 12, z: 0, width: 9 });
  assert.ok(calls.some(([kind]) => kind === 'drawImage'));
  disposeMap({ children: [], traverse(callback) { owned.forEach(callback); } },
    { geometries: new Set(), materials: new Set(), textures: new Set() });
  assert.equal(plaque.geometry.disposed, true);
  assert.equal(plaque.material.disposed, true);
  assert.equal(plaque.material.map.disposed, true);
});

test('mission badges use safe DOM labels, disappear on completion, and never guess from unknown missions', () => {
  const main = readFileSync(new URL('../v2/main.js', import.meta.url), 'utf8');
  const element = () => ({
    children: [], textContent: '', hidden: false, dataset: {},
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    get childElementCount() { return this.children.length; },
  });
  const elements = new Map();
  const document = {
    createElement: element,
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
  };
  const Game = runInNewContext(main.match(/class Game[\s\S]*?(?=\nconst game =)/)[0] + '\nGame;', {
    AWS_SERVICES, missionServices, document,
  });
  const game = { api: { quest: { name: 'Tests.CreateVpc', instruction: 'Amazon S3 <script>bad()</script>' } } };
  Game.prototype.showQuest.call(game);
  const badges = document.getElementById('mission-services');
  assert.equal(badges.children.length, 2);
  assert.equal(badges.hidden, false);
  assert.equal(badges.children[0].children[1].textContent, 'Amazon S3');
  assert.equal(badges.children[0].type, 'button');
  assert.equal(badges.children[0].dataset.awsService, 's3');
  game.api.quest = { name: 'Unknown', instruction: 'General cloud objective' };
  Game.prototype.showQuest.call(game);
  assert.equal(badges.hidden, true);
  game.api.quest = null;
  Game.prototype.showQuest.call(game, true);
  assert.equal(badges.childElementCount, 0);
  assert.equal(document.getElementById('quest-state').textContent, 'COMPLETE');
});
