import { baseUrl } from "../src/constant.js";
import { BUILDING_SERVICES, AWS_SERVICES } from "./aws-theme.js?v=20261028-voice-1";
import { qrcode } from "./vendor/qrcode-generator.mjs";

const DESKTOP_KEY = "aws-warrior:voice:desktop";
const MOBILE_KEY = "aws-warrior:voice:mobile";
const LANGUAGE_KEY = "aws-warrior:voice:language";
const MAX_ATTEMPTS = 6;
const voiceLanguage = value => value === "zh-HK" ? "zh-HK" : "en-US";
const SERVICE_SET = new Set(BUILDING_SERVICES);

function ownerFingerprint(key) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `v1-${(hash >>> 0).toString(16)}`;
}
export const voiceOwnerFingerprint = ownerFingerprint;

function readDesktopState(storage, owner, serviceId) {
  try {
    const saved = JSON.parse(storage.getItem(DESKTOP_KEY));
    if (!saved || saved.owner !== owner || typeof saved.id !== "string" ||
        !SERVICE_SET.has(saved.serviceId)) {
      storage.removeItem(DESKTOP_KEY);
      return null;
    }
    if (saved.serviceId !== serviceId) return null;
    return saved;
  } catch {
    return null;
  }
}

function saveDesktopState(storage, state) {
  try { storage.setItem(DESKTOP_KEY, JSON.stringify(state)); }
  catch { /* The active session remains usable until this page is closed. */ }
}

function apiUrl(path) {
  return new URL(path, baseUrl);
}

export function unavailableMessage(error) {
  const unavailable = error?.status === 404 || error?.status === 501 ||
    (error?.status === 403 && /missing authentication token/i.test(error.apiMessage || "")) ||
    (error?.status === 422 && /lesson unavailable/i.test(error.apiMessage || ""));
  return unavailable
    ? "Voice practice is not enabled for this lesson in this deployment. You can keep learning and playing; try voice practice again when it is available."
    : null;
}

async function jsonRequest(path, { method = "GET", apiKey, bearer, body, fetcher = globalThis.fetch } = {}) {
  const headers = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetcher(apiUrl(path), {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const error = new Error(`Voice practice request failed (${response.status}).`);
    error.status = response.status;
    try {
      const body = await response.json();
      error.apiMessage = typeof body?.message === "string" ? body.message :
        typeof body?.error === "string" ? body.error : "";
    } catch { /* Error bodies are optional; never display server text as HTML. */ }
    throw error;
  }
  return response.status === 204 ? {} : response.json();
}

export function isMeaningfulTranscript(value) {
  if (typeof value !== "string") return false;
  const words = value.match(/[\p{L}\p{N}]+/gu) || [];
  const cjk = value.match(/\p{Script=Han}/gu) || [];
  if (cjk.length >= 6 && new Set(cjk).size >= 3) return true;
  return words.length >= 2 && words.join("").length >= 8;
}

export function voiceResultPassed(data) {
  return data?.status === "passed" || data?.result?.passed === true;
}

function resultBreakdownText(breakdown) {
  if (!breakdown || typeof breakdown !== "object") return "";
  const parts = ["coverage", "content"]
    .filter(key => breakdown[key] !== undefined && breakdown[key] !== null)
    .map(key => `${key === "coverage" ? "Coverage" : "Content"}: ${breakdown[key]}`);
  return parts.length ? ` ${parts.join(" · ")}.` : "";
}

export function voiceStatusMessage(status) {
  return ({
    pairing: "Scan the QR code with your phone to pair this read-aloud practice.",
    claimed: "Phone connected. Open the passage on your phone and read it aloud.",
    generating_question: "Preparing the reading passage. Use Check my result manually to refresh.",
    awaiting_question_approval: "A teacher is reviewing the passage. Do not read it yet; check again manually for an update.",
    ready: "The reading passage is ready. Read it aloud, then check your result.",
    evaluating: "Your reading is being graded. Check again for your grade and MP reward.",
    transcribing: "This older recording session is no longer supported. Start a new QR session for browser speech recognition.",
    completed: "Voice practice complete. Check your saved result and MP balance.",
    retry: "The speech was not clear enough to count. Read the passage aloud again on your phone.",
    failed: "Voice practice could not be completed. You can start a new practice.",
    cancelled: "This voice practice was cancelled.",
    expired: "This voice practice expired. Start a new one to continue.",
  })[status] || "Voice practice is in progress. Check again manually for an update.";
}

function qrCanvas(canvas, text) {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const cells = code.getModuleCount();
  const margin = 4;
  const size = 240;
  const scale = size / (cells + margin * 2);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("QR display is not available in this browser.");
  canvas.width = canvas.height = size;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#111";
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      if (code.isDark(row, column)) {
        const x = Math.floor((column + margin) * scale);
        const y = Math.floor((row + margin) * scale);
        context.fillRect(x, y, Math.ceil(scale), Math.ceil(scale));
      }
    }
  }
}

function statusParagraph(container, message, className = "") {
  const element = document.createElement("p");
  if (className) element.className = className;
  element.textContent = message;
  container.appendChild(element);
  return element;
}

