import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  bindMobileVoicePractice, isMeaningfulTranscript,
  bindVoicePractice, unavailableMessage, voiceOwnerFingerprint, voiceResultPassed, voiceStatusMessage,
} from '../v2/voice-practice.js';
import { qrcode } from '../v2/vendor/qrcode-generator.mjs';

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const EN_PASSAGE = 'Amazon S3 stores data as objects in buckets.';
const ZH_PASSAGE = 'Amazon S3 以物件形式將資料儲存在儲存桶內。';

test('voice pages have one refresh control and one status message per device', () => {
  const pc = readFileSync(new URL('../game-v2.html', import.meta.url), 'utf8');
  const phone = readFileSync(new URL('../voice-practice.html', import.meta.url), 'utf8');
  assert.doesNotMatch(pc, /id="pc-refresh"|id="pc-submit-status"|Reading marks a discovery|Magic power and badge cost/);
  assert.doesNotMatch(phone, /id="mobile-submit-status"/);
  assert.match(pc, /id="voice-check"[^>]*>Refresh passage or result</);
  for (const [html, prefix] of [[pc, 'pc'], [phone, 'mobile']]) {
    assert.match(html, new RegExp(`id="${prefix}-speak"[^>]*>Hold to speak<`));
    assert.match(html, new RegExp(`id="${prefix}-send-answer"[^>]*>Submit spoken reading<`));
    assert.equal((html.match(new RegExp(`id="${prefix}-voice-status"`, 'g')) || []).length, 1);
  }
});

class Element {
  constructor() {
    this.events = new Map();
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
  }
  addEventListener(name, callback) { this.events.set(name, callback); }
  click() { return this.onclick?.(); }
  change() { this.events.get('change')?.({ currentTarget: this }); }
  appendChild(child) { (this.children ||= []).push(child); return child; }
  replaceChildren(...children) { this.children = children; }
}

function mobileFixture({
  recognition, failAnswer = false, unsupported = false, questionStatus = 'ready',
  phoneStorage = new Map(), tabStorage = new Map(), hash = '#id=session-1&token=pairing-secret',
  serverData = {}, claimStatus = 'claimed', claimHttpStatus = 200, sessionHttpStatus = 200,
  answerOutcome = 'passed', blockPhoneStorage = false, immediateResult = true, answerGate, answerError,
  gradeResult,
} = {}) {
  const elements = new Map();
  const requests = [];
  const listeners = new Map(), timers = new Map();
  let answerSubmitted = false;
  let claimCount = 0;
  let nextTimer = 0;
  const location = { hash, pathname: '/voice-practice.html' };
  const storage = values => ({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  });
  const documentRef = { createElement: () => new Element(), getElementById(id) {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  } };
  const windowRef = {
    location,
    localStorage: blockPhoneStorage ? {
      getItem() { throw new Error('Storage unavailable'); },
      setItem() { throw new Error('Storage unavailable'); },
    } : storage(phoneStorage), sessionStorage: storage(tabStorage),
    history: { replaceState: (...args) => { windowRef.replaced = args; } },
    addEventListener: (name, callback) => listeners.set(name, callback),
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
  };
  const fetcher = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/voice/mobile/claim')) {
      const code = Array.isArray(claimHttpStatus) ? claimHttpStatus[claimCount++] : claimHttpStatus;
      return response({ mobileToken: 'mobile-secret', pairCode: '123456', status: claimStatus,
        mode: 'read_aloud', readingTexts: { 'en-US': EN_PASSAGE, 'zh-HK': ZH_PASSAGE },
        question: EN_PASSAGE, completed: false, attempts: 0, maxAttempts: 6,
        ...serverData }, code);
    }
    if (String(url).endsWith('/voice/mobile/session')) {
      const outcome = answerSubmitted ? answerOutcome : null;
      return response({ id: 'session-1', pairCode: '123456', status: outcome
        ? outcome === 'passed' ? 'completed' : 'ready' : questionStatus,
      question: EN_PASSAGE, mode: 'read_aloud',
      readingTexts: { 'en-US': EN_PASSAGE, 'zh-HK': ZH_PASSAGE },
      completed: outcome === 'passed', attempts: outcome ? answerSubmitted ? 1 : 0 : serverData.attempts ?? 0,
      maxAttempts: 6, result: outcome ? gradeResult ?? { passed: outcome === 'passed',
        feedback: outcome === 'passed' ? 'Participation recorded.' : 'Not enough clear speech.' } : undefined,
      ...serverData, ...(outcome ? { status: outcome === 'passed' ? 'completed' : 'ready',
        completed: outcome === 'passed', attempts: answerSubmitted ? 1 : 0, result: gradeResult ?? { passed: outcome === 'passed',
          feedback: outcome === 'passed' ? 'Participation recorded.' : 'Not enough clear speech.' } } : {}) },
      sessionHttpStatus);
    }
    if (String(url).endsWith('/voice/mobile/answer')) {
      if (answerGate) await answerGate;
      if (answerError) return response(answerError.body, answerError.status);
      if (failAnswer) return response({}, 503);
      answerSubmitted = true;
      return response(immediateResult ? { status: 'completed', result: gradeResult ?? { passed: true }, completed: true, attempts: 1 } : { status: 'evaluating' });
    }
    return response({}, 404);
  };
  class FakeRecognition {
    constructor() { recognition.instance = this; (recognition.instances ||= []).push(this); }
    start() {
      recognition.started = true;
      if (recognition.denied) this.onerror?.({ error: 'not-allowed' });
    }
    stop() { recognition.stopped = true; if (!recognition.delayedEnd) this.onend?.(); }
  }
  const api = bindMobileVoicePractice({
    documentRef, windowRef, fetcher,
    SpeechRecognitionClass: unsupported ? null : FakeRecognition,
  });
  return { elements, requests, listeners, windowRef, recognition, api, timers,
    async advanceRefresh() {
      const [id, callback] = timers.entries().next().value ?? [];
      if (!callback) return;
      timers.delete(id);
      callback();
      await tick();
    } };
}

