import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { initialGameSave } from "../v2/game-save.js";

const root = resolve("web-game");
const port = 18765;
const debugPort = 19223;
const profile = resolve("web-game/tests/.voice-chrome-profile");
const results = [];
const languages = [
  { id: "en-US", label: "English", speechLocale: "en-US" },
  { id: "zh-HK", label: "Cantonese", speechLocale: "zh-HK" },
  { id: "fr-FR", label: "Français", speechLocale: "fr-FR" },
];
const frenchPassage = "Amazon S3 conserve les objets dans des compartiments.";
const backend = { calls: [], sessions: new Map(), mobileTokens: new Map(), nextId: 0,
  save: { revision: 0, state: initialGameSave() },
  wallet: { balance: 0, max: 100, earned: 0, spent: 0, revision: 0 } };
const mime = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json",
  ".txt": "text/plain", ".fbx": "application/octet-stream", ".glb": "model/gltf-binary",
};
const json = (res, body, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
};

function fakeApi(path, method, body, authorization) {
  backend.calls.push({ path, method, body, authorization });
  if (path.endsWith("/game/save")) {
    if (method === "POST") {
      if (backend.save.requestId === body.requestId) return backend.save;
      if (body.revision !== backend.save.revision) return { status: 409, body: { error: "Newer save" } };
      backend.save = { state: body.state, revision: body.revision + 1, requestId: body.requestId };
    }
    return backend.save;
  }
  if (path.endsWith("/voice/wallet")) return backend.wallet;
  if (path.endsWith("/voice/casts")) {
    backend.wallet = { ...backend.wallet, balance: backend.wallet.balance - body.level,
      spent: backend.wallet.spent + body.level, revision: backend.wallet.revision + 1 };
    return { wallet: backend.wallet, requestId: body.requestId, spell: body.spell, level: body.level, cost: body.level };
  }
  if (path.endsWith("/voice/completions") && method === "GET") {
    const services = ["s3", "ec2", "iam", "vpc", "lambda", "dynamodb"].map(serviceId => ({
      serviceId, label: serviceId.toUpperCase(),
      completed: [...backend.sessions.values()].some(session => session.serviceId === serviceId && session.completed),
      completedAt: 1793191336,
    }));
    return { services, wallet: backend.wallet,
      activities: [1, 2].flatMap(round => services.map(service => ({ ...service,
        completed: round === 1 && service.completed,
        activityId: `${service.serviceId}-reading-v${round}`, round,
        bestScore: round === 1 && service.completed ? 85 : null,
        latestScore: round === 1 && service.completed ? 85 : null,
        feedback: round === 1 && service.completed ? "Good coverage." : "",
        mpAwarded: round === 1 && service.completed ? 10 : 0 }))),
      completed: services.filter(service => service.completed).length, total: services.length };
  }
  if (path.endsWith("/voice/sessions") && method === "POST") {
    const id = `voice-${++backend.nextId}`;
    const serviceId = body.serviceId;
    const session = { id, serviceId, serviceLabel: serviceId.toUpperCase(), pairCode: "654321",
      status: "ready", paired: false, completed: false, mode: "graded_read_aloud", inputDevice: "desktop",
      activityId: `${serviceId}-reading-v1`, round: 1,
      question: "Amazon S3 stores data as objects in buckets.",
      readingTexts: { "en-US": "Amazon S3 stores data as objects in buckets.",
        "zh-HK": "Amazon S3 以物件形式將資料儲存在儲存桶內。", "fr-FR": frenchPassage },
      languages, defaultLanguage: "en-US",
      language: "en-US", attempts: 0, maxAttempts: 6 };
    backend.sessions.set(id, session);
    return { ...session, expiresAt: 1793195000 };
  }
  const match = path.match(/\/voice\/sessions\/([^/]+)(?:\/(approve|cancel|transfer|answer))?$/);
  if (match) {
    const session = backend.sessions.get(decodeURIComponent(match[1]));
    if (!session) return { status: 404, body: { error: "Route not found" } };
    if (method === "POST" && match[2] === "transfer") {
      session.status = "pairing";
      session.inputDevice = "phone";
      return { ...session, pairingToken: `pair-${session.id}` };
    }
    if (method === "POST" && match[2] === "answer") {
      session.attempts++;
      session.result = { passed: false, score: 55, mpAwarded: 0, feedback: "Read the remaining passage." };
      return { ...session };
    }
    if (method === "POST" && match[2] === "approve") {
      session.status = "ready";
      session.paired = true;
      return { status: 200, body: { status: session.status, paired: true } };
    }
    if (method === "POST" && match[2] === "cancel") {
      session.status = "cancelled";
      return { status: 200, body: { status: session.status } };
    }
    return { id: session.id, serviceId: session.serviceId, pairCode: session.pairCode,
      status: session.status, paired: session.paired, completed: session.completed,
      question: session.status === "ready" ? session.question : undefined,
      mode: session.mode, readingTexts: session.readingTexts, languages: session.languages,
      defaultLanguage: session.defaultLanguage, result: session.result };
  }
  if (path.endsWith("/voice/mobile/claim") && method === "POST") {
    if (backend.failClaim) {
      backend.failClaim = false;
      return { status: 503, body: { error: "temporarily unavailable" } };
    }
    const session = backend.sessions.get(body.id);
    if (!session || body.pairingToken !== `pair-${body.id}`) return { status: 410, body: { error: "expired" } };
    if (session.status !== "pairing") return { status: 401, body: { error: "already used" } };
    session.status = "ready";
    session.paired = true;
    const token = `mobile-${body.id}-${backend.mobileTokens.size}`;
    backend.mobileTokens.set(token, session.id);
    return { mobileToken: token, status: session.status, question: session.question, mode: session.mode,
      readingTexts: session.readingTexts, languages: session.languages, defaultLanguage: session.defaultLanguage,
      completed: session.completed,
      language: session.language, attempts: session.attempts, maxAttempts: 6 };
  }
  if (path.endsWith("/voice/mobile/session") && method === "GET") {
    const session = backend.sessions.get(backend.mobileTokens.get(authorization?.replace(/^Bearer /, "")));
    if (!session) return { status: 401, body: { error: "unauthorized" } };
    return { id: session.id, status: session.status, pairCode: session.pairCode,
      serviceId: session.serviceId, serviceLabel: session.serviceLabel,
      expiresAt: "2026-10-28T16:00:00Z", question: session.question,
      result: session.result, completed: session.completed, language: session.language,
      mode: session.mode, readingTexts: session.readingTexts, languages: session.languages, defaultLanguage: session.defaultLanguage,
      attempts: session.attempts, maxAttempts: 6 };
  }
  if (path.endsWith("/voice/mobile/answer") && method === "POST") {
    const session = backend.sessions.get(backend.mobileTokens.get(authorization?.replace(/^Bearer /, "")));
    session.attempts++;
    session.language = body.language;
    session.completed = true;
    session.status = "completed";
    session.result = { passed: true, score: 85, mpAwarded: 10, feedback: "Good coverage." };
    backend.wallet = { ...backend.wallet, balance: 10, earned: 10, revision: 1 };
    return { status: 200, body: { status: "completed", completed: true, result: session.result, attempts: session.attempts } };
  }
  return { status: 404, body: { error: "Route not found" } };
}