function drawPairing(panel, state) {
  panel.replaceChildren();
  if (state.pairingToken && state.status === "pairing") {
    const url = new URL("./voice-practice.html", location.href);
    url.searchParams.set("v", "20261028-voice-mp-2");
    url.hash = new URLSearchParams({ id: state.id, token: state.pairingToken }).toString();
    const canvas = document.createElement("canvas");
    canvas.className = "voice-qr";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "QR code for secure mobile voice pairing");
    try { qrCanvas(canvas, url.href); panel.appendChild(canvas); }
    catch { statusParagraph(panel, "The local QR code could not be created. Reload this page and try again."); }
    const noKey = document.createElement("p");
    noKey.textContent = "The QR code contains a short-lived pairing token, not your API key.";
    panel.appendChild(noKey);
  } else if (state.paired || state.status === "ready") {
    statusParagraph(panel, "This QR has already connected a phone and cannot pair another browser. Continue in the original phone tab, or choose Start a new QR session above.");
  } else {
    statusParagraph(panel, "This QR is no longer available. Start another practice to get a new QR code.");
  }
  statusParagraph(panel, state.status === "ready" && state.result?.passed === false
    ? "Try again in the original phone tab: tap Refresh, then read the displayed passage aloud. If that tab is unavailable, start a new QR session."
    : voiceStatusMessage(state.status), "voice-session-status");
  if (Number.isInteger(state.result?.score))
    statusParagraph(panel, `Grade: ${state.result.score}/100. ${state.result.feedback || ""}${resultBreakdownText(state.result.breakdown)} MP earned: ${state.result.mpAwarded ?? 0}.`, "voice-feedback");
  else if (state.status === "completed" && voiceResultPassed(state))
    statusParagraph(panel, "Historical participation completed. No graded MP reward.", "voice-feedback");
}