test('speech requires a meaningful final transcript and server-only passed results', () => {
  assert.equal(isMeaningfulTranscript(''), false);
  assert.equal(isMeaningfulTranscript('S3'), false);
  assert.equal(isMeaningfulTranscript('... !'), false);
  assert.equal(isMeaningfulTranscript('Amazon S3 stores game files'), true);
  assert.equal(isMeaningfulTranscript('我會用物件儲存遊戲檔案'), true);
  assert.equal(isMeaningfulTranscript('嗯'), false);
  assert.equal(isMeaningfulTranscript('你好'), false);
  assert.equal(isMeaningfulTranscript('啊 啊 啊'), false);
  assert.equal(isMeaningfulTranscript('啊啊啊啊啊啊'), false);
  assert.equal(isMeaningfulTranscript('クラウドサービスを利用します'), true);
  assert.equal(isMeaningfulTranscript('บริการจัดเก็บข้อมูล'), true);
  assert.equal(voiceResultPassed({ status: 'completed', result: { passed: true } }), true);
  assert.equal(voiceResultPassed({ status: 'completed', result: { passed: false } }), false);
  assert.equal(voiceResultPassed({ transcript: 'correct answer' }), false);
  assert.match(voiceStatusMessage('awaiting_question_approval'), /teacher is reviewing.*do not read/i);
  assert.match(unavailableMessage({ status: 404 }), /not enabled/i);
  assert.match(unavailableMessage({ status: 403, apiMessage: 'Missing Authentication Token' }), /not enabled/i);
  assert.match(unavailableMessage({ status: 422, apiMessage: 'Lesson unavailable' }), /not enabled/i);
  assert.equal(unavailableMessage({ status: 403, apiMessage: 'Forbidden' }), null);
});

test('phone reload and repeated QR scan resume the same capability without reclaiming or restoring speech', async () => {
  const phoneStorage = new Map(), tabStorage = new Map();
  mobileFixture({ recognition: {}, phoneStorage, tabStorage });
  await tick();
  for (const hash of ['', '#id=session-1&token=pairing-secret']) {
    const resumed = mobileFixture({ recognition: {}, phoneStorage, tabStorage, hash });
    await tick();
    assert.equal(resumed.requests.length, 1);
    assert.match(resumed.requests[0].url, /voice\/mobile\/session$/);
    assert.equal(resumed.elements.get('mobile-voice-question').textContent, EN_PASSAGE);
    assert.equal(resumed.elements.get('mobile-send-answer').disabled, true);
  }
  const otherSession = mobileFixture({ recognition: {}, phoneStorage, hash: '#id=session-2&token=new-token' });
  await tick();
  assert.match(otherSession.requests[0].url, /voice\/mobile\/claim$/);
  assert.equal(JSON.stringify([...phoneStorage.values()]).includes('pairing-secret'), false);
});

test('QR pairing is generated locally', () => {
  const code = qrcode(0, 'M');
  code.addData('https://example.test/voice-practice.html#id=abc&token=secret');
  code.make();
  assert.ok(code.getModuleCount() >= 21);
  assert.equal(typeof code.isDark(0, 0), 'boolean');
});

test('one meaningful spoken transcript completes participation without matching or model grading', async () => {
  const app = mobileFixture({ recognition: {}, claimStatus: 'ready', serverData: { completed: true } });
  await tick();
  const get = id => app.elements.get(id);
  assert.equal(get('mobile-voice-question').textContent, EN_PASSAGE);
  speakFinal(app, 'A completely unrelated but meaningful spoken sentence.');
  await get('mobile-send-answer').click();
  assert.equal(JSON.parse(app.requests.find(request => request.url.endsWith('/voice/mobile/answer')).options.body).transcript,
    'A completely unrelated but meaningful spoken sentence.');
  assert.equal(get('mobile-voice-status').textContent, 'Read-aloud complete. Your participation is recorded.');
  assert.match(get('mobile-voice-result').textContent, /No graded MP reward/);
  assert.equal(get('mobile-speak').disabled, true);
  assert.equal(get('mobile-send-answer').disabled, true);
  assert.equal(get('mobile-voice-question').textContent, EN_PASSAGE);
  assert.equal(app.timers.size, 0);
});

test('graded readings display the server grade and MP after asynchronous processing, never a local pass', async () => {
  for (const [answerOutcome, gradeResult, expected] of [
    ['passed', { passed: true, score: 85, feedback: 'Good coverage.', mpAwarded: 10,
      breakdown: { coverage: 60, content: 25 } }, /Grade: 85\/100.*Good coverage.*Coverage: 60.*Content: 25.*MP earned: 10/],
    ['retry', { passed: false, score: 45, feedback: 'Read the whole passage.', mpAwarded: 0 }, /Grade: 45\/100.*MP earned: 0/],
    ['retry', { passed: false, error: 'processing_failed' }, /Grading could not finish.*No grade or MP/],
  ]) {
    const app = mobileFixture({ recognition: {}, claimStatus: 'ready',
      serverData: { mode: 'graded_read_aloud' }, immediateResult: false, answerOutcome, gradeResult });
    await tick();
    speakFinal(app, EN_PASSAGE);
    await app.api.submitTranscript();
    assert.match(app.elements.get('mobile-voice-result').textContent, expected);
    assert.equal(app.elements.get('mobile-speak').disabled, answerOutcome === 'passed');
    assert.equal(app.timers.size, 0);
  }
});