const server = createServer(async (req, res) => {
  if (req.url.startsWith("/mock-api?")) {
    const query = new URL(req.url, `http://127.0.0.1:${port}`).searchParams;
    const apiPath = query.get("path") || "";
    const method = query.get("method") || "GET";
    const body = JSON.parse(query.get("body") || "null");
    const response = fakeApi(apiPath, method, body, query.get("auth"));
    json(res, response.body ?? response, Number.isInteger(response.status) ? response.status : 200);
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    let body = await readFile(file);
    if (url.pathname === "/v2/main.js") {
      body = Buffer.from(body.toString().replace(
        "const game = new Game();",
        "const game = new Game(); globalThis.__game = game; globalThis.__THREE = THREE;",
      ));
    }
    res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.waiting = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.exceptions.push(message.params.exceptionDetails);
      } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        this.consoleErrors.push(message.params.args.map(arg => arg.value || arg.description));
      }
    });
  }
  static async connect(target) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const client = new Cdp(socket);
    await client.call("Page.enable");
    await client.call("Runtime.enable");
    await client.call("Network.enable");
    return client;
  }
  static async connectBrowser(webSocketDebuggerUrl) {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new Cdp(socket);
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.waiting.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() { this.socket.close(); }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (browser, expression, timeout = 90000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await browser.evaluate(expression);
    if (value) return value;
    await delay(500);
  }
  const diagnostics = await browser.evaluate(`({
    loading: document.getElementById('loading-message')?.textContent,
    save: document.getElementById('game-save-status')?.textContent,
    game: globalThis.__game ? { ready: __game.ready, resume: !!__game.resumeSave,
      changing: __game.progressChanging, travel: __game.traveling, reading: __game.readingService,
      talking: __game.talking, actorsReady: __game.mapActorsReady(), hidden: document.hidden } : null
  })`);
  throw new Error(`Timed out waiting for ${expression}: ${JSON.stringify({
    diagnostics, exceptions: browser.exceptions, consoleErrors: browser.consoleErrors,
  })}`);
};