export function bindVoicePractice(game) {
  const dialog = document.getElementById("voice-desktop-dialog");
  const panel = document.getElementById("voice-desktop-panel");
  const explain = document.getElementById("service-explain");
  const start = document.getElementById("voice-start");
  const check = document.getElementById("voice-check");
  const transfer = document.getElementById("voice-transfer");
  const pcContent = document.getElementById("pc-practice-content");
  let selectedService = null;
  let state = null;
  let owner = null;
  let sessionError = null;
  let generation = 0;
  let starting = false;

  const readOwner = () => {
    const key = localStorage.getItem("api_key")?.trim() || "";
    return { key, fingerprint: key ? ownerFingerprint(key) : "" };
  };
  const clearOwnedState = () => {
    generation++;
    speech.suspend();
    state = null;
    owner = null;
    try { sessionStorage.removeItem(DESKTOP_KEY); } catch { /* Optional session recovery. */ }
  };
  const currentKey = () => {
    const current = readOwner();
    if (!current.key) throw new Error("Set your API key on this computer before starting voice practice.");
    if (owner && owner !== current.fingerprint) {
      clearOwnedState();
      throw new Error("The API key changed. Start a new voice practice for this account.");
    }
    owner = current.fingerprint;
    return current;
  };
  const updateButtons = () => {
    start.disabled = starting || speech.isBusy() || state?.status === "evaluating";
    start.textContent = state?.status === "completed" ? "Next voice activity"
      : state?.inputDevice === "phone" ? "Start a new QR session" : state ? "Start another practice" : "Start voice practice";
    check.disabled = !state || starting;
    transfer.disabled = starting || !state || state.status !== "ready" ||
      state.inputDevice === "phone" || speech.isBusy();
    transfer.textContent = "Use phone microphone (QR)";
  };
  const render = () => {
    sessionError = null;
    panel.replaceChildren();
    if (state) {
      document.getElementById("voice-desktop-title").textContent =
        `Read ${state.serviceLabel || AWS_SERVICES[state.serviceId]?.label || "an AWS service"} aloud`;
      if (state.inputDevice === "phone" || state.status === "pairing") {
        speech.suspend();
        drawPairing(panel, state);
      } else {
        speech.setSession(state);
        statusParagraph(panel, "Speak on this computer, or use your phone if this computer has no microphone. Both use the same activity.");
      }
    } else {
      speech.suspend();
    }
    updateButtons();
  };
  const showError = message => {
    sessionError = null;
    panel.replaceChildren();
    statusParagraph(panel, message, "voice-error");
    updateButtons();
  };
  const showSessionError = message => {
    if (!state) return showError(message);
    sessionError?.remove?.();
    sessionError = statusParagraph(panel, message, "voice-error");
    updateButtons();
  };
  const authenticatedRequest = async (action, body) => {
    const current = currentKey();
    const id = state?.id, epoch = generation;
    if (!id) throw new Error("Start a voice activity first.");
    const response = await jsonRequest(`voice/sessions/${encodeURIComponent(id)}${action}`, {
      apiKey: current.key, ...(body ? { method: "POST", body } : {}),
    });
    if (epoch !== generation || current.fingerprint !== readOwner().fingerprint || id !== state?.id)
      throw new Error("The activity or API key changed. Start again for this account.");
    return response;
  };
  const recordCompletion = data => {
    if (data.status !== "completed" || !voiceResultPassed(data) || !SERVICE_SET.has(data.serviceId)) return;
    game.readServices?.add(data.serviceId);
    try { localStorage.setItem("aws-warrior:v2:read-services", JSON.stringify([...game.readServices])); }
    catch { /* Discovery state is cosmetic, never a source of MP. */ }
    for (const plaque of game.world?.servicePlaques || []) {
      if (plaque.userData.awsService === data.serviceId) plaque.userData.setRead(true);
    }
    game.refreshServiceReader?.();
  };
  const speech = bindMobileVoicePractice({
    autoConnect: false,
    documentRef: {
      getElementById: id => document.getElementById(id.replace(/^mobile-/, "pc-")),
      createElement: tag => document.createElement(tag),
    },
    requestSession: () => authenticatedRequest(""),
    requestAnswer: body => authenticatedRequest("/answer", body),
    onSession: data => {
      if (!state || data.id !== state.id) return;
      state = { ...state, ...data };
      saveDesktopState(sessionStorage, state);
      recordCompletion(state);
      if (data.status === "completed" || data.result?.score !== undefined) game.refreshVoiceWallet?.();
      updateButtons();
    },
  });
  const open = serviceId => {
    if (!SERVICE_SET.has(serviceId)) return;
    selectedService = serviceId;
    document.getElementById("voice-desktop-title").textContent =
      `Read ${AWS_SERVICES[serviceId].label} aloud`;
    const current = readOwner();
    owner = current.fingerprint || null;
    state = current.fingerprint ? readDesktopState(sessionStorage, current.fingerprint, serviceId) : null;
    if (state) render();
    else {
      panel.replaceChildren();
      statusParagraph(panel, current.key
        ? "Opening your next voice activity. Your API key stays on this computer."
        : "Voice practice needs the API key saved on this computer. Set Key, then reopen this dialog.");
      updateButtons();
    }
    if (!dialog.open) dialog.showModal();
    game.readingService = true;
    start.focus();
    if (!state && current.key) startSession();
    else if (state && current.key) checkStatus();
  };
  const startSession = async () => {
    if (starting || speech.isBusy() || state?.status === "evaluating") return;
    let current;
    try { current = currentKey(); }
    catch (error) { showError(error.message); return; }
    start.disabled = true;
    starting = true;
    const epoch = ++generation;
    speech.suspend();
    start.textContent = "Starting voice practice…";
    panel.replaceChildren();
    statusParagraph(panel, "Preparing your next unfinished voice activity...");
    try {
      const created = await jsonRequest("voice/sessions", {
        method: "POST", apiKey: current.key, body: { serviceId: selectedService },
      });
      if (epoch !== generation || current.fingerprint !== readOwner().fingerprint) return;
      if (!created || typeof created.id !== "string" || !SERVICE_SET.has(created.serviceId))
        throw new Error("The voice service returned an invalid activity.");
      state = { ...created, owner: current.fingerprint };
      selectedService = created.serviceId;
      saveDesktopState(sessionStorage, state);
      render();
    } catch (error) {
      if (epoch !== generation) return;
      showError(error.message.startsWith("The API key changed") ? error.message :
        error.status === 409 ? error.apiMessage || "All available activities are complete. No repeated MP rewards are available."
          : unavailableMessage(error) || "Could not start voice practice. Check the API connection and try again.");
    } finally { starting = false; updateButtons(); }
  };
  const checkStatus = async () => {
    let current;
    try { current = currentKey(); }
    catch (error) { showError(error.message); return; }
    if (!state) return;
    check.disabled = true;
    try {
      const response = await authenticatedRequest("");
      if (current.fingerprint !== readOwner().fingerprint) throw new Error("The API key changed.");
      state = { ...state, ...response, id: state.id,
        owner: current.fingerprint, pairingToken: state.pairingToken };
      if (voiceResultPassed(state) && state.serviceId && game.readServices instanceof Set) {
        const wasRead = game.readServices.has(state.serviceId);
        game.readServices.add(state.serviceId);
        try { localStorage.setItem("aws-warrior:v2:read-services", JSON.stringify([...game.readServices])); }
        catch { /* Keep the earned in-memory badge available for this play session. */ }
        if (!wasRead) {
          for (const plaque of game.world?.servicePlaques || []) {
            if (plaque.userData.awsService === state.serviceId) plaque.userData.setRead(true);
          }
          game.refreshVoiceWallet?.();
        }
        game.refreshServiceReader?.();
      }
      saveDesktopState(sessionStorage, state);
      render();
    } catch (error) {
      if (error.status === 410 && state) {
        state = { ...state, status: "expired" };
        saveDesktopState(sessionStorage, state);
        render();
      } else showSessionError(unavailableMessage(error) ||
        "Could not refresh the voice result. The session is still saved; retry manually.");
    }
  };
  explain.onclick = () => open(selectedService);
  start.onclick = async () => {
    const phone = state?.inputDevice === "phone" && state.status !== "completed";
    await startSession();
    if (phone && state?.inputDevice === "desktop" && state.status === "ready") await transfer.onclick();
  };
  transfer.onclick = async () => {
    if (speech.isBusy() || !state || state.status !== "ready") return;
    if (starting) return;
    starting = true;
    const epoch = generation;
    transfer.disabled = true;
    speech.suspend();
    pcContent.hidden = true;
    try {
      state = { ...state, ...await authenticatedRequest("/transfer", {}) };
      saveDesktopState(sessionStorage, state);
      render();
    } catch (error) {
      if (epoch !== generation) return;
      render();
      showSessionError(error.apiMessage || error.message || "Could not transfer. Try again.");
    } finally { starting = false; updateButtons(); }
  };
  check.onclick = checkStatus;
  document.getElementById("voice-desktop-close").onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    speech.suspend();
    game.readingService = Boolean(document.getElementById("service-dialog").open);
    game.refreshServiceReader?.();
    document.getElementById("service-dialog").focus?.();
  });
  window.addEventListener("storage", event => {
    if (event.key === "api_key" || event.key === null) {
      clearOwnedState();
      if (dialog.open) showError("The API key changed. This session is no longer available on this account.");
    }
  });
  window.addEventListener("voice-owner-changed", () => {
    clearOwnedState();
    if (dialog.open) showError("The API key changed. Start a voice activity for this account.");
  });
  return { open, speech };
}