test('automatic phone checks are bounded and stop on expiry, connection failure and page exit', async () => {
  for (const sessionHttpStatus of [401, 503]) {
    const app = mobileFixture({ recognition: {}, claimStatus: 'evaluating', sessionHttpStatus });
    await tick();
    await app.advanceRefresh();
    assert.equal(app.timers.size, 0);
    app.listeners.get('pagehide')();
  }
  const app = mobileFixture({ recognition: {}, claimStatus: 'evaluating', questionStatus: 'evaluating' });
  await tick();
  for (let i = 0; i < 150; i++) await app.advanceRefresh();
  assert.equal(app.requests.length, 151);
  assert.equal(app.timers.size, 0);
  assert.match(app.elements.get('mobile-voice-status').textContent, /taking longer/);
  app.listeners.get('pagehide')();
});

test('used QR and missing session links show one clear error with reading controls hidden', async () => {
  for (const options of [{ claimHttpStatus: 401 }, { hash: '' }]) {
    const app = mobileFixture({ recognition: {}, ...options });
    await tick();
    assert.match(app.elements.get('mobile-voice-status').textContent, /Start a new QR session/);
    assert.equal(app.elements.get('mobile-voice-question').textContent, '');
    assert.equal(app.elements.get('mobile-practice-content').hidden, true);
    assert.equal(app.elements.get('mobile-refresh').hidden, true);
    assert.equal(app.elements.get('mobile-speak').disabled, true);
    assert.equal(app.elements.get('mobile-send-answer').disabled, true);
  }
});

test('temporary pairing errors retain the QR capability and allow a connection retry', async () => {
  const app = mobileFixture({ recognition: {}, claimStatus: 'ready', claimHttpStatus: [503, 200] });
  await tick();
  const get = id => app.elements.get(id);
  assert.match(get('mobile-voice-status').textContent, /internet connection.*Retry connection/);
  assert.equal(get('mobile-practice-content').hidden, true);
  assert.equal(get('mobile-refresh').disabled, false);
  assert.equal(app.windowRef.replaced, undefined);
  await get('mobile-refresh').click();
  assert.equal(app.requests.filter(request => request.url.endsWith('/voice/mobile/claim')).length, 2);
  assert.equal(get('mobile-practice-content').hidden, false);
  assert.equal(get('mobile-voice-question').textContent, EN_PASSAGE);
  assert.deepEqual(app.windowRef.replaced, [null, '', '/voice-practice.html']);
});

test('tab storage recovers a used QR when persistent browser storage is blocked', async () => {
  const tabStorage = new Map();
  mobileFixture({ recognition: {}, claimStatus: 'ready', tabStorage, blockPhoneStorage: true });
  await tick();
  const resumed = mobileFixture({ recognition: {}, claimStatus: 'ready', tabStorage, blockPhoneStorage: true, hash: '' });
  await tick();
  assert.equal(resumed.requests.length, 1);
  assert.match(resumed.requests[0].url, /voice\/mobile\/session$/);
  assert.equal(resumed.elements.get('mobile-voice-question').textContent, EN_PASSAGE);
});

test('mobile pairing preserves read-only transcript, QR capability and immediate legacy result checks', async () => {
  const recognition = {};
  const app = mobileFixture({ recognition, immediateResult: false });
  await tick();
  assert.equal(app.requests.length, 1);
  assert.match(app.requests[0].url, /voice\/mobile\/claim$/);
  assert.equal(app.requests[0].options.headers['x-api-key'], undefined);
  assert.equal(app.requests[0].options.headers.Authorization, undefined);
  assert.deepEqual(app.windowRef.replaced, [null, '', '/voice-practice.html']);
  const get = id => app.elements.get(id);
  assert.equal(get('mobile-refresh').disabled, false);
  assert.equal(app.requests.some(request => request.url.endsWith('/voice/mobile/session')), false);
  await get('mobile-refresh').click();
  assert.equal(get('mobile-voice-question').textContent, EN_PASSAGE);
  app.api.speak();
  assert.equal(recognition.started, true);
  const finalWords = [{ transcript: 'Amazon S3 stores game files' }];
  finalWords.isFinal = true;
  recognition.instance.onresult({ results: [finalWords] });
  app.api.releaseSpeech();
  assert.equal(get('mobile-voice-transcript').textContent, 'Amazon S3 stores game files');
  assert.equal(get('mobile-send-answer').disabled, false);
  await get('mobile-send-answer').click();
  const answer = app.requests.find(request => request.url.endsWith('/voice/mobile/answer'));
  assert.equal(answer.options.headers.Authorization, 'Bearer mobile-secret');
  assert.equal(answer.options.headers['x-api-key'], undefined);
  assert.deepEqual(JSON.parse(answer.options.body), {
    transcript: 'Amazon S3 stores game files', source: 'browser', speechCompleted: true, language: 'en-US',
  });
  assert.equal(app.requests.filter(request => request.url.endsWith('/voice/mobile/session')).length, 2);
  assert.equal(get('mobile-voice-status').textContent, 'Read-aloud complete. Your participation is recorded.');
  assert.equal(app.timers.size, 0);
  app.listeners.get('pagehide')();
  assert.equal(recognition.stopped, true);
});

const speakFinal = (app, text) => {
  app.api.speak();
  app.recognition.instance.onresult({ results: [Object.assign([{ transcript: text }], { isFinal: true })] });
  app.api.releaseSpeech();
};