let chrome;
let chromeExited;
let browserControl;
let mobileContextId;
let desktop;
const mobileBrowsers = [];
try {
  await new Promise((resolve, reject) => server.listen(port, "127.0.0.1", resolve).once("error", reject));
  chrome = spawn("/opt/google/chrome/chrome", [
    "--headless=new", "--no-sandbox", "--enable-webgl", "--use-gl=angle", "--use-angle=swiftshader",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    "--disable-background-networking", "--no-first-run", "--no-default-browser-check",
  ], { stdio: "ignore" });
  chromeExited = new Promise(resolve => chrome.once("exit", resolve));
  await waitFor({ evaluate: async expression => {
    if (expression === "chrome-ready") {
      try { return await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(response => response.ok); }
      catch { return false; }
    }
    return false;
  } }, "chrome-ready", 30000);
  const browserVersion = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(response => response.json());
  browserControl = await Cdp.connectBrowser(browserVersion.webSocketDebuggerUrl);
  mobileContextId = (await browserControl.call("Target.createBrowserContext")).browserContextId;

  const mockScript = `
    if (location.pathname.endsWith('/game-v2.html')) localStorage.setItem('api_key','mock-desktop-key');
    const apiCalls = globalThis.__apiCalls = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, options = {}) => {
      const url = new URL(input, location.href);
      if (url.hostname.endsWith('execute-api.us-east-1.amazonaws.com')) {
        const body = options.body ? JSON.parse(options.body) : null;
        const auth = options.headers?.Authorization;
        apiCalls.push({path:url.pathname,method:options.method || 'GET',body,auth,
          apiKey:options.headers?.['x-api-key']});
        const response = await fetch('/mock-api?path=' + encodeURIComponent(url.pathname) +
          '&method=' + encodeURIComponent(options.method || 'GET') +
          '&body=' + encodeURIComponent(JSON.stringify(body)) +
          '&auth=' + encodeURIComponent(auth || ''));
        const payload = await response.json();
        return new Response(JSON.stringify(payload.body ?? payload),
          {status:response.status,headers:{'Content-Type':'application/json'}});
      }
      return realFetch(input, options);
    };
    if (!location.search.includes('fallback=1')) {
      window.__speechInstances = [];
      window.SpeechRecognition = class {
        constructor() { window.__speechInstances.push(this); }
        start() { this.started = true; }
        stop() { this.stopped = true; this.onend?.(); }
      };
    } else {
      window.SpeechRecognition = undefined;
      window.webkitSpeechRecognition = undefined;
    }
    window.__mediaDevicesCalls = 0;
    Object.defineProperty(navigator, 'mediaDevices', {configurable:true,value:{
      getUserMedia: async () => {
        window.__mediaDevicesCalls++;
        return { getTracks: () => [{stop(){window.__tracksStopped = true;}}] };
      }
    }});
  `;
  const makeTarget = async (url, { mobile = false } = {}) => {
    const targetUrl = `http://127.0.0.1:${port}${url}`;
    let created;
    if (mobile) {
      const { targetId } = await browserControl.call("Target.createTarget", {
        url: "about:blank", browserContextId: mobileContextId,
      });
      created = await waitFor({ evaluate: async () => {
        const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json());
        return targets.find(target => target.id === targetId);
      } }, "mobile-target");
    } else {
      created = await fetch(
        `http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" },
      ).then(response => response.json());
    }
    const client = await Cdp.connect(created);
    if (mobile) {
      await client.call("Emulation.setDeviceMetricsOverride", {
        width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
      });
    } else {
      await client.call("Emulation.setDeviceMetricsOverride", {
        width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
      });
    }
    await client.call("Page.addScriptToEvaluateOnNewDocument", { source: mockScript });
    await client.call("Page.navigate", { url: targetUrl });
    return client;
  };
  desktop = await makeTarget("/game-v2.html?magicTest=1");
  await waitFor(desktop, "document.body?.dataset.ready === 'true'");
  const signClick = await desktop.evaluate(`(() => {
    localStorage.removeItem('aws-warrior:v2:read-services');
    const sign=__game.world.servicePlaques.find(item=>item.userData.awsService==='s3');
    const signPosition=sign.getWorldPosition(new __THREE.Vector3());
    const signRotation=sign.getWorldQuaternion(new __THREE.Quaternion());
    const normal=new __THREE.Vector3(0,0,1).applyQuaternion(signRotation).normalize();
    __game.camera.position.copy(signPosition).addScaledVector(normal,20);
    __game.camera.lookAt(signPosition);
    __game.camera.aspect = window.innerWidth / window.innerHeight;
    __game.camera.updateProjectionMatrix();
    __game.camera.updateMatrixWorld(true);
    sign.updateMatrixWorld(true);
    const point=signPosition.clone().project(__game.camera);
    const canvas=__game.renderer.domElement;
    const bounds=canvas.getBoundingClientRect();
    const x=bounds.left+(point.x+1)*bounds.width/2;
    const y=bounds.top+(1-point.y)*bounds.height/2;
    for (const type of ['pointerdown','pointerup']) {
      canvas.dispatchEvent(new PointerEvent(type,{bubbles:true,clientX:x,clientY:y,
        pointerId:41,button:0,pointerType:'mouse'}));
    }
    const ray = new __THREE.Raycaster();
    ray.setFromCamera(new __THREE.Vector2(point.x, point.y), __game.camera);
    const hits=ray.intersectObjects(__game.world.servicePlaques.filter(object=>object.visible),false)
      .slice(0,3).map(hit=>hit.object.userData.awsService);
    if (!hits.includes("s3")) throw new Error("Projected click misses S3 plaque: " + hits.join(","));
    return {
      signCount:__game.world.servicePlaques.length,
      visible:sign.visible,
      worldPosition:signPosition.toArray(),
      cameraPosition:__game.camera.position.toArray(),
      normal:normal.toArray(),
      direction:ray.ray?.direction?.toArray(),
      point:[point.x,point.y],
      rect:[bounds.width,bounds.height],
      hits,
      ready:__game.ready,
      traveling:__game.traveling,
      eventTarget:document.elementFromPoint(x,y)?.tagName,
      open:[...document.querySelectorAll('dialog[open]')].map(dialog=>dialog.id),
    };
  })()`);
  assert.ok(signClick.hits.includes("s3"));
  await waitFor(desktop, "document.querySelector('#service-dialog')?.open");
  assert.equal(await desktop.evaluate(`document.querySelector('#service-title').textContent`), "Amazon S3");
  assert.equal(await desktop.evaluate(`document.querySelector('#service-read')`), null);
  const pause = await desktop.evaluate(`({
    signOpen:document.querySelector('#service-dialog').open,
    readLabel:document.querySelector('#service-explain').textContent,
    readDisabled:document.querySelector('#service-explain').disabled,
    reading:__game.readingService,
    position:[__game.player._position.x,__game.player._position.z]
  })`);
  assert.equal(pause.signOpen, true);
  assert.equal(pause.readLabel, "Read aloud");
  assert.equal(pause.readDisabled, false);
  assert.equal(pause.reading, true);
  await desktop.evaluate(`__game.player.GetComponent('BasicCharacterControllerInput')._keys.forward=true`);
  await delay(1200);
  assert.deepEqual(await desktop.evaluate(`[__game.player._position.x,__game.player._position.z]`), pause.position);
  await desktop.evaluate(`__game.player.GetComponent('BasicCharacterControllerInput')._keys.forward=false; document.querySelector('#service-explain').click()`);
  await waitFor(desktop, `document.querySelector('#voice-desktop-dialog').open &&
    document.querySelector('#pc-voice-question').textContent.includes('Amazon S3 stores data')`);
  assert.equal(await desktop.evaluate(`!!document.querySelector('#voice-desktop-panel canvas')`), false);
  assert.equal(await desktop.evaluate(`document.querySelector('#pc-speak').disabled`), false);
  assert.deepEqual(await desktop.evaluate(`[...document.querySelector('#pc-voice-language').options].map(option=>option.value)`),
    languages.map(language => language.id));
  await desktop.evaluate(`document.querySelector('#pc-voice-language').value='fr-FR';
    document.querySelector('#pc-voice-language').dispatchEvent(new Event('change'));
    document.querySelector('#pc-speak').dispatchEvent(new KeyboardEvent('keydown',{key:' '}))`);
  assert.equal(await desktop.evaluate(`document.querySelector('#pc-voice-question').textContent`), frenchPassage);
  assert.equal(await desktop.evaluate(`window.__speechInstances.at(-1).lang`), "fr-FR");
  await desktop.evaluate(`document.querySelector('#pc-speak').dispatchEvent(new KeyboardEvent('keyup',{key:' '}));
    document.querySelector('#pc-voice-language').value='en-US';
    document.querySelector('#pc-voice-language').dispatchEvent(new Event('change'))`);
  await desktop.evaluate(`document.querySelector('#pc-speak').dispatchEvent(new KeyboardEvent('keydown',{key:' '}))`);
  await desktop.evaluate(`window.__speechInstances.at(-1).onresult({results:[Object.assign([{transcript:'Amazon S3 stores data'}],{isFinal:true})]})`);
  await desktop.evaluate(`document.querySelector('#pc-speak').dispatchEvent(new KeyboardEvent('keyup',{key:' '}))`);
  await desktop.evaluate(`document.querySelector('#pc-send-answer').click()`);
  await waitFor(desktop, `document.querySelector('#pc-voice-result').textContent.includes('55/100')`);
  assert.match(await desktop.evaluate(`document.querySelector('#pc-voice-result').textContent`), /MP earned: 0/);
  assert.equal(backend.wallet.balance, 0);
  const pcAnswer = await desktop.evaluate(`__apiCalls.find(call=>call.path.endsWith('/voice-1/answer'))`);
  assert.equal(pcAnswer.apiKey, "mock-desktop-key");
  assert.equal(pcAnswer.auth, undefined);
  await desktop.evaluate(`document.querySelector('#voice-transfer').click()`);
  await waitFor(desktop, `document.querySelector('#voice-desktop-dialog').open &&
    document.querySelector('#voice-desktop-panel canvas')`);
  const initialVoice = await desktop.evaluate(`({
    status:document.querySelector('#voice-desktop-panel .voice-session-status').textContent,
    qr:document.querySelector('#voice-desktop-panel canvas').width,
    getCalls:__apiCalls.filter(c=>/\\/voice\\/sessions\\/voice-1$/.test(c.path)).length,
    hasApprove:!!document.querySelector('#voice-approve')
  })`);
  assert.match(initialVoice.status, /Scan the QR code/);
  assert.equal(initialVoice.qr, 240);
  assert.equal(initialVoice.getCalls, 0, "desktop must not poll for pairing updates");
  assert.equal(initialVoice.hasApprove, false);

  mobileBrowsers.push(await makeTarget(
    `/voice-practice.html#id=voice-1&token=pair-voice-1`, { mobile: true },
  ));
  const mobile = mobileBrowsers[0];
  await waitFor(mobile, `document.querySelector('#mobile-voice-question')?.textContent.includes('Amazon S3 stores data')`);
  const noEditors = await mobile.evaluate(`({
    editors:document.querySelectorAll('input:not([type=checkbox]),textarea,[contenteditable=true]').length,
    transcriptTag:document.querySelector('#mobile-voice-transcript').tagName,
    question:document.querySelector('#mobile-voice-question').textContent,
    apiKey:localStorage.getItem('api_key'),
    hash:location.hash
  })`);
  assert.equal(noEditors.editors, 0);
  assert.equal(noEditors.transcriptTag, "P");
  assert.match(noEditors.question, /Amazon S3 stores data/, "scanning must open the passage immediately");
  assert.equal(noEditors.apiKey, null, "desktop API key must never be copied to the phone");
  assert.equal(noEditors.hash, "", "pairing secrets are removed from the mobile address bar after claim");
  assert.equal(await mobile.evaluate(`__apiCalls.find(call=>call.path.endsWith('/voice/mobile/claim')).apiKey`), undefined);
  assert.equal((await desktop.evaluate(`__apiCalls.filter(c=>/\\/voice\\/sessions\\/voice-1$/.test(c.path)).length`)), 0);
  await waitFor(mobile, `document.querySelector('#mobile-voice-question')?.textContent.includes('Amazon S3 stores data')`);
  const mobileControls = await mobile.evaluate(`({
    speakDisabled:document.querySelector('#mobile-speak').disabled,
    speechConsent:document.querySelector('#mobile-speech-consent'),
    question:document.querySelector('#mobile-voice-question').textContent,
    speechStarts:window.__speechInstances?.length || 0
  })`);
  assert.equal(mobileControls.speakDisabled, false);
  assert.equal(mobileControls.speechConsent, null);
  assert.equal(mobileControls.speechStarts, 0);
  assert.deepEqual(await mobile.evaluate(`[...document.querySelector('#mobile-voice-language').options].map(option=>option.value)`),
    languages.map(language => language.id));
  await mobile.evaluate(`document.querySelector('#mobile-voice-language').value='fr-FR';
    document.querySelector('#mobile-voice-language').dispatchEvent(new Event('change'))`);
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-voice-question').textContent`), frenchPassage);
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-question-heading').textContent`), "Text to read aloud");
  await mobile.evaluate(`document.querySelector('#mobile-voice-language').value='zh-HK';
    document.querySelector('#mobile-voice-language').dispatchEvent(new Event('change'))`);
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-voice-question').textContent`),
    "Amazon S3 以物件形式將資料儲存在儲存桶內。");
  await mobile.evaluate(`document.querySelector('#mobile-speak').dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1}))`);
  assert.equal(await mobile.evaluate(`window.__speechInstances.at(-1).started`), true);
  assert.equal(await mobile.evaluate(`window.__speechInstances.at(-1).lang`), "zh-HK");
  await mobile.evaluate(`window.__speechInstances.at(-1).onresult({results:[Object.assign([{transcript:'我會用物件儲存遊戲檔案'}],{isFinal:true})]})`);
  assert.equal(await mobile.evaluate(`window.__speechInstances.at(-1).continuous`), true);
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-send-answer').disabled`), true);
  await mobile.evaluate(`document.querySelector('#mobile-speak').dispatchEvent(new PointerEvent('pointerup',{pointerId:1}))`);
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-send-answer').disabled`), false);
  await mobile.evaluate(`document.querySelector('#mobile-voice-language').value='en-US';
    document.querySelector('#mobile-voice-language').dispatchEvent(new Event('change'))`);
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-voice-question').textContent`),
    "Amazon S3 stores data as objects in buckets.");
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-voice-transcript').textContent`), "");
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-send-answer').disabled`), true);
  await mobile.evaluate(`document.querySelector('#mobile-speak').dispatchEvent(new KeyboardEvent('keydown',{key:' '}))`);
  assert.equal(await mobile.evaluate(`window.__speechInstances.at(-1).lang`), "en-US");
  await mobile.evaluate(`window.__speechInstances.at(-1).onresult({results:[Object.assign([{transcript:'Amazon S3 stores data as objects in buckets.'}],{isFinal:true})]})`);
  await mobile.evaluate(`document.querySelector('#mobile-speak').dispatchEvent(new KeyboardEvent('keyup',{key:' '}))`);
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-send-answer').disabled`), false);
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-voice-transcript').isContentEditable`), false);
  const submitPoint = await mobile.evaluate(`(() => {
    const button = document.querySelector('#mobile-send-answer');
    button.scrollIntoView({block:'center'});
    const box = button.getBoundingClientRect();
    return {x:box.x+box.width/2,y:box.y+box.height/2};
  })()`);
  await mobile.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...submitPoint, id: 1 }] });
  await mobile.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await waitFor(mobile, `document.querySelector('#mobile-voice-status')?.textContent.includes('Voice activity passed')`);
  const answerRequest = await mobile.evaluate(`__apiCalls.find(call=>call.path.endsWith('/voice/mobile/answer'))`);
  assert.equal(answerRequest.body.source, "browser");
  assert.equal(answerRequest.body.speechCompleted, true);
  assert.equal(answerRequest.body.transcript, "Amazon S3 stores data as objects in buckets.");
  assert.equal(answerRequest.body.language, "en-US");
  assert.equal(answerRequest.auth, "Bearer mobile-voice-1-0");
  assert.equal(answerRequest.apiKey, undefined);
  await waitFor(mobile, `document.querySelector('#mobile-voice-status')?.textContent.includes('Voice activity passed')`, 15000);
  assert.match(await mobile.evaluate(`document.querySelector('#mobile-voice-result').textContent`), /Grade: 85\/100.*MP earned: 10/);
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-speak').disabled`), true);
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-chat-section').hidden`), true);
  await mobile.call("Page.reload");
  await waitFor(mobile, `document.querySelector('#mobile-voice-status')?.textContent.includes('Voice activity passed')`);
  assert.equal(await mobile.evaluate(`__apiCalls.some(c=>c.path.endsWith('/voice/mobile/claim'))`), false);
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-voice-transcript').textContent.includes('unrelated')`), false);
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-speech-consent')`), null);
  assert.equal(await mobile.evaluate(`document.querySelector('#mobile-voice-language').value`), "en-US");
  const autoPolls = await desktop.evaluate(`__apiCalls.filter(c=>/\\/voice\\/sessions\\/voice-1$/.test(c.path)).length`);
  assert.equal(autoPolls, 0, "desktop makes no session GET before the manual completion check");
  await desktop.evaluate(`document.querySelector('#voice-check').click()`);
  await waitFor(desktop, `document.querySelector('#pc-voice-result')?.textContent.includes('85/100')`);
  assert.equal(await desktop.evaluate(`document.querySelector('#voice-start').hidden`), true);
  assert.equal(await desktop.evaluate(`(document.querySelector('#voice-desktop-dialog').innerText.match(/Grade: 85\\/100/g) || []).length`), 1);
  assert.equal(await desktop.evaluate(`document.querySelector('#voice-desktop-panel').textContent`), "");
  await waitFor(desktop, `document.querySelector('#mp-value').textContent.includes('10 / 100')`);
  assert.equal(await desktop.evaluate(`document.querySelector('#mp-bar').style.width`), "10%");
  assert.equal(await desktop.evaluate(`document.querySelector('#voice-desktop-panel').textContent.includes('遊戲檔案')`), false);
  assert.equal(await desktop.evaluate(`__game.readServices.has('s3')`), true);
  assert.match(await desktop.evaluate(`document.querySelector('#service-read-state').textContent`), /Read/);
  assert.equal(await desktop.evaluate(`localStorage.getItem('aws-warrior:v2:read-services')`), '["s3"]');
  assert.equal(await desktop.evaluate(`__apiCalls.filter(c=>/\\/voice\\/sessions\\/voice-1$/.test(c.path)).length`), 1);
  assert.equal(await desktop.evaluate(`document.querySelector('#combat-feedback').textContent`), "");
  assert.equal(await desktop.evaluate(`document.querySelector('#combat-manual').open`), false);
  assert.equal(await desktop.evaluate(`!!document.querySelector('#magic-test-toggle')`), false);
  assert.equal(await desktop.evaluate(`!![...document.querySelectorAll('button')].find(b=>/testing toggle/i.test(b.textContent))`), false);

  // Unsupported browsers must not consume the one-use QR.
  await desktop.evaluate(`document.querySelector('#voice-desktop-close').click();
    document.querySelector('#service-dialog').close();
    { const mission = document.createElement('button'); mission.dataset.awsService = 'ec2';
      document.querySelector('#mission-services').appendChild(mission); mission.click(); mission.remove(); }
    document.querySelector('#service-explain').click();`);
  await waitFor(desktop, `document.querySelector('#pc-practice-content').hidden === false`);
  await desktop.evaluate(`document.querySelector('#voice-transfer').click()`);
  await waitFor(desktop, `document.querySelector('#voice-desktop-panel .voice-session-status')?.textContent.includes('Scan the QR code')`);
  mobileBrowsers.push(await makeTarget(
    `/voice-practice.html?fallback=1#id=voice-2&token=pair-voice-2`, { mobile: true },
  ));
  const fallback = mobileBrowsers[1];
  await waitFor(fallback, `document.querySelector('#mobile-voice-status')?.textContent.includes('QR has not been used')`);
  assert.equal(await fallback.evaluate(`document.querySelector('#mobile-practice-content').hidden`), true);
  assert.equal(await fallback.evaluate(`document.querySelector('#mobile-use-recording')`), null);
  assert.equal(await fallback.evaluate(`__apiCalls.length`), 0);
  assert.equal(backend.sessions.get("voice-2").status, "pairing");
  assert.equal(await fallback.evaluate(`window.__mediaDevicesCalls`), 0);

  backend.failClaim = true;
  mobileBrowsers.push(await makeTarget(
    `/voice-practice.html#id=voice-2&token=pair-voice-2`, { mobile: true },
  ));
  const retryPhone = mobileBrowsers[2];
  await waitFor(retryPhone, `document.querySelector('#mobile-voice-status')?.textContent.includes('Retry connection')`);
  assert.equal(await retryPhone.evaluate(`document.querySelector('#mobile-practice-content').hidden`), true);
  assert.equal(await retryPhone.evaluate(`document.querySelector('#mobile-voice-question').textContent`), "");
  assert.equal(await retryPhone.evaluate(`location.hash`), "#id=voice-2&token=pair-voice-2");
  await retryPhone.evaluate(`document.querySelector('#mobile-refresh').click()`);
  await waitFor(retryPhone, `document.querySelector('#mobile-voice-question')?.textContent.includes('Amazon S3 stores data')`);
  assert.equal(await retryPhone.evaluate(`document.querySelector('#mobile-practice-content').hidden`), false);
  assert.equal(await retryPhone.evaluate(`location.hash`), "");
  const exhausted = backend.sessions.get("voice-2");
  exhausted.attempts = 6;
  exhausted.status = "ready";
  exhausted.completed = false;
  await retryPhone.evaluate(`document.querySelector('#mobile-refresh').click()`);
  await waitFor(retryPhone, `document.querySelector('#mobile-voice-attempts').textContent.includes('0 of 6 read-aloud attempts')`);
  assert.equal(await retryPhone.evaluate(`document.querySelector('#mobile-speak').disabled`), true);
  assert.equal(await retryPhone.evaluate(`document.querySelector('#mobile-record')`), null);
  const mobileMarkup = await retryPhone.evaluate(`document.documentElement.outerHTML`);
  assert.doesNotMatch(mobileMarkup, /api_key|x-api-key/i);
  assert.equal(backend.calls.some(call => /\/voice\/mobile\/(?:upload|transcribe)$/.test(call.path)), false);

  await desktop.evaluate(`document.querySelector('#voice-desktop-dialog').close(); document.querySelector('#service-dialog').close(); __game.spell='shockwave'; __game.magicLevel=1`);
  await waitFor(desktop, `!document.querySelector('dialog[open]') && !__game.readingService`);
  const castResult = await desktop.evaluate(`__game.castMagic()`);
  assert.equal(castResult, true, JSON.stringify(await desktop.evaluate(`({
    mp:document.querySelector('#mp-value').textContent,
    status:document.querySelector('#magic-cast').title,
    calls:__apiCalls.filter(call=>call.path.endsWith('/voice/casts')),
    ready:__game.ready,traveling:__game.traveling,reading:__game.readingService,cooldown:__game.magic.cooldown
  })`)));
  await waitFor(desktop, `document.querySelector('#mp-value').textContent.includes('9 / 100')`, 15000);
  assert.equal(backend.wallet.spent, 1);
  assert.equal(await desktop.evaluate(`document.querySelector('#mp-bar').style.width`), "9%");
  assert.equal(await desktop.evaluate(`document.querySelector('a[href="./voice-marks.html"]')?.textContent`), "Voice marks");
  const marks = await makeTarget("/voice-marks.html");
  mobileBrowsers.push(marks);
  await waitFor(marks, `document.querySelector('#voice-marks-results')?.hidden === false`);
  assert.equal(await marks.evaluate(`document.querySelector('#voice-marks-summary').textContent`), "1 of 12 voice activities completed");
  assert.equal(await marks.evaluate(`document.querySelectorAll('#voice-marks-activities tr').length`), 12);
  assert.match(await marks.evaluate(`document.querySelector('#voice-marks-activities tr').textContent`), /85.*20:42/);
  assert.match(await marks.evaluate(`document.querySelector('#voice-marks-wallet').textContent`), /9 \/ 100/);
  const marksRequests = backend.calls.filter(call => call.path.endsWith("/voice/completions")).length;
  await marks.evaluate(`{ const search = document.querySelector('input[type="search"]');
    search.value = '  s3  '; search.dispatchEvent(new Event('input')); }`);
  assert.equal(await marks.evaluate(`document.querySelectorAll('#voice-marks-activities tr').length`), 2);
  await marks.evaluate(`{ const filter = document.querySelector('select');
    filter.value = [...filter.options].find(option => option.textContent === 'Passed').value;
    filter.dispatchEvent(new Event('change')); }`);
  assert.equal(await marks.evaluate(`document.querySelectorAll('#voice-marks-activities tr').length`), 1);
  await marks.evaluate(`{ const search = document.querySelector('input[type="search"]');
    search.value = ''; search.dispatchEvent(new Event('input'));
    const filter = document.querySelector('select');
    filter.value = [...filter.options].find(option => option.textContent === 'All').value;
    filter.dispatchEvent(new Event('change')); }`);
  assert.equal(backend.calls.filter(call => call.path.endsWith("/voice/completions")).length, marksRequests);
  await marks.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.ok(await marks.evaluate(`document.querySelector('main').getBoundingClientRect().width > 1300`));
  await marks.evaluate(`document.querySelector('#voice-marks-activities td:nth-child(5)').textContent =
    'Long feedback with practical reading advice. '.repeat(40)`);
  assert.ok(await marks.evaluate(`document.querySelector('#voice-marks-activities td:nth-child(5)').getBoundingClientRect().width > 400`));
  for (const width of [390, 320]) {
    await marks.call("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: true });
    const layout = await marks.evaluate(`({
      fits: document.documentElement.scrollWidth <= innerWidth,
      row: getComputedStyle(document.querySelector('#voice-marks-activities tr')).display,
      feedback: document.querySelector('#voice-marks-activities td:nth-child(5)').getBoundingClientRect().width,
      fullText: document.querySelector('#voice-marks-activities td:nth-child(5)').scrollHeight <=
        document.querySelector('#voice-marks-activities td:nth-child(5)').clientHeight
    })`);
    assert.equal(layout.fits, true);
    assert.equal(layout.row, "grid");
    assert.ok(layout.feedback > width - 85);
    assert.equal(layout.fullText, true);
  }
  await marks.evaluate(`document.querySelector('#voice-marks-key').value=''; document.querySelector('#voice-marks-key').dispatchEvent(new Event('input'))`);
  assert.equal(await marks.evaluate(`document.querySelector('#voice-marks-results').hidden`), true);
  await desktop.call("Page.bringToFront");
  await desktop.evaluate(`__game.switchMap('mountains');`);
  await waitFor(desktop, "__game.map.id === 'mountains' && !__game.traveling");
  await desktop.evaluate(`__game.selectWeapon('Spear'); __game.gameSave.flush();`);
  await waitFor(desktop, "__game.gameSave.status === 'saved' && __game.gameSave.document.state.equipment.weapon === 'Spear'");
  assert.equal(backend.save.state.equipment.weapon, "Spear");
  const resumed = await makeTarget("/game-v2.html");
  mobileBrowsers.push(resumed);
  await waitFor(resumed, "document.body?.dataset.ready === 'true' && !__game.resumeSave && __game.mapActorsReady()");
  assert.equal(await resumed.evaluate("__game.weapon"), "Spear");
  assert.equal(await resumed.evaluate("__game.map.id"), "mountains");
  assert.ok(await resumed.evaluate(`Math.hypot(__game.player._position.x-__game.map.spawn[0],
    __game.player._position.z-__game.map.spawn[1]) < 1`));
  await resumed.evaluate(`__game.selectWeapon('Axe'); __game.gameSave.flush();`);
  await waitFor(resumed, "__game.gameSave.status === 'saved' && __game.gameSave.document.state.equipment.weapon === 'Axe'");
  await desktop.call("Page.bringToFront");
  await desktop.evaluate(`__game.selectWeapon('Sword'); __game.gameSave.flush();`);
  assert.equal(await desktop.evaluate("__game.gameSave.status"), "conflict");
  assert.equal(backend.save.state.equipment.weapon, "Axe");
  await desktop.evaluate(`document.getElementById('game-save-retry').click();`);
  await waitFor(desktop, "__game.gameSave.status === 'saved' && !__game.resumeSave");
  assert.equal(await desktop.evaluate("__game.weapon"), "Axe");
  await desktop.evaluate(`(async () => { const real = window.fetch;
    window.fetch = (...args) => String(args[0]).includes('/game/save') ? Promise.reject(new Error('offline')) : real(...args);
    __game.selectWeapon('Spear'); await __game.gameSave.flush(); window.fetch = real; })()`);
  assert.equal(await desktop.evaluate("__game.gameSave.status"), "offline");
  await desktop.call("Page.reload");
  await waitFor(desktop, "document.body?.dataset.ready === 'true' && !__game.resumeSave && __game.gameSave.status === 'saved'");
  assert.equal(await desktop.evaluate("__game.weapon"), "Spear");
  assert.equal(backend.save.state.equipment.weapon, "Spear");
  assert.equal(backend.wallet.balance, 9);
  const castRequests = backend.calls.filter(call => call.path.endsWith('/voice/casts')).length;
  await desktop.call("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyM", key: "m",
    modifiers: 3, windowsVirtualKeyCode: 77 });
  await desktop.call("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyM", key: "m",
    modifiers: 3, windowsVirtualKeyCode: 77 });
  assert.equal(await desktop.evaluate("__game.infinitiveMagic"), true);
  assert.equal(await desktop.evaluate("document.getElementById('magic-badges').textContent"), "Infinitive Magic Mode");
  assert.equal(await desktop.evaluate("document.getElementById('magic-cast').disabled"), false);
  assert.equal(await desktop.evaluate(`(async () => {
    __game.spell='shockwave'; __game.magicLevel=3;
    return await __game.castMagic() && await __game.castMagic();
  })()`), true);
  assert.equal(await desktop.evaluate("__game.magic.cooldown"), 0);
  assert.equal(backend.calls.filter(call => call.path.endsWith('/voice/casts')).length, castRequests);
  assert.equal(backend.wallet.balance, 9);
  await desktop.call("Page.reload");
  await waitFor(desktop, "document.body?.dataset.ready === 'true' && !__game.resumeSave");
  assert.equal(await desktop.evaluate("__game.infinitiveMagic"), false);
  assert.ok(await desktop.evaluate(`document.querySelector('link[rel="icon"]').href.includes('favicon.ico?v=hkiit-1')`));

  const evidence = [
    "Local served-page browser integration: PASS",
    `Game booted from http://127.0.0.1:${port}/game-v2.html; mobile page from same served origin.`,
    "Mock API only; no AWS requests, student records, or task grading endpoints called.",
    "Actual S3 3D sign click opened the service modal; Read aloud is the only practice action and the modal pauses player movement.",
    "Desktop QR generated locally; scanning opens the question immediately without a pairing-code check or desktop approval.",
    "Desktop polling: zero session GET requests before manual Check; one after explicit click.",
    "Mobile transcript: no editable text controls; interim speech cannot submit; final speech sends required flags.",
    "English and Hong Kong Cantonese recognition and request language verified; CJK speech accepted; switching clears unsent speech.",
    "PC and phone share a graded activity; failed PC grade gives no MP, passing phone grade credits MP, and reload restores completion without reclaiming.",
    "Browser recognition absent: clear guidance without consuming QR; no recording controls or audio upload calls.",
    "Temporary pairing error: reading controls hidden, QR retained until a successful connection retry.",
    "Passed grade updates MP bar below HP; a cast spends server-authorised MP even with magicTest=1.",
    "Voice marks page loads saved game key, renders twelve graded activity rows and Hong Kong time, and clears results on key changes.",
    "Voice marks uses desktop width and stacks long feedback on 390px and 320px phones without page overflow or clipping.",
    "Marks search and status filters run locally without extra API calls.",
    "Game saves restore safe spawn/equipment on another tab, reject stale writes, explicitly resolve conflicts, and recover offline changes after reload without changing MP.",
    `Browser runtime exceptions: ${desktop.exceptions.length + mobileBrowsers.reduce((sum, item) => sum + item.exceptions.length, 0)}.`,
  ].join("\n");
  assert.equal(desktop.exceptions.length + mobileBrowsers.reduce((sum, item) => sum + item.exceptions.length, 0), 0);
  await import("node:fs/promises").then(fs => fs.writeFile("web-game/tests/voice-browser-results.log", evidence + "\n"));
  results.push(evidence);
  console.log(evidence);
} finally {
  for (const browser of mobileBrowsers) browser.close();
  desktop?.close();
  if (browserControl && mobileContextId) {
    await browserControl.call("Target.disposeBrowserContext", { browserContextId: mobileContextId }).catch(() => {});
    browserControl.close();
  }
  server.close();
  if (chrome && chrome.exitCode === null) {
    try {
      const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(response => response.json());
      const socket = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      socket.close();
    } catch { chrome.kill("SIGTERM"); }
    await Promise.race([chromeExited, delay(10000)]);
    if (chrome.exitCode === null) {
      chrome.kill("SIGTERM");
      await chromeExited;
    }
  }
  await delay(1000);
  await import("node:fs/promises").then(fs => fs.rm(profile, { recursive: true, force: true }));
}