function mobileStatus(status) {
  return ({
    pairing: "Scan the current QR code to open your reading passage.",
    claimed: "Phone connected. Refresh to open your reading passage.",
    generating_question: "Preparing your reading passage. It will appear automatically.",
    awaiting_question_approval: "A teacher is reviewing the reading passage. Do not read it yet; refresh manually for an update.",
    ready: "Your reading passage is ready. Read it aloud when you are ready.",
    evaluating: "Your read-aloud participation is processing. The result will appear automatically.",
    transcribing: "This older recording session is no longer supported. Start a new QR session for browser speech recognition.",
    completed: "Read-aloud complete. Your participation is recorded.",
    retry: "Try reading the passage aloud once more.",
    failed: "This read-aloud practice could not be completed. Ask your teacher for help or start again on desktop.",
    expired: "This pairing expired. Return to desktop to start again.",
    cancelled: "This practice was cancelled on desktop.",
  })[status] || "Practice is in progress. Refresh manually for an update.";
}

function speechText(results) {
  const parts = [];
  for (const result of results) {
    if (!result?.isFinal) continue;
    const text = result.text.trim().replace(/\s+/g, " ");
    if (!text) continue;
    const previous = parts.at(-1);
    // Some mobile engines emit cumulative phrase revisions as separate final results.
    const prefix = (full, short) => full.toLowerCase().startsWith(short.toLowerCase()) &&
      (full.length === short.length || /[\s\p{P}\p{Script=Han}]/u.test(full[short.length]) ||
        /\p{Script=Han}/u.test(short.at(-1)));
    if (previous && prefix(text, previous)) parts[parts.length - 1] = text;
    else if (!previous || !prefix(previous, text)) parts.push(text);
  }
  return parts.join(" ");
}