test('holding keeps recognition continuous; release waits for final words and enables submit', async () => {
  const app = mobileFixture({ recognition: { delayedEnd: true }, claimStatus: 'ready' });
  await tick();
  const get = id => app.elements.get(id);
  const mic = get('mobile-speak');
  mic.events.get('pointerdown')({ button: 0, pointerId: 1, preventDefault() {} });
  const active = app.recognition.instance;
  assert.equal(active.continuous, true);
  assert.equal(active.interimResults, false);
  assert.equal(mic.disabled, false);
  assert.match(mic.textContent, /release when finished/);
  const interim = Object.assign([{ transcript: 'Amazon S3 stores' }], { isFinal: false });
  active.onresult({ results: [interim] });
  assert.equal(get('mobile-send-answer').disabled, true);
  mic.events.get('pointerup')();
  assert.match(mic.textContent, /Finishing/);
  assert.equal(get('mobile-send-answer').disabled, true);
  active.onresult({ results: [Object.assign([{ transcript: 'Amazon S3 stores objects in buckets.' }], { isFinal: true })] });
  active.onend();
  assert.equal(get('mobile-voice-transcript').textContent, 'Amazon S3 stores objects in buckets.');
  assert.equal(get('mobile-send-answer').disabled, false);
  assert.equal(app.timers.size, 0);
});

test('mobile cumulative final revisions replace repeated prefixes and preserve distinct phrases', async () => {
  const app = mobileFixture({ recognition: {}, claimStatus: 'ready' });
  await tick();
  app.api.speak();
  const active = app.recognition.instance;
  const final = text => Object.assign([{ transcript: text }], { isFinal: true });
  const results = [
    final('Amazon'), final('Amazon'), final('Amazon VPC'),
    final('Amazon VPC 為應用程式提供邏輯上隔離嘅網絡'),
    final('Subnet 將網絡地址分開'),
    final('分開方便我安排網頁伺服器同資料庫 round'),
    final('分開方便我安排網頁伺服器同資料庫 round'),
    final('分開方便我安排網頁伺服器同資料庫 round table 決定流量去邊'),
    final('security group 同 network ACL 過濾流量'),
  ];
  active.onresult({ resultIndex: 0, results });
  active.onresult({ resultIndex: results.length - 1, results });
  app.api.releaseSpeech();
  const text = app.elements.get('mobile-voice-transcript').textContent;
  assert.equal(text, 'Amazon VPC 為應用程式提供邏輯上隔離嘅網絡 Subnet 將網絡地址分開 分開方便我安排網頁伺服器同資料庫 round table 決定流量去邊 security group 同 network ACL 過濾流量');
  await app.elements.get('mobile-send-answer').click();
  const answer = app.requests.find(request => request.url.endsWith('/voice/mobile/answer'));
  assert.equal(JSON.parse(answer.options.body).transcript, text);
});

test('recognition snapshots final text instead of retaining mutable browser result objects', async () => {
  const app = mobileFixture({ recognition: {}, claimStatus: 'ready' });
  await tick();
  app.api.speak();
  const active = app.recognition.instance;
  const first = Object.assign([{ transcript: 'Route tables decide routing.' }], { isFinal: true });
  active.onresult({ resultIndex: 0, results: [first] });
  first[0].transcript = 'An unreported browser mutation';
  active.onresult({ resultIndex: 1, results: [first,
    Object.assign([{ transcript: 'Security groups filter traffic.' }], { isFinal: true })] });
  app.api.releaseSpeech();
  assert.equal(app.elements.get('mobile-voice-transcript').textContent,
    'Route tables decide routing. Security groups filter traffic.');
});

test('browser end while held restarts recognition without losing or duplicating previous speech', async () => {
  const app = mobileFixture({ recognition: {}, claimStatus: 'ready' });
  await tick();
  app.api.speak();
  const first = app.recognition.instance;
  const words = Object.assign([{ transcript: 'Amazon S3 stores objects.' }], { isFinal: true });
  first.onresult({ results: [words] });
  first.onresult({ results: [words] });
  assert.equal(app.elements.get('mobile-send-answer').disabled, true);
  first.onend();
  assert.equal(app.timers.size, 1);
  await app.advanceRefresh();
  const second = app.recognition.instance;
  assert.notEqual(first, second);
  second.onresult({ results: [Object.assign([{ transcript: 'Buckets organize them.' }], { isFinal: true })] });
  app.api.releaseSpeech();
  assert.equal(app.elements.get('mobile-voice-transcript').textContent, 'Amazon S3 stores objects. Buckets organize them.');
  assert.equal(app.timers.size, 0);
  assert.equal(app.recognition.instances.length, 2);
});

test('keyboard release and missing browser end recover without leaving submit stuck', async () => {
  const app = mobileFixture({ recognition: { delayedEnd: true }, claimStatus: 'ready' });
  await tick();
  const mic = app.elements.get('mobile-speak');
  mic.events.get('keydown')({ key: ' ', repeat: false, preventDefault() {} });
  app.recognition.instance.onresult({ results: [Object.assign([{ transcript: 'Read this passage aloud.' }], { isFinal: true })] });
  mic.events.get('keyup')({ key: ' ', preventDefault() {} });
  await app.advanceRefresh();
  assert.equal(app.elements.get('mobile-send-answer').disabled, false);
  assert.equal(app.timers.size, 0);
  app.api.speak();
  app.recognition.instance.onend();
  app.api.releaseSpeech();
  assert.equal(app.timers.size, 0);
  assert.equal(app.elements.get('mobile-send-answer').disabled, true);
});

test('submit immediately shows saving state and displays returned completion without waiting for polling', async () => {
  let release;
  const app = mobileFixture({ recognition: {}, claimStatus: 'ready',
    answerGate: new Promise(resolve => { release = resolve; }) });
  await tick();
  speakFinal(app, 'Read this passage aloud.');
  const saving = app.elements.get('mobile-send-answer').click();
  assert.equal(app.elements.get('mobile-send-answer').textContent, 'Submitting...');
  assert.equal(app.elements.get('mobile-voice-result').textContent, '');
  assert.match(app.elements.get('mobile-voice-status').textContent, /Submitting/);
  assert.equal(app.elements.get('mobile-send-answer').disabled, true);
  release();
  await saving;
  assert.match(app.elements.get('mobile-voice-status').textContent, /Read-aloud complete/);
  assert.equal(app.requests.filter(request => request.url.endsWith('/voice/mobile/session')).length, 0);
  assert.equal(app.timers.size, 0);
});

test('submission blockers show a local explanation instead of silently returning', async () => {
  const app = mobileFixture({ recognition: {}, claimStatus: 'ready' });
  await tick();
  await app.api.submitTranscript();
  assert.match(app.elements.get('mobile-voice-status').textContent, /No completed speech/);
  app.api.speak();
  await app.api.submitTranscript();
  assert.match(app.elements.get('mobile-voice-status').textContent, /Release the microphone/);
  app.api.stopRecognition();
  speakFinal(app, 'A long spoken reading. '.repeat(400));
  await app.api.submitTranscript();
  assert.match(app.elements.get('mobile-voice-status').textContent, /6,000-character limit/);
  assert.equal(app.requests.filter(request => request.url.endsWith('/voice/mobile/answer')).length, 0);
});

test('English and Cantonese passages follow language selection immediately and recognition stays pinned', async () => {
  const phoneStorage = new Map();
  const app = mobileFixture({ recognition: {}, claimStatus: 'ready', phoneStorage });
  await tick();
  const get = id => app.elements.get(id);
  const select = get('mobile-voice-language');
  assert.equal(get('mobile-voice-question').textContent, EN_PASSAGE);
  select.value = 'zh-HK';
  select.change();
  assert.equal(get('mobile-voice-question').textContent, ZH_PASSAGE);
  assert.equal(get('mobile-voice-question').lang, 'zh-HK');
  speakFinal(app, '我會用物件儲存遊戲檔案');
  assert.equal(app.recognition.instance.lang, 'zh-HK');
  assert.equal(get('mobile-send-answer').disabled, false);
  select.value = 'en-US';
  select.change();
  assert.equal(get('mobile-voice-question').textContent, EN_PASSAGE);
  assert.equal(get('mobile-voice-transcript').textContent, '');
  assert.equal(get('mobile-send-answer').disabled, true);
  select.value = 'zh-HK';
  select.change();
  speakFinal(app, '我會用物件儲存遊戲檔案');
  await get('mobile-send-answer').click();
  assert.equal(JSON.parse(app.requests.at(-1).options.body).language, 'zh-HK');
  assert.equal(JSON.stringify([...phoneStorage.values()]).includes('遊戲檔案'), false);
  const other = mobileFixture({ recognition: {}, phoneStorage, claimStatus: 'ready',
    hash: '#id=session-2&token=new-token' });
  await tick();
  assert.equal(other.elements.get('mobile-voice-language').value, 'zh-HK');
  assert.equal(other.elements.get('mobile-voice-question').textContent, ZH_PASSAGE);
});