export function bindMobileVoicePractice({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  fetcher = (...args) => globalThis.fetch(...args),
  SpeechRecognitionClass,
  autoConnect = true,
  requestSession,
  requestAnswer,
  onSession = () => {},
} = {}) {
  SpeechRecognitionClass ??= windowRef?.SpeechRecognition || windowRef?.webkitSpeechRecognition;
  const get = id => documentRef.getElementById(id);
  const status = get("mobile-voice-status");
  const question = get("mobile-voice-question");
  const transcript = get("mobile-voice-transcript");
  const result = get("mobile-voice-result");
  const startSpeech = get("mobile-speak");
  const sendAnswer = get("mobile-send-answer");
  const submitStatus = get("mobile-submit-status");
  const refreshButton = get("mobile-refresh");
  const languageSelect = get("mobile-voice-language");
  const attempts = get("mobile-voice-attempts");
  const practiceContent = get("mobile-practice-content");
  const params = new URLSearchParams(windowRef.location.hash.replace(/^#/, ""));
  let id = params.get("id") || "";
  let pairingToken = params.get("token") || "";
  let mobileToken = "";
  const mobileStorage = windowRef.localStorage;
  const mobileStorageKey = sessionId => `${MOBILE_KEY}:${sessionId}`;
  if (autoConnect && !id) {
    try { id = windowRef.sessionStorage?.getItem(MOBILE_KEY) || ""; } catch { /* Optional recovery. */ }
  }
  for (const storage of autoConnect ? [mobileStorage, windowRef.sessionStorage] : []) {
    try {
      const saved = JSON.parse(storage?.getItem(mobileStorageKey(id)) || "null");
      if (saved?.id === id && typeof saved.token === "string" && saved.expiresAt > Date.now()) {
        mobileToken = saved.token;
        break;
      } else if (saved) storage?.removeItem(mobileStorageKey(id));
    } catch { /* Try tab storage if persistent storage is unavailable. */ }
  }
  let session = null;
  let sessionEpoch = 0;
  let recognition = null;
  let holding = false;
  let finishing = false;
  let speechParts = [];
  let restartTimer = null;
  let finishTimer = null;
  let emptyRestarts = 0;
  let submitting = false;
  let finalSpeechReady = false;
  let pendingTurn = null;
  let refreshTimer = null;
  let refreshCount = 0;
  let refreshing = false;
  let pageClosed = false;
  const schedule = windowRef.setTimeout?.bind(windowRef) ?? setTimeout;
  const unschedule = windowRef.clearTimeout?.bind(windowRef) ?? clearTimeout;
  const stopAutoRefresh = () => {
    if (refreshTimer !== null) unschedule(refreshTimer);
    refreshTimer = null;
  };
  const updateAutoRefresh = () => {
    stopAutoRefresh();
    if (pageClosed || !["evaluating", "generating_question"].includes(session?.status)) {
      refreshCount = 0;
      return;
    }
    if (refreshCount >= 150) {
      showStatus("Processing is taking longer than expected. Tap Refresh to check again.");
      return;
    }
    refreshTimer = schedule(() => {
      refreshTimer = null;
      refreshCount++;
      refresh();
    }, 4000);
  };
  let language;
  try { language = mobileStorage?.getItem(LANGUAGE_KEY); } catch { /* Optional preference. */ }
  language = language === "en-US" || language === "zh-HK" ? language : null;
  languageSelect.value = language || "en-US";

  const hidePairingLink = () => {
    try { windowRef.history.replaceState(null, "", windowRef.location.pathname); } catch { /* Hide pairing secrets when supported. */ }
  };
  const showStatus = text => {
    status.textContent = text;
    submitStatus.textContent = text;
  };
  const pairingUnavailable = message => {
    showStatus(message);
    practiceContent.hidden = true;
    question.textContent = "";
    languageSelect.disabled = true;
    startSpeech.disabled = true;
    sendAnswer.disabled = true;
  };
  const tokenRequest = (path, options = {}) => path.endsWith("/answer") && requestAnswer
    ? requestAnswer(options.body)
    : path.endsWith("/session") && requestSession ? requestSession()
      : jsonRequest(path, { ...options, bearer: mobileToken, fetcher });
  const attemptLimit = () => Math.min(MAX_ATTEMPTS,
    Number.isInteger(session?.maxAttempts) && session.maxAttempts > 0 ? session.maxAttempts : MAX_ATTEMPTS);
  const attemptsUsed = () => Number.isInteger(session?.attempts) ? session.attempts : 0;
  const isReadAloud = () => ["read_aloud", "graded_read_aloud"].includes(session?.mode);
  const readingText = () => {
    const localized = session?.readingTexts?.[language || "en-US"];
    if (typeof localized === "string" && localized.trim()) return localized;
    return language !== "zh-HK" && typeof session?.question === "string" ? session.question : "";
  };
  const canAnswer = () => isReadAloud() && session?.status === "ready" && Boolean(readingText()) &&
    attemptsUsed() < attemptLimit() && !pendingTurn;
  const isBusy = () => Boolean(recognition || holding || finishing || submitting);
  const updateControls = () => {
    const ready = canAnswer() && !isBusy();
    languageSelect.disabled = isBusy();
    startSpeech.disabled = !SpeechRecognitionClass || (!holding && !ready);
    startSpeech.textContent = holding ? "Listening... release when finished" : finishing ? "Finishing speech..." : "Hold to speak";
    startSpeech.setAttribute?.("aria-pressed", String(holding));
    sendAnswer.disabled = !ready || !finalSpeechReady;
    sendAnswer.textContent = submitting ? "Submitting..." : "Submit spoken reading";
    if (holding || finishing) submitStatus.textContent = holding
      ? "Release the microphone button before submitting."
      : "Waiting for the browser to finish your speech...";
    refreshButton.disabled = isBusy() || refreshing;
  };
  const renderSession = data => {
    session = { ...data, question: data.question ?? session?.question };
    practiceContent.hidden = false;
    refreshButton.textContent = "Refresh passage or result";
    if (!language) {
      language = voiceLanguage(data.language);
      languageSelect.value = language;
    }
    if (pendingTurn && ["ready", "completed", "failed", "expired", "cancelled"].includes(data.status)) pendingTurn = null;
    const legacy = !isReadAloud();
    const passedCompletion = data.status === "completed" && voiceResultPassed(data);
    showStatus(legacy
      ? "This is an older voice session. Return to desktop, start a new QR session, and scan it for read-aloud practice."
      : passedCompletion ? mobileStatus("completed")
        : attemptsUsed() >= attemptLimit() && data.status !== "evaluating"
        ? "The read-aloud retry limit has been reached. Start a new QR session on desktop to continue."
        : mobileStatus(data.status));
    result.textContent = Number.isInteger(data.result?.score)
      ? `Grade: ${data.result.score}/100. ${data.result.feedback || ""}${resultBreakdownText(data.result.breakdown)} MP earned: ${data.result.mpAwarded ?? 0}.`
      : passedCompletion
      ? "Read-aloud participation is complete. No graded MP reward."
      : data.result?.error
        ? "Your reading could not be saved. Please try again or ask your teacher for help."
        : data.result?.passed === false
        ? "I could not hear enough clear speech to count this attempt. Read the displayed passage aloud and try again."
        : "";
    result.lang = voiceLanguage(data.result?.language || data.language);
    question.textContent = !["pairing", "claimed", "generating_question", "awaiting_question_approval"].includes(data.status)
      ? (isReadAloud() ? readingText() : typeof session.question === "string" ? session.question : "")
      : "";
    question.lang = language || "en-US";
    if (data.status === "ready" && !readingText() && isReadAloud()) {
      pairingUnavailable("The selected language's reading passage is unavailable. Choose the other language or start a new QR session on desktop.");
    } else if (data.status === "ready" && !session.question) {
      pairingUnavailable("The saved practice has no reading passage. Refresh once; if it is still missing, choose Start a new QR session on desktop and scan that new code.");
    }
    attempts.textContent = `${Math.max(0, attemptLimit() - attemptsUsed())} of ${attemptLimit()} read-aloud attempts remaining.`;
    updateControls();
    if (session.mode === "graded_read_aloud") {
      if (data.result?.error) result.textContent = "Grading could not finish. No grade or MP was awarded. Please retry.";
      else if (data.result?.feedback && !Number.isInteger(data.result?.score)) result.textContent = data.result.feedback;
      if (passedCompletion) showStatus("Voice activity passed. Your grade and MP reward have been saved.");
      else if (data.status === "evaluating") showStatus("Grading your reading. Your result will appear automatically.");
      else if (data.status === "ready") showStatus("Read the displayed passage aloud. A grade of 60 or higher earns MP once for this activity.");
    }
    if (!SpeechRecognitionClass && canAnswer())
      showStatus("Browser speech recognition is unavailable. Try a supported browser or ask your teacher for help.");
    onSession(session);
    updateAutoRefresh();
  };
  const claim = async () => {
    if (!id || !pairingToken) {
      pairingUnavailable("No reading session is linked to this page. On your computer, open a service and choose Start a new QR session. Scan that code with your phone.");
      refreshButton.hidden = true;
      return;
    }
    refreshButton.hidden = false;
    refreshButton.disabled = true;
    showStatus("Connecting this phone to the desktop session…");
    try {
      const data = await jsonRequest("voice/mobile/claim", {
        method: "POST", body: { id, pairingToken }, fetcher,
      });
      if (typeof data.mobileToken !== "string" || !data.mobileToken) throw new Error("Invalid mobile pairing response.");
      mobileToken = data.mobileToken;
      pairingToken = "";
      const saved = JSON.stringify({
        id, token: mobileToken, expiresAt: Math.min(
          typeof data.expiresAt === "number" ? data.expiresAt * 1000 : Date.now() + 1200000,
          Date.now() + 1200000),
      });
      for (const storage of [mobileStorage, windowRef.sessionStorage]) {
        try { storage?.setItem(mobileStorageKey(id), saved); }
        catch { /* Either storage can independently recover the active phone tab. */ }
      }
      try {
        windowRef.sessionStorage?.setItem(MOBILE_KEY, id);
      } catch { /* Keep the active phone tab usable without storage. */ }
      hidePairingLink();
      renderSession({ ...data, id });
    } catch (error) {
      const terminal = [400, 401, 403, 404, 409, 410, 422, 501].includes(error.status);
      pairingUnavailable(unavailableMessage(error) || (
        error.status === 410
          ? "This QR code has expired. On your computer, choose Start a new QR session, then scan the new code."
          : error.status === 401 || error.status === 409
            ? "This QR code cannot connect a new browser. If you already opened it, return to that phone tab. Otherwise, on your computer choose Start a new QR session and scan the new code."
            : terminal
              ? "This reading session could not be opened. On your computer, choose Start a new QR session and scan the new code."
              : "Your phone could not connect to the reading session. Check your internet connection, then tap Retry connection."));
      refreshButton.textContent = "Retry connection";
      refreshButton.hidden = terminal;
      refreshButton.disabled = terminal;
      if (terminal) hidePairingLink();
    }
  };
  const refresh = async () => {
    if ((!mobileToken && !requestSession) || refreshing || pageClosed) return;
    const epoch = sessionEpoch;
    stopAutoRefresh();
    refreshing = true;
    refreshButton.disabled = true;
    try {
      const data = await tokenRequest("voice/mobile/session");
      if (!pageClosed && epoch === sessionEpoch) renderSession(data);
    } catch (error) {
      if (pageClosed || epoch !== sessionEpoch) return;
      stopAutoRefresh();
      if (error.status === 410 || error.status === 401) {
        for (const storage of [mobileStorage, windowRef.sessionStorage]) {
          try { storage?.removeItem(mobileStorageKey(id)); } catch { /* Optional recovery. */ }
        }
        renderSession({ ...session, question: "", status: "expired" });
        pairingUnavailable("This saved practice has expired or is no longer authorized. Choose Start a new QR session on desktop and scan the new code.");
        refreshButton.hidden = true;
      }
      else {
        showStatus("Could not refresh the question or result. Check your connection and retry manually.");
        refreshButton.disabled = false;
      }
    } finally { if (epoch === sessionEpoch) { refreshing = false; updateControls(); } }
  };
  const setTranscript = text => {
    transcript.textContent = text;
    finalSpeechReady = isMeaningfulTranscript(text);
    transcript.lang = language || "en-US";
    updateControls();
  };
  const stopRecognition = () => {
    holding = false;
    finishing = false;
    if (restartTimer !== null) unschedule(restartTimer);
    restartTimer = null;
    if (finishTimer !== null) unschedule(finishTimer);
    finishTimer = null;
    if (!recognition) return;
    const active = recognition;
    recognition = null;
    active.onresult = active.onerror = active.onend = null;
    try { (active.abort ?? active.stop).call(active); } catch { /* Already stopped by the browser. */ }
    updateControls();
  };
  const finishSpeech = () => {
    if (finishTimer !== null) unschedule(finishTimer);
    finishTimer = null;
    finishing = false;
    setTranscript(speechParts.join(" ").trim());
    showStatus(finalSpeechReady
      ? "Reading captured. Tap Submit spoken reading."
      : "No clear speech captured. Hold the microphone button and try again.");
    updateControls();
  };
  const startRecognition = () => {
    let active;
    let recognized = [];
    try {
      active = new SpeechRecognitionClass();
      recognition = active;
      active.lang = language || "en-US";
      active.continuous = true;
      active.interimResults = false;
      active.onresult = event => {
        if (recognition !== active) return;
        const start = Number.isInteger(event.resultIndex) ? event.resultIndex : 0;
        recognized.length = event.results.length;
        for (let i = start; i < event.results.length; i++) {
          recognized[i] = { text: event.results[i][0]?.transcript || "", isFinal: event.results[i].isFinal };
        }
        const preview = speechText(recognized);
        transcript.textContent = [...speechParts, preview].filter(Boolean).join(" ");
      };
      active.onerror = event => {
        if (recognition !== active) return;
        if (event.error === "no-speech") return;
        stopRecognition();
        setTranscript("");
        const denied = event.error === "not-allowed" || event.error === "service-not-allowed";
        showStatus(denied
          ? "Microphone or speech recognition was denied. Allow microphone access in browser settings and try again, or ask your teacher for help."
          : "Speech recognition failed. Try speaking again or ask your teacher for help.");
      };
      active.onend = () => {
        if (recognition !== active) return;
        const words = speechText(recognized);
        if (words) speechParts.push(words);
        recognition = null;
        if (holding && !pageClosed) {
          emptyRestarts = words ? 0 : emptyRestarts + 1;
          if (emptyRestarts >= 3) {
            holding = false;
            finishSpeech();
            showStatus("The browser stopped listening. Hold to speak again, or submit the speech already captured.");
          } else {
            restartTimer = schedule(() => {
              restartTimer = null;
              if (holding && !pageClosed) startRecognition();
            }, 200);
          }
        } else finishSpeech();
        updateControls();
      };
      updateControls();
      active.start();
    } catch {
      stopRecognition();
      showStatus("Speech recognition could not start. Check browser microphone permissions and try again, or ask your teacher for help.");
    }
  };
  const speak = () => {
    if (!canAnswer() || isBusy()) return;
    if (!SpeechRecognitionClass) {
      showStatus("Browser speech recognition is unavailable. Try a supported browser or ask your teacher for help.");
      return;
    }
    speechParts = [];
    emptyRestarts = 0;
    holding = true;
    setTranscript("");
    result.textContent = "";
    showStatus("Listening while you hold. Read the passage, then release the button.");
    startRecognition();
  };
  const releaseSpeech = () => {
    if (!holding) return;
    holding = false;
    if (restartTimer !== null) unschedule(restartTimer);
    restartTimer = null;
    if (!recognition) { finishSpeech(); return; }
    finishing = true;
    showStatus("Finishing your speech...");
    updateControls();
    const active = recognition;
    // Bound a missing browser end event after release, not the reading duration.
    finishTimer = schedule(() => {
      finishTimer = null;
      if (recognition !== active) return;
      active.onend?.();
      active.onresult = active.onerror = active.onend = null;
      try { (active.abort ?? active.stop).call(active); } catch { /* Browser already stopped. */ }
    }, 5000);
    try { active.stop(); }
    catch { stopRecognition(); finishSpeech(); }
  };
  const submitTranscript = async () => {
    if (submitting) return;
    if (isBusy()) {
      showStatus("Release the microphone button and wait for Reading captured before submitting.");
      return;
    }
    if (!canAnswer()) {
      showStatus(attemptsUsed() >= attemptLimit()
        ? "The read-aloud retry limit has been reached. Start a new QR session on desktop to continue."
        : "This session is not ready to accept a reading. Tap Refresh passage or result to check its status.");
      return;
    }
    if (!finalSpeechReady) {
      showStatus("No completed speech is ready to send. Hold to speak, then release before submitting.");
      return;
    }
    if (transcript.textContent.length > 6000) {
      showStatus("The transcript exceeds the 6,000-character limit and was not sent. Hold to speak again for a shorter reading.");
      return;
    }
    const spoken = { transcript: transcript.textContent, language: language || "en-US" };
    const epoch = sessionEpoch;
    submitting = true;
    showStatus("Submitting your reading...");
    result.textContent = session.mode === "graded_read_aloud" ? "Saving your reading for grading..." : "Saving your participation...";
    updateControls();
    try {
      const data = await tokenRequest("voice/mobile/answer", {
        method: "POST", body: {
          transcript: spoken.transcript, source: "browser", speechCompleted: true, language: spoken.language,
        },
      });
      if (pageClosed || epoch !== sessionEpoch) return;
      finalSpeechReady = false;
      pendingTurn = true;
      transcript.textContent = "";
      submitting = false;
      renderSession({ ...session, ...data, id: session.id });
      if (data.status === "evaluating") {
        showStatus("Speech submitted. Your grade and MP result will appear automatically.");
        await refresh();
      }
      result.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    } catch (error) {
      if (pageClosed || epoch !== sessionEpoch) return;
      submitting = false;
      renderSession(session);
      const message = error.status === 429
        ? /daily voice practice limit reached/i.test(error.apiMessage || "")
          ? "You have used today's 100 spoken submissions. The daily limit resets at 08:00 Hong Kong time (00:00 UTC)."
          : /^attempt limit reached$/i.test(error.apiMessage || "")
            ? "This session has used its 6 attempts. Start a new QR session on desktop."
            : "Requests are temporarily throttled. Wait a moment, then retry Submit. This does not confirm that your practice limit is reached."
        : error.status === 401 || error.status === 410
          ? "This phone session has expired or lost authorization. Start a new QR session on desktop."
          : error.status === 400
            ? "The server rejected the spoken transcript (HTTP 400). Hold to speak again, then release and submit."
            : error.status
              ? `Submission failed (HTTP ${error.status}). Tap Refresh passage or result to check, then retry Submit.`
              : "Submission timed out or could not connect. Tap Refresh passage or result to check, then retry Submit.";
      showStatus(message);
      submitStatus.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      return;
    }
    submitting = false;
    updateControls();
  };
  const resetPending = () => {
    stopRecognition();
    setTranscript("");
    updateControls();
  };
  languageSelect.addEventListener("change", () => {
    if (submitting) { languageSelect.value = language || "en-US"; return; }
    language = voiceLanguage(languageSelect.value);
    languageSelect.value = language;
    resetPending();
    try { mobileStorage?.setItem(LANGUAGE_KEY, language); } catch { /* Optional preference. */ }
    if (isReadAloud()) {
      question.textContent = ["pairing", "claimed", "generating_question", "awaiting_question_approval"]
        .includes(session?.status) ? "" : readingText();
      question.lang = language;
      showStatus("Language changed. The matching passage is shown above. The previous unsent speech was discarded.");
    } else {
      showStatus("Language changed. The previous unsent speech was discarded. Start a new QR session for read-aloud practice.");
    }
  });
  startSpeech.addEventListener("pointerdown", event => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    try { startSpeech.setPointerCapture?.(event.pointerId); } catch { /* Capture may be unavailable to assistive input. */ }
    speak();
  });
  startSpeech.addEventListener("pointerup", releaseSpeech);
  startSpeech.addEventListener("pointercancel", releaseSpeech);
  startSpeech.addEventListener("lostpointercapture", releaseSpeech);
  startSpeech.addEventListener("keydown", event => {
    if (![" ", "Enter"].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) speak();
  });
  startSpeech.addEventListener("keyup", event => {
    if (![" ", "Enter"].includes(event.key)) return;
    event.preventDefault();
    releaseSpeech();
  });
  startSpeech.addEventListener("contextmenu", event => event.preventDefault());
  windowRef.addEventListener("pointerup", releaseSpeech);
  windowRef.addEventListener("pointercancel", releaseSpeech);
  windowRef.addEventListener("blur", releaseSpeech);
  sendAnswer.onclick = submitTranscript;
  refreshButton.onclick = () => mobileToken || requestSession ? refresh() : claim();
  windowRef.addEventListener("pagehide", () => {
    pageClosed = true;
    stopAutoRefresh();
    resetPending();
  });
  windowRef.addEventListener("pageshow", () => {
    if (!pageClosed) return;
    pageClosed = false;
    refreshCount = 0;
    refresh();
  });
  if (!autoConnect) practiceContent.hidden = true;
  else if (mobileToken) { hidePairingLink(); refresh(); }
  else if (!SpeechRecognitionClass) {
    pairingUnavailable("This browser does not support speech recognition. Open this QR link in a browser with speech recognition support, or ask your teacher for help. The QR has not been used.");
    refreshButton.hidden = true;
  } else claim();
  return {
    refresh, speak, releaseSpeech, submitTranscript, stopRecognition,
    isBusy,
    setSession(data) {
      if (session?.id !== data.id) { sessionEpoch++; refreshing = false; }
      pageClosed = false;
      renderSession(data);
    },
    suspend() {
      sessionEpoch++;
      pageClosed = true;
      stopAutoRefresh();
      stopRecognition();
      setTranscript("");
      session = null;
      pendingTurn = null;
      submitting = false;
      refreshing = false;
      practiceContent.hidden = true;
      updateControls();
    },
  };
}