test('configured languages populate the picker, STT locale and submitted language without code changes', async () => {
  const passage = 'Ce service conserve les fichiers de mon jeu.';
  const app = mobileFixture({ recognition: {}, claimStatus: 'ready',
    phoneStorage: new Map([['aws-warrior:voice:language', 'zh-HK']]),
    serverData: { mode: 'graded_read_aloud', defaultLanguage: 'fr-CA', language: 'fr-CA',
      readingTexts: { 'fr-CA': passage },
      languages: [{ id: 'fr-CA', label: 'Français', speechLocale: 'fr-FR' }] } });
  await tick();
  const get = id => app.elements.get(id);
  const select = get('mobile-voice-language');
  assert.equal(select.children.length, 1);
  assert.equal(select.children[0].textContent, 'Français');
  assert.equal(select.value, 'fr-CA');
  assert.equal(get('mobile-voice-question').textContent, passage);
  assert.equal(get('mobile-voice-question').lang, 'fr-CA');
  speakFinal(app, passage);
  assert.equal(app.recognition.instance.lang, 'fr-FR');
  await get('mobile-send-answer').click();
  assert.equal(JSON.parse(app.requests.at(-1).options.body).language, 'fr-CA');
  select.value = 'en-US';
  select.change();
  assert.equal(select.value, 'fr-CA');
  for (const filename of ['game-v2.html', 'voice-practice.html']) {
    const html = readFileSync(new URL('../' + filename, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<option value="(?:en-US|zh-HK)"/);
  }
});

test('configured languages with no translated passage never silently display an English substitute', async () => {
  const app = mobileFixture({ recognition: {}, claimStatus: 'ready', serverData: {
    mode: 'graded_read_aloud', languages: [{ id: 'fr-FR', label: 'Français', speechLocale: 'fr-FR' }],
    readingTexts: { 'en-US': EN_PASSAGE },
  } });
  await tick();
  assert.equal(app.elements.get('mobile-voice-question').textContent, '');
  assert.equal(app.elements.get('mobile-speak').disabled, true);
  assert.equal(app.elements.get('mobile-voice-language').disabled, true);
  assert.match(app.elements.get('mobile-voice-status').textContent, /no available reading language/);
});

test('a ready session with historical completed true still accepts this read-aloud participation', async () => {
  const app = mobileFixture({ recognition: {}, serverData: { completed: true }, claimStatus: 'ready' });
  await tick();
  const get = id => app.elements.get(id);
  assert.equal(get('mobile-speak').disabled, false);
  assert.match(get('mobile-voice-attempts').textContent, /6 of 6 read-aloud attempts/);
});

test('legacy sessions direct learners to a new QR and never invoke the old answer flow', async () => {
  const app = mobileFixture({ recognition: {}, claimStatus: 'ready', serverData: { mode: undefined } });
  await tick();
  const get = id => app.elements.get(id);
  assert.match(get('mobile-voice-status').textContent, /older voice session.*new QR session/i);
  assert.equal(get('mobile-speak').disabled, true);
  assert.equal(get('mobile-send-answer').disabled, true);
});

test('six read-aloud retries block further browser speech', async () => {
  const app = mobileFixture({ recognition: {}, claimStatus: 'ready',
    serverData: { attempts: 6, maxAttempts: 9 } });
  await tick();
  const get = id => app.elements.get(id);
  await app.api.speak();
  await get('mobile-send-answer').click();
  assert.equal(app.recognition.started, undefined);
  assert.equal(app.requests.length, 1);
  assert.equal(get('mobile-speak').disabled, true);
  assert.match(get('mobile-voice-attempts').textContent, /0 of 6 read-aloud attempts/);
  assert.match(get('mobile-voice-status').textContent, /read-aloud retry limit/);
});

test('language changes discard unsent speech and detach stale recognition events', async () => {
  const app = mobileFixture({ recognition: {}, claimStatus: 'ready' });
  await tick();
  const get = id => app.elements.get(id);
  app.api.speak();
  const oldRecognition = app.recognition.instance;
  assert.equal(get('mobile-voice-language').disabled, true);
  get('mobile-voice-language').value = 'zh-HK';
  get('mobile-voice-language').change();
  assert.equal(oldRecognition.onresult, null);
  assert.equal(app.recognition.stopped, true);
  assert.equal(get('mobile-voice-transcript').textContent, '');
  assert.equal(get('mobile-send-answer').disabled, true);
  assert.equal(app.requests.length, 1);
  app.listeners.get('pagehide')();
});
test('unsupported browsers keep the QR unused; denied speech offers permission guidance, never recording or typing', async () => {
  const unsupported = mobileFixture({ recognition: {}, unsupported: true });
  await tick();
  assert.equal(unsupported.elements.get('mobile-speak').disabled, true);
  assert.equal(unsupported.elements.get('mobile-practice-content').hidden, true);
  assert.match(unsupported.elements.get('mobile-voice-status').textContent, /browser.*speech recognition.*QR has not been used/i);
  assert.equal(unsupported.requests.length, 0);
  assert.equal(unsupported.windowRef.replaced, undefined);
  const denied = mobileFixture({ recognition: { denied: true } });
  await tick();
  await denied.elements.get('mobile-refresh').click();
  denied.api.speak();
  assert.match(denied.elements.get('mobile-voice-status').textContent, /denied/i);
  assert.equal(denied.elements.get('mobile-send-answer').disabled, true);
  const html = readFileSync(new URL('../voice-practice.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<input[^>]*type=["'](?:text|search|email|password)|<textarea|contenteditable/i);
  assert.match(html, /read-only speech transcript/i);
  assert.match(html, /does not submit speech or mark this practice complete/i);
  assert.doesNotMatch(html, /api[_-]?key/i);
  assert.doesNotMatch(html, /Audio fallback|mobile-record|mobile-upload|mobile-use-recording/);
  assert.doesNotMatch(html, /mobile-speech-consent|voice-consent-note|mobile-media-help/);
  const source = readFileSync(new URL('../v2/voice-practice.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /MediaRecorder|getUserMedia|voice\/mobile\/(?:upload|transcribe)/);
});

test('question approval status hides the prompt and blocks speaking until teacher approval', async () => {
  const app = mobileFixture({ recognition: {}, questionStatus: 'awaiting_question_approval' });
  await tick();
  await app.elements.get('mobile-refresh').click();
  assert.equal(app.elements.get('mobile-voice-question').textContent, '');
  assert.equal(app.elements.get('mobile-speak').disabled, true);
  assert.match(app.elements.get('mobile-voice-status').textContent, /teacher is reviewing.*do not read/i);
});

test('network failures clearly offer a result check and do not invent completion', async () => {
  const app = mobileFixture({ recognition: {}, failAnswer: true });
  await tick();
  await app.elements.get('mobile-refresh').click();
  speakFinal(app, 'Amazon S3 stores game files');
  await app.elements.get('mobile-send-answer').click();
  assert.equal(app.elements.get('mobile-voice-transcript').textContent, 'Amazon S3 stores game files');
  assert.equal(app.elements.get('mobile-speak').disabled, false);
  assert.equal(app.elements.get('mobile-send-answer').disabled, false);
  assert.match(app.elements.get('mobile-voice-status').textContent, /HTTP 503.*Refresh passage or result/);
});

test('HTTP 429 distinguishes daily budget, session attempts and temporary gateway throttling', async () => {
  for (const [body, expected] of [
    [{ error: 'Daily voice practice limit reached; try again tomorrow' }, /100 spoken submissions.*08:00 Hong Kong/],
    [{ error: 'Attempt limit reached' }, /6 attempts.*new QR session/],
    [{ message: 'Too Many Requests' }, /temporarily throttled.*retry Submit/],
    [{}, /temporarily throttled/],
  ]) {
    const app = mobileFixture({ recognition: {}, claimStatus: 'ready', answerError: { status: 429, body } });
    await tick();
    speakFinal(app, 'Amazon S3 stores game files');
    await app.api.submitTranscript();
    assert.match(app.elements.get('mobile-voice-status').textContent, expected);
    assert.equal(app.elements.get('mobile-voice-transcript').textContent, 'Amazon S3 stores game files');
  }
});

test('desktop ownership fingerprints do not persist API keys and session checks are explicit', () => {
  assert.notEqual(voiceOwnerFingerprint('key-for-alice'), voiceOwnerFingerprint('key-for-bob'));
  assert.equal(voiceOwnerFingerprint('key-for-alice').includes('key-for-alice'), false);
  const source = readFileSync(new URL('../v2/voice-practice.js', import.meta.url), 'utf8');
  const desktopSource = source.slice(0, source.indexOf('function mobileStatus'));
  assert.doesNotMatch(desktopSource, /setInterval|setTimeout/);
  assert.match(source, /window\.addEventListener\("storage", event => \{\s*if \(event\.key === "api_key"/);
  assert.match(source, /saveDesktopState\(storage, state\)/);
});

function desktopFixture({ apiKey = 'desktop-key', failStart = false, getStatus = 'completed', unsupported = false } = {}) {
  const previous = {
    document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage, fetch: globalThis.fetch, location: globalThis.location,
  };
  const elements = new Map(), windowEvents = new Map(), created = [];
  const values = new Map(), saved = new Map();
  const makeStorage = map => ({
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
  });
  class DesktopElement extends Element {
    appendChild(child) { (this.children ||= []).push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { (this.attributes ||= {})[name] = value; }
    showModal() { this.open = true; }
    focus() {}
    getContext() { return { fillRect() {} }; }
  }
  const documentRef = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new DesktopElement());
      return elements.get(id);
    },
    createElement(tag) { const element = new DesktopElement(); element.tagName = tag; created.push(element); return element; },
    createTextNode(text) { return { textContent: text }; },
  };
  globalThis.document = documentRef;
  globalThis.location = { href: 'https://example.test/game-v2.html', pathname: '/game-v2.html' };
  globalThis.localStorage = makeStorage(values);
  globalThis.sessionStorage = makeStorage(saved);
  const recognition = {};
  class FakeRecognition {
    constructor() { recognition.instance = this; }
    start() { recognition.started = true; }
    stop() { this.onend?.(); }
  }
  globalThis.window = {
    addEventListener: (name, callback) => windowEvents.set(name, callback),
    location: { ...globalThis.location, hash: '' }, localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage, SpeechRecognition: unsupported ? undefined : FakeRecognition,
  };
  values.set('api_key', apiKey);
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (failStart) return response({ message: 'Missing Authentication Token' }, 403);
    if (String(url).endsWith('/transfer')) {
      return response({ id: 'desktop-session', inputDevice: 'phone', pairingToken: 'qr-secret', status: 'pairing' });
    }
    if (String(url).endsWith('/answer')) {
      return response({ id: 'desktop-session', status: 'completed', mode: 'graded_read_aloud',
        result: { passed: true, score: 85, mpAwarded: 10, feedback: 'Good coverage.' } });
    }
    if (options.method === 'POST') {
      return response({ id: 'desktop-session', pairingToken: 'qr-secret', pairCode: '123456',
        serviceId: 's3', serviceLabel: 'Amazon S3', mode: 'graded_read_aloud', inputDevice: 'desktop',
        readingTexts: { 'en-US': EN_PASSAGE, 'zh-HK': ZH_PASSAGE }, question: EN_PASSAGE,
        status: 'ready', expiresAt: 1793195000, attempts: 0, maxAttempts: 6 });
    }
    return response({ id: 'desktop-session', status: getStatus, paired: true,
      inputDevice: 'phone', serviceId: 's3', mode: 'graded_read_aloud',
      readingTexts: { 'en-US': EN_PASSAGE, 'zh-HK': ZH_PASSAGE }, question: EN_PASSAGE,
      result: { passed: true, score: 85, mpAwarded: 10, feedback: 'Good coverage.' } });
  };
  const game = {
    readServices: new Set(), world: { servicePlaques: [] },
    updateMagicUI() { this.updated = true; },
    refreshVoiceWallet() { this.walletRefreshed = true; },
    renderer: { domElement: { focus() {} } },
  };
  const controller = bindVoicePractice(game);
  return {
    previous, documentRef, elements, windowEvents, values, saved, created, requests, game, controller, recognition,
    restore() { Object.assign(globalThis, previous); },
  };
}

test('desktop defaults to PC speech without QR and refreshes authoritative wallet after a passed result', async () => {
  const app = desktopFixture();
  try {
    app.controller.open('s3');
    assert.equal(app.requests.length, 1);
    await tick();
    assert.equal(app.requests.length, 1);
    assert.match(app.requests[0].url, /voice\/sessions$/);
    assert.equal(app.requests[0].options.headers['x-api-key'], 'desktop-key');
    assert.equal(app.requests[0].options.headers.Authorization, undefined);
    assert.equal(app.requests.some(request => /voice\/sessions\/desktop-session$/.test(request.url)), false);
    const saved = JSON.parse(app.saved.get('aws-warrior:voice:desktop'));
    assert.equal(saved.owner, voiceOwnerFingerprint('desktop-key'));
    assert.equal(JSON.stringify(saved).includes('desktop-key'), false);
    assert.equal(app.created.some(element => element.tagName === 'canvas'), false);
    assert.equal(app.elements.get('pc-voice-question').textContent, EN_PASSAGE);
    assert.equal(app.elements.get('pc-speak').disabled, false);
    assert.equal(app.elements.get('voice-start').disabled, false);
    assert.equal(app.elements.get('voice-transfer').disabled, false);
    await app.elements.get('voice-check').click();
    await tick();
    assert.match(app.requests[1].url, /voice\/sessions\/desktop-session$/);
    assert.equal(app.game.readServices.has('s3'), true);
    assert.equal(app.values.get('aws-warrior:v2:read-services'), '["s3"]');
    assert.equal(app.game.walletRefreshed, true);
    assert.match(app.elements.get('pc-voice-result').textContent, /Grade: 85\/100.*MP earned: 10/);
    assert.equal(app.elements.get('voice-desktop-panel').children.length, 0);
    assert.equal(app.elements.get('pc-practice-content').hidden, true);
    assert.equal(app.elements.get('voice-start').hidden, true);
    const requests = app.requests.length;
    await app.elements.get('voice-start').click();
    assert.equal(app.requests.length, requests);
  } finally { app.restore(); }
});

test('desktop starts voice for services outside the original six-service pilot', async () => {
  const app = desktopFixture();
  try {
    app.controller.open('ecs');
    await tick();
    assert.equal(JSON.parse(app.requests[0].options.body).serviceId, 'ecs');
    assert.equal(app.elements.get('pc-speak').disabled, false);
  } finally { app.restore(); }
});

test('desktop transfers the same session explicitly and removes consumed QR codes', async () => {
  const app = desktopFixture({ getStatus: 'ready' });
  try {
    app.controller.open('vpc');
    await tick();
    assert.equal(app.created.some(element => element.tagName === 'canvas'), false);
    await app.elements.get('voice-transfer').click();
    assert.match(app.requests[1].url, /sessions\/desktop-session\/transfer$/);
    assert.ok(app.elements.get('voice-desktop-panel').children.some(element => element.tagName === 'canvas'));
    assert.equal(app.elements.get('pc-practice-content').hidden, true);
    await app.elements.get('voice-check').click();
    const children = app.elements.get('voice-desktop-panel').children;
    assert.equal(children.some(element => element.tagName === 'canvas'), false);
    assert.ok(children.some(element => /already connected a phone/.test(element.textContent)));
    assert.equal(app.elements.get('voice-transfer').disabled, true);
  } finally { app.restore(); }
});

test('PC uses hold-to-speak and authenticated submission, then shows grade and refreshes MP', async () => {
  const app = desktopFixture();
  try {
    app.controller.open('s3');
    await tick();
    app.controller.speech.speak();
    assert.equal(app.recognition.started, true);
    app.recognition.instance.onresult({ results: [Object.assign([{ transcript: EN_PASSAGE }], { isFinal: true })] });
    assert.equal(app.elements.get('pc-send-answer').disabled, true);
    app.controller.speech.releaseSpeech();
    assert.equal(app.elements.get('pc-send-answer').disabled, false);
    await app.controller.speech.submitTranscript();
    const sent = app.requests.find(request => request.url.endsWith('/answer'));
    assert.equal(sent.options.headers['x-api-key'], 'desktop-key');
    assert.equal(sent.options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(sent.options.body),
      { transcript: EN_PASSAGE, source: 'browser', speechCompleted: true, language: 'en-US' });
    assert.match(app.elements.get('pc-voice-result').textContent, /85\/100.*MP earned: 10/);
    assert.equal(app.elements.get('pc-voice-status').textContent, '');
    assert.equal(app.elements.get('voice-start').hidden, true);
    assert.equal(app.elements.get('voice-desktop-panel').children.length, 0);
    assert.equal(app.game.walletRefreshed, true);
    assert.equal(app.game.readServices.has('s3'), true);
  } finally { app.restore(); }
});

test('PC without speech recognition offers phone transfer without claiming QR automatically', async () => {
  const app = desktopFixture({ unsupported: true });
  try {
    app.controller.open('s3');
    await tick();
    assert.equal(app.elements.get('pc-speak').disabled, true);
    assert.match(app.elements.get('pc-voice-status').textContent, /unavailable/);
    assert.equal(app.elements.get('voice-transfer').disabled, false);
    assert.equal(app.requests.length, 1);
    await app.elements.get('voice-transfer').click();
    assert.equal(app.requests.length, 2);
    assert.equal(app.requests.some(request => request.url.endsWith('/claim')), false);
  } finally { app.restore(); }
});

test('desktop API key changes clear owned session data and disabled endpoints explain unavailability in-dialog', async () => {
  const app = desktopFixture();
  try {
    app.controller.open('s3');
    await tick();
    assert.ok(app.saved.has('aws-warrior:voice:desktop'));
    app.values.set('api_key', 'different-account-key');
    app.windowEvents.get('storage')({ key: 'api_key' });
    assert.equal(app.saved.has('aws-warrior:voice:desktop'), false);
    assert.match(app.elements.get('voice-desktop-panel').children[0].textContent, /API key changed/i);
  } finally { app.restore(); }
  const disabled = desktopFixture({ failStart: true });
  try {
    disabled.controller.open('s3');
    await tick();
    assert.match(disabled.elements.get('voice-desktop-panel').children[0].textContent, /not enabled/i);
    assert.equal(disabled.documentRef.getElementById('service-dialog').open, undefined);
  } finally { disabled.restore(); }
});
