import { baseUrl } from "../src/constant.js";
import { AWS_SERVICES } from "./aws-theme.js?v=20261028-voice-1";
import { qrcode } from "./vendor/qrcode-generator.mjs";

const DESKTOP_KEY = "aws-warrior:voice:desktop";
const MOBILE_KEY = "aws-warrior:voice:mobile";
const LANGUAGE_KEY = "aws-warrior:voice:language";
const MAX_ATTEMPTS = 6;
const SERVICE_SET = new Set(Object.keys(AWS_SERVICES));
const isQuestionAnswer = session => session?.mode === "graded_question_answer";
const readingTaskLabel = session => Number.isInteger(session?.round) && session.round > 0
  ? `Reading task ${session.round}` : "Reading task";
export const isAnswerTranscript = value => typeof value === "string" && /[\p{L}\p{N}]/u.test(value);

export function voiceLanguageOptions(session) {
  const texts = (isQuestionAnswer(session) ? session.questionTexts : session?.readingTexts) ?? {};
  const options = Array.isArray(session?.languages) ? session.languages :
    Object.keys(texts).map(id => {
      let label = id;
      try { label = new Intl.DisplayNames([id], { type: "language" }).of(id); } catch { /* Use the locale identifier. */ }
      return { id, label, speechLocale: id };
    });
  return options.filter(option => typeof option.id === "string" && typeof option.label === "string" &&
    typeof option.speechLocale === "string" && typeof texts[option.id] === "string" && texts[option.id].trim());
}

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
    if (Number.isFinite(saved.expiresAt) && saved.expiresAt * 1000 <= Date.now()) {
      saved.status = "expired";
    }
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
  if (error?.status === 404 && /session not found/i.test(error.apiMessage || "")) return null;
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
  const unspaced = (value.match(/\p{L}/gu) || []).filter(letter => !/\p{Script=Latin}/u.test(letter));
  if (unspaced.length >= 6 && new Set(unspaced).size >= 3) return true;
  return words.length >= 2 && words.join("").length >= 8;
}

export function voiceResultPassed(data) {
  return data?.status === "passed" || data?.result?.passed === true;
}

function resultBreakdownText(breakdown) {
  if (!breakdown || typeof breakdown !== "object") return "";
  const parts = ["coverage", "content", "understanding"]
    .filter(key => breakdown[key] !== undefined && breakdown[key] !== null)
    .map(key => `${key[0].toUpperCase() + key.slice(1)}: ${breakdown[key]}`);
  return parts.length ? ` ${parts.join(" · ")}.` : "";
}

export function voiceStatusMessage(status, questionAnswer = false) {
  if (questionAnswer && ["pairing", "ready", "evaluating", "retry"].includes(status)) return ({
    pairing: "Scan the QR code to answer this question on your phone.",
    ready: "The question is ready. Answer in your own words.",
    evaluating: "Your answer is being graded. The result will appear automatically.",
    retry: "Try answering the same question again in your own words.",
  })[status];
  return ({
    pairing: "Scan the QR code with your phone to pair this read-aloud practice.",
    claimed: "Phone connected. Open the passage on your phone and read it aloud.",
    generating_question: "Preparing the reading passage. It will appear automatically.",
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
  if (state.status === "completed") return;
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
    statusParagraph(panel, "This QR has already connected a phone and cannot pair another browser. Continue this task in the original phone tab.");
  } else {
    statusParagraph(panel, "This QR is no longer available. Refresh to check the task status.");
  }
  statusParagraph(panel, state.status === "ready" && state.result?.passed === false
    ? isQuestionAnswer(state) ? "Retry the question in the original phone tab. Refresh, then answer in your own words."
      : "Try again in the original phone tab: tap Refresh, then read the displayed passage aloud. If that tab is unavailable, start a new QR session."
    : voiceStatusMessage(state.status, isQuestionAnswer(state)), "voice-session-status");
}

function gradeResultText(data) {
  return Number.isInteger(data.result?.score)
    ? `Grade: ${data.result.score}/100. ${data.result.feedback || ""}${resultBreakdownText(data.result.breakdown)} MP earned: ${data.result.mpAwarded ?? 0}.`
    : data.status === "completed" && voiceResultPassed(data)
      ? "Read-aloud participation is complete. No graded MP reward." : "";
}

export function bindVoicePractice(game) {
  const dialog = document.getElementById("voice-desktop-dialog");
  const panel = document.getElementById("voice-desktop-panel");
  const explain = document.getElementById("service-explain");
  const start = document.getElementById("voice-start");
  const check = document.getElementById("voice-check");
  const transfer = document.getElementById("voice-transfer");
  const pcContent = document.getElementById("pc-practice-content");
  const result = document.getElementById("pc-voice-result");
  const taskType = document.getElementById("voice-task-type");
  const readingOption = document.getElementById("voice-reading-option");
  const questionOption = document.getElementById("voice-question-option");
  const availability = document.getElementById("voice-question-availability");
  let selectedType = "read_aloud";
  let questionActivities = [];
  let readingActivities = [];
  let checkingAvailability = false;
  let availabilityChecked = false;
  let availabilityEpoch = 0;
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
    result.textContent = "";
    state = null;
    owner = null;
    questionActivities = [];
    readingActivities = [];
    checkingAvailability = false;
    availabilityChecked = false;
    availabilityEpoch++;
    questionOption.disabled = true;
    readingOption.disabled = true;
    availability.textContent = "";
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
  const canStartTask = () => !state || ["failed", "expired", "cancelled"].includes(state.status);
  const taskAvailable = type => (type === "question_answer" ? questionActivities : readingActivities)
    .some(activity => !activity.onCooldown);
  const updateButtons = () => {
    start.hidden = !canStartTask();
    start.disabled = start.hidden || starting || checkingAvailability || speech.isBusy() ||
      state?.status === "evaluating" || !taskAvailable(selectedType);
    start.textContent = state ? "Retry task" : "Start task";
    check.disabled = !state || starting || checkingAvailability || speech.isBusy();
    if (!state || state.status === "completed" || state.status === "expired") check.hidden = true;
    else if (state.inputDevice === "phone") {
      check.hidden = false;
      check.textContent = "Check phone connection";
    }
    transfer.disabled = starting || checkingAvailability || !state || state.status !== "ready" ||
      state.inputDevice === "phone" || speech.isBusy();
    transfer.textContent = "Use phone microphone (QR)";
    taskType.disabled = starting || checkingAvailability || speech.isBusy() || state?.status === "evaluating";
    const availableOptions = [readingOption, questionOption].filter(option => !option.disabled);
    taskType.replaceChildren(...availableOptions);
    taskType.hidden = availableOptions.length < 2;
    taskType.value = selectedType;
    if (!state && selectedType === "question_answer") {
      start.textContent = "Start Q&A";
      start.disabled ||= !questionActivities.some(activity => !activity.onCooldown);
    }
  };
  const getAvailability = async serviceId => {
    const current = readOwner();
    if (!current.key) throw new Error("Set your API key to check available tasks.");
    const data = await jsonRequest("voice/completions", { apiKey: current.key });
    if (current.fingerprint !== readOwner().fingerprint) throw new Error("The API key changed.");
    return (data.activities ?? []).filter(activity => activity.serviceId === serviceId);
  };
  const showTaskChoices = () => {
    document.getElementById("voice-desktop-title").textContent =
      `${AWS_SERVICES[selectedService]?.label || "AWS"} - Available voice tasks`;
    document.getElementById("voice-desktop-intro").textContent =
      "Choose an available task, then start. Passing reading locks all reading for this service for one week. Q&A questions have separate one-week locks.";
    speech.suspend();
    panel.replaceChildren();
    result.textContent = "";
    updateButtons();
  };
  const loadTaskAvailability = async () => {
    const epoch = ++availabilityEpoch, serviceId = selectedService, current = readOwner();
    questionActivities = [];
    readingActivities = [];
    checkingAvailability = true;
    availabilityChecked = false;
    questionOption.disabled = true;
    readingOption.disabled = true;
    availability.textContent = "Checking available tasks...";
    updateButtons();
    try {
      if (!current.key) throw new Error("No key");
      const activities = await getAvailability(serviceId);
      if (epoch !== availabilityEpoch || serviceId !== selectedService || current.fingerprint !== readOwner().fingerprint) return;
      readingActivities = activities.filter(activity => activity.type === "read_aloud");
      availabilityChecked = true;
      questionActivities = activities.filter(activity =>
        activity.type === "question_answer" && activity.serviceId === serviceId && activity.available === true &&
        Array.isArray(activity.languages) && activity.languages.length);
      const unlocked = questionActivities.filter(activity => !activity.onCooldown);
      readingOption.disabled = !taskAvailable("read_aloud");
      questionOption.disabled = !unlocked.length;
      const unlock = Math.max(0, ...readingActivities.map(activity => activity.availableAt || 0));
      const readingText = readingOption.disabled
        ? unlock > Date.now() / 1000 ? `Read aloud: Locked until ${new Date(unlock * 1000).toLocaleString()}.`
          : "Read aloud: Unavailable."
        : "Read aloud: Available.";
      readingOption.textContent = readingOption.disabled ? "Read aloud (locked)" : "Read aloud (5-15 MP)";
      availability.textContent = `${readingText} ` + (questionActivities.length
        ? `Q&A: ${questionActivities.filter(activity => activity.completed).length} of ${questionActivities.length} approved questions completed. ${unlocked.length} available now. Passed tasks unlock again after one week.${!unlocked.length ? ` Next unlock: ${new Date(Math.min(...questionActivities.map(activity => activity.availableAt)) * 1000).toLocaleString()}.` : ""}`
        : "Q&A: Questions coming soon.");
      if (state?.status === "ready" && (state.mode === "graded_read_aloud" && readingOption.disabled ||
          isQuestionAnswer(state) && questionActivities.some(a => a.activityId === state.activityId && a.onCooldown))) {
        state = null;
        try { sessionStorage.removeItem(DESKTOP_KEY); } catch { /* Optional session recovery. */ }
      }
      if (!state && !taskAvailable(selectedType))
        selectedType = taskAvailable("question_answer") ? "question_answer" : "read_aloud";
      if (!state) showTaskChoices();
    } catch {
      if (epoch !== availabilityEpoch) return;
      questionActivities = [];
      readingActivities = [];
      availability.textContent = "Task availability could not be checked. Reopen this service to retry.";
    }
    if (epoch !== availabilityEpoch) return;
    checkingAvailability = false;
    updateButtons();
  };
  const render = () => {
    sessionError = null;
    panel.replaceChildren();
    result.textContent = "";
    if (state) {
      document.getElementById("voice-desktop-title").textContent =
        isQuestionAnswer(state) ? `${state.serviceLabel || "AWS"} Q&A`
          : `${state.serviceLabel || AWS_SERVICES[state.serviceId]?.label || "AWS"} - ${readingTaskLabel(state)}`;
      document.getElementById("voice-desktop-intro").textContent = isQuestionAnswer(state)
        ? "Answer in your own words. Scores assess understanding, not pronunciation. First pass earns 10 MP at 60, 20 MP at 75, or 30 MP at 90; wallet cap 100 MP."
        : `${readingTaskLabel(state)}. Passing locks all reading for this service for one week. Q&A stays separate. Scores assess recognised content, not pronunciation or comprehension. First pass earns 5 MP at 60, 10 MP at 75, or 15 MP at 90; wallet cap 100 MP.`;
      if (state.inputDevice === "phone" || state.status === "pairing") {
        speech.suspend();
        drawPairing(panel, state);
        result.textContent = gradeResultText(state);
        result.lang = state.result?.language || state.language || state.defaultLanguage || "";
      } else {
        speech.setSession(state);
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
    if (isQuestionAnswer(data)) {
      const activity = questionActivities.find(activity => activity.activityId === data.activityId) ??
        questionActivities.find(activity => !activity.completed && !activity.onCooldown);
      if (activity) {
        activity.completed = true;
        activity.onCooldown = true;
        activity.availableAt = Math.floor(Date.now() / 1000) + 7 * 86400;
      }
      questionOption.disabled = !questionActivities.some(activity => !activity.onCooldown);
      availability.textContent = `Q&A: ${questionActivities.filter(activity => activity.completed).length} of ${questionActivities.length} approved questions completed. Passed questions are locked for one week.`;
      return;
    }
    game.readServices?.add(data.serviceId);
    for (const activity of readingActivities) {
      activity.onCooldown = true;
      activity.availableAt = Math.floor(Date.now() / 1000) + 7 * 86400;
    }
    readingOption.disabled = true;
    readingOption.textContent = "Read aloud (locked)";
    availability.textContent = "Read aloud: Passed and locked for one week. Q&A questions are separate.";
    try { localStorage.setItem("aws-warrior:v2:read-services", JSON.stringify([...game.readServices])); }
    catch { /* Discovery state is cosmetic, never a source of MP. */ }
    for (const plaque of game.world?.servicePlaques || []) {
      if (plaque.userData.awsService === data.serviceId) plaque.userData.setRead(true);
    }
    game.refreshServiceReader?.();
  };
  const speech = bindMobileVoicePractice({
    autoConnect: false,
    toggleSpeech: true,
    documentRef: {
      getElementById: id => document.getElementById(id === "mobile-refresh" ? "voice-check" : id.replace(/^mobile-/, "pc-")),
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
    onSessionUnavailable: async () => {
      if (!state) return;
      state = { ...state, status: "expired" };
      saveDesktopState(sessionStorage, state);
      render();
      await recoverExpiredTask();
    },
  });
  const open = serviceId => {
    if (!SERVICE_SET.has(serviceId)) return;
    selectedService = serviceId;
    selectedType = "read_aloud";
    questionActivities = [];
    readingActivities = [];
    generation++;
    speech.suspend();
    document.getElementById("voice-desktop-title").textContent =
      `${AWS_SERVICES[serviceId].label} - Available voice tasks`;
    document.getElementById("voice-desktop-intro").textContent = "Checking your saved task availability...";
    const current = readOwner();
    owner = current.fingerprint || null;
    state = current.fingerprint ? readDesktopState(sessionStorage, current.fingerprint, serviceId) : null;
    if (isQuestionAnswer(state)) {
      selectedType = "question_answer";
    }
    if (state?.status === "completed") state = null;
    if (selectedType === "question_answer" && !state) {
      document.getElementById("voice-desktop-title").textContent = `${AWS_SERVICES[serviceId].label} Q&A`;
      document.getElementById("voice-desktop-intro").textContent =
        "Choose an available question for this service. Passed questions unlock after one week; MP is awarded only on the first pass.";
    }
    result.textContent = "";
    panel.replaceChildren();
    statusParagraph(panel, current.key
      ? "Checking available tasks. Your API key stays on this computer."
      : "Voice practice needs the API key saved on this computer. Set Key, then reopen this dialog.");
    updateButtons();
    if (!dialog.open) dialog.showModal();
    game.readingService = true;
    (start.hidden ? check : start).focus();
    const epoch = generation;
    loadTaskAvailability().then(() => {
      if (!dialog.open || epoch !== generation || current.fingerprint !== readOwner().fingerprint || !availabilityChecked) return;
      if (state?.status === "expired" && current.key) recoverExpiredTask(Promise.resolve());
      else if (state && current.key) { render(); checkStatus(); }
    });
  };
  const recoverExpiredTask = async (availabilityReady) => {
    const expired = state, epoch = generation, current = readOwner();
    showSessionError("This task session expired. Reopening the same service task...");
    await (availabilityReady ?? loadTaskAvailability());
    if (state !== expired || epoch !== generation || current.fingerprint !== readOwner().fingerprint) return;
    await startSession();
  };
  const startSession = async () => {
    if (starting || checkingAvailability || speech.isBusy() || !canStartTask() || !taskAvailable(selectedType)) return;
    if (selectedType === "question_answer" && !questionActivities.some(activity => !activity.onCooldown)) return;
    let current;
    try { current = currentKey(); }
    catch (error) { showError(error.message); return; }
    start.disabled = true;
    starting = true;
    const epoch = ++generation;
    speech.suspend();
    result.textContent = "";
    start.textContent = "Starting voice practice…";
    panel.replaceChildren();
    statusParagraph(panel, "Preparing your next unfinished voice activity...");
    try {
      const created = await jsonRequest("voice/sessions", {
        method: "POST", apiKey: current.key, body: { serviceId: selectedService,
          ...(selectedType === "question_answer" ? { type: selectedType,
            language: (() => {
              const preferred = document.getElementById("pc-voice-language").value || localStorage.getItem(LANGUAGE_KEY);
              return questionActivities.some(activity => activity.languages.includes(preferred))
                ? preferred : questionActivities[0].languages[0];
            })() } : {}) },
      });
      if (epoch !== generation || current.fingerprint !== readOwner().fingerprint) return;
      if (!created || typeof created.id !== "string" || created.serviceId !== selectedService)
        throw new Error("The voice service returned an invalid activity.");
      state = { ...created, owner: current.fingerprint };
      saveDesktopState(sessionStorage, state);
      render();
    } catch (error) {
      if (epoch !== generation) return;
      if (error.status === 409) await loadTaskAvailability();
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
    const epoch = generation, sessionId = state.id;
    check.disabled = true;
    try {
      const response = await authenticatedRequest("");
      if (current.fingerprint !== readOwner().fingerprint) throw new Error("The API key changed.");
      state = { ...state, ...response, id: state.id,
        owner: current.fingerprint, pairingToken: state.pairingToken };
      recordCompletion(state);
      if (state.status === "completed" || state.result?.score !== undefined) game.refreshVoiceWallet?.();
      saveDesktopState(sessionStorage, state);
      render();
    } catch (error) {
      if (epoch !== generation || sessionId !== state?.id || current.fingerprint !== readOwner().fingerprint) return;
      if ((error.status === 410 ||
          (error.status === 404 && /session not found/i.test(error.apiMessage || ""))) && state) {
        state = { ...state, status: "expired" };
        saveDesktopState(sessionStorage, state);
        render();
        await recoverExpiredTask();
      } else {
        showSessionError(unavailableMessage(error) ||
          "Connection interrupted. Your task is saved. Choose Retry connection.");
        check.hidden = false;
        check.textContent = "Retry connection";
      }
    }
  };
  explain.onclick = () => open(selectedService);
  taskType.addEventListener("change", () => {
    if (starting || checkingAvailability || speech.isBusy() || state?.status === "evaluating" ||
        !["read_aloud", "question_answer"].includes(taskType.value) ||
        !taskAvailable(taskType.value)) {
      taskType.value = selectedType;
      return;
    }
    selectedType = taskType.value;
    generation++;
    speech.suspend();
    state = null;
    try { sessionStorage.removeItem(DESKTOP_KEY); } catch { /* Optional session recovery. */ }
    result.textContent = "";
    panel.replaceChildren();
    document.getElementById("voice-desktop-title").textContent = selectedType === "question_answer"
      ? `${AWS_SERVICES[selectedService].label} Q&A` : `Read ${AWS_SERVICES[selectedService].label} aloud`;
    document.getElementById("voice-desktop-intro").textContent = selectedType === "question_answer"
      ? "Answer an approved question in your own words. Passing earns 10, 20 or 30 MP once per question."
      : "Read a passage aloud. Passing earns 5, 10 or 15 MP once per activity.";
    updateButtons();
  });
  start.onclick = async () => {
    const phone = state?.inputDevice === "phone" && state.status !== "completed";
    await startSession();
    if (phone && state?.inputDevice === "desktop" && state.status === "ready") await transfer.onclick();
  };
  transfer.onclick = async () => {
    if (checkingAvailability || speech.isBusy() || !state || state.status !== "ready") return;
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
    if (dialog.open) return;
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
  return { open, speech, getAvailability };
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
  toggleSpeech = false,
  requestSession,
  requestAnswer,
  onSession = () => {},
  onSessionUnavailable,
} = {}) {
  SpeechRecognitionClass ??= windowRef?.SpeechRecognition || windowRef?.webkitSpeechRecognition;
  const get = id => documentRef.getElementById(id);
  const status = get("mobile-voice-status");
  const question = get("mobile-voice-question");
  const transcript = get("mobile-voice-transcript");
  const result = get("mobile-voice-result");
  const startSpeech = get("mobile-speak");
  const sendAnswer = get("mobile-send-answer");
  const submitStatus = status;
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
  let startupTimer = null;
  let emptyRestarts = 0;
  let submitting = false;
  let finalSpeechReady = false;
  let pendingTurn = null;
  let refreshTimer = null;
  let refreshCount = 0;
  let refreshing = false;
  let connectionFailed = false;
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
      connectionFailed = true;
      updateControls();
      showStatus("Grading is taking longer than expected. Your answer is saved. Choose Check saved result.");
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
  language = typeof language === "string" ? language : null;
  languageSelect.disabled = true;
  let languageOptions = [];

  const hidePairingLink = () => {
    try { windowRef.history.replaceState(null, "", windowRef.location.pathname); } catch { /* Hide pairing secrets when supported. */ }
  };
  const showStatus = text => {
    status.textContent = text;
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
  const isSupported = () => isReadAloud() || isQuestionAnswer(session);
  const taskName = () => isQuestionAnswer(session) ? "answer" : "reading";
  const readingText = () => {
    const localized = (isQuestionAnswer(session) ? session.questionTexts : session?.readingTexts)?.[language];
    if (typeof localized === "string" && localized.trim()) return localized;
    return !isReadAloud() && typeof session?.question === "string" ? session.question : "";
  };
  const canAnswer = () => isSupported() && session?.status === "ready" && Boolean(readingText()) &&
    attemptsUsed() < attemptLimit() && !pendingTurn;
  const isBusy = () => Boolean(recognition || holding || finishing || submitting);
  const updateControls = () => {
    const ready = canAnswer() && !isBusy();
    languageSelect.disabled = isBusy() || !languageOptions.length;
    startSpeech.disabled = !SpeechRecognitionClass || (!holding && !ready);
    startSpeech.textContent = holding ? toggleSpeech ? "Stop speaking" : "Listening... release when finished"
      : finishing ? "Finishing speech..." : toggleSpeech ? "Start speaking" : "Hold to speak";
    startSpeech.setAttribute?.("aria-pressed", String(holding));
    sendAnswer.disabled = !ready || !finalSpeechReady;
    sendAnswer.textContent = submitting ? "Submitting..." : isQuestionAnswer(session) ? "Submit answer" : "Submit spoken reading";
    if (holding || finishing) submitStatus.textContent = holding
      ? toggleSpeech ? "Click Stop speaking before submitting." : "Release the microphone button before submitting."
      : "Waiting for the browser to finish your speech...";
    refreshButton.disabled = isBusy() || refreshing;
    refreshButton.hidden = !connectionFailed;
    refreshButton.textContent = pendingTurn || session?.status === "evaluating"
      ? "Check saved result" : "Retry connection";
  };
  const renderSession = data => {
    session = { ...data, question: data.question ?? session?.question };
    practiceContent.hidden = false;
    connectionFailed = false;
    const heading = get("mobile-question-heading");
    if (heading) heading.textContent = isQuestionAnswer(session) ? "Question"
      : `${readingTaskLabel(session)} - Text to read aloud`;
    if (autoConnect) {
      get("mobile-voice-title").textContent = isQuestionAnswer(session) ? `${data.serviceLabel || "AWS"} Q&A`
        : `${data.serviceLabel || "AWS"} - ${readingTaskLabel(session)}`;
      get("mobile-voice-intro").textContent = isQuestionAnswer(session)
        ? "Answer in your own words. Grades assess understanding, not pronunciation. First pass: 10 MP at 60, 20 MP at 75, 30 MP at 90; wallet cap 100 MP."
        : `${readingTaskLabel(session)}. Passing locks all reading for this service for one week. Q&A stays separate. Grades assess recognised content, not pronunciation or comprehension. First pass: 5 MP at 60, 10 MP at 75, 15 MP at 90; wallet cap 100 MP.`;
    }
    languageOptions = voiceLanguageOptions(session);
    if (!languageOptions.some(option => option.id === language))
      language = [data.language, data.defaultLanguage, languageOptions[0]?.id]
        .find(id => languageOptions.some(option => option.id === id)) ?? null;
    languageSelect.replaceChildren(...languageOptions.map(option => {
      const element = documentRef.createElement("option");
      element.value = option.id;
      element.textContent = option.label;
      return element;
    }));
    languageSelect.value = language || "";
    if (pendingTurn && ["ready", "completed", "failed", "expired", "cancelled"].includes(data.status)) pendingTurn = null;
    const legacy = !isSupported();
    const passedCompletion = data.status === "completed" && voiceResultPassed(data);
    showStatus(legacy
      ? "This is an older voice session. Return to desktop, start a new QR session, and scan it for read-aloud practice."
      : passedCompletion ? mobileStatus("completed")
        : attemptsUsed() >= attemptLimit() && data.status !== "evaluating"
        ? `The ${isQuestionAnswer(session) ? "Q&A" : "read-aloud"} retry limit has been reached. Start a new practice on desktop to continue.`
        : isQuestionAnswer(session) ? voiceStatusMessage(data.status, true) : mobileStatus(data.status));
    result.textContent = gradeResultText(data) || (data.result?.error
        ? "Your reading could not be saved. Please try again or ask your teacher for help."
        : data.result?.passed === false
        ? "I could not hear enough clear speech to count this attempt. Read the displayed passage aloud and try again."
        : "");
    result.lang = data.result?.language || data.language || data.defaultLanguage || language || "";
    question.textContent = !["pairing", "claimed", "generating_question", "awaiting_question_approval"].includes(data.status)
      ? (isSupported() ? readingText() : typeof session.question === "string" ? session.question : "")
      : "";
    question.lang = language || "";
    if (data.status === "ready" && !readingText() && isSupported()) {
      pairingUnavailable(`This activity has no available ${isQuestionAnswer(session) ? "speaking" : "reading"} language. Start a new practice or ask your teacher to check its configuration.`);
    } else if (data.status === "ready" && !session.question) {
      pairingUnavailable("The saved practice has no reading passage. Refresh once; if it is still missing, choose Start a new QR session on desktop and scan that new code.");
    }
    attempts.textContent = `${Math.max(0, attemptLimit() - attemptsUsed())} of ${attemptLimit()} ${isQuestionAnswer(session) ? "answer" : "read-aloud"} attempts remaining.`;
    updateControls();
    if (session.mode === "graded_read_aloud" || isQuestionAnswer(session)) {
      if (data.result?.error) result.textContent = "Grading could not finish. No grade or MP was awarded. Please retry.";
      else if (data.result?.feedback && !Number.isInteger(data.result?.score)) result.textContent = data.result.feedback;
      if (passedCompletion) showStatus(isQuestionAnswer(session)
        ? "Question passed. Your result is saved. This question is locked for one week."
        : `${readingTaskLabel(session)} passed. Your grade and MP reward are saved. All reading for this service is locked for one week. Q&A stays separate.`);
      else if (data.status === "evaluating") showStatus(`Grading your ${taskName()}. Your result will appear automatically.`);
      else if (data.status === "ready" && readingText()) showStatus(isQuestionAnswer(session) ? "Answer in your own words." : "Ready to read aloud.");
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
      if (error.status === 410 ||
          (error.status === 404 && /session not found/i.test(error.apiMessage || ""))) {
        if (onSessionUnavailable) {
          await onSessionUnavailable();
          return;
        }
      }
      if (error.status === 410 || error.status === 401 ||
          (error.status === 404 && /session not found/i.test(error.apiMessage || ""))) {
        for (const storage of [mobileStorage, windowRef.sessionStorage]) {
          try { storage?.removeItem(mobileStorageKey(id)); } catch { /* Optional recovery. */ }
        }
        renderSession({ ...session, question: "", status: "expired" });
        pairingUnavailable("This saved practice has expired or is no longer authorized. Choose Start a new QR session on desktop and scan the new code.");
        refreshButton.hidden = true;
      }
      else {
        connectionFailed = true;
        showStatus("Connection interrupted. Your task is saved. Choose Retry connection.");
        refreshButton.disabled = false;
      }
    } finally { if (epoch === sessionEpoch) { refreshing = false; updateControls(); } }
  };
  const setTranscript = text => {
    transcript.textContent = text;
    finalSpeechReady = isQuestionAnswer(session) ? isAnswerTranscript(text) : isMeaningfulTranscript(text);
    transcript.lang = language || "";
    updateControls();
  };
  const stopRecognition = () => {
    holding = false;
    finishing = false;
    if (restartTimer !== null) unschedule(restartTimer);
    restartTimer = null;
    if (finishTimer !== null) unschedule(finishTimer);
    finishTimer = null;
    if (startupTimer !== null) unschedule(startupTimer);
    startupTimer = null;
    if (!recognition) return;
    const active = recognition;
    recognition = null;
    active.onaudiostart = active.onresult = active.onerror = active.onend = null;
    try { (active.abort ?? active.stop).call(active); } catch { /* Already stopped by the browser. */ }
    updateControls();
  };
  const finishSpeech = () => {
    if (finishTimer !== null) unschedule(finishTimer);
    finishTimer = null;
    finishing = false;
    setTranscript(speechParts.join(" ").trim());
    showStatus(finalSpeechReady
      ? isQuestionAnswer(session) ? "Answer captured. Tap Submit answer." : "Reading captured. Tap Submit spoken reading."
      : "No clear speech captured. Use the microphone button to try again.");
    updateControls();
  };
  const startRecognition = () => {
    let active;
    let recognized = [];
    try {
      active = new SpeechRecognitionClass();
      recognition = active;
      active.lang = languageOptions.find(option => option.id === language)?.speechLocale || language;
      active.continuous = true;
      active.interimResults = false;
      const audioStarted = () => {
        if (recognition !== active) return;
        if (startupTimer !== null) unschedule(startupTimer);
        startupTimer = null;
      };
      active.onaudiostart = audioStarted;
      active.onresult = event => {
        if (recognition !== active) return;
        audioStarted();
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
          ? "Microphone or speech recognition was denied. Allow microphone access in browser settings, or use the phone microphone (QR) on desktop."
          : event.error === "audio-capture"
            ? "No working microphone was found. Connect a microphone and try again, or use the phone microphone (QR) on desktop."
            : "Speech recognition failed. Try again, or use the phone microphone (QR) on desktop.");
      };
      active.onend = () => {
        if (recognition !== active) return;
        audioStarted();
        const words = speechText(recognized);
        if (words) speechParts.push(words);
        recognition = null;
        if (holding && !pageClosed) {
          emptyRestarts = words ? 0 : emptyRestarts + 1;
          if (emptyRestarts >= 3) {
            holding = false;
            finishSpeech();
            showStatus("The browser stopped listening. Use the microphone button to try again, or submit the speech already captured.");
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
      startupTimer = schedule(() => {
        if (recognition !== active) return;
        stopRecognition();
        setTranscript("");
        showStatus("Microphone did not start. Check that a microphone is connected and allowed, or use the phone microphone (QR) on desktop.");
      }, 10000);
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
    showStatus(toggleSpeech
      ? "Listening. Click Stop speaking when finished, then submit."
      : isQuestionAnswer(session)
      ? "Listening while you hold. Answer the question, then release the button."
      : "Listening while you hold. Read the passage, then release the button.");
    startRecognition();
  };
  const releaseSpeech = () => {
    if (!holding) return;
    holding = false;
    if (startupTimer !== null) unschedule(startupTimer);
    startupTimer = null;
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
      active.onaudiostart = active.onresult = active.onerror = active.onend = null;
      try { (active.abort ?? active.stop).call(active); } catch { /* Browser already stopped. */ }
    }, 5000);
    try { active.stop(); }
    catch { stopRecognition(); finishSpeech(); }
  };
  const submitTranscript = async () => {
    if (submitting) return;
    if (isBusy()) {
      showStatus(toggleSpeech ? "Click Stop speaking and wait for speech capture to finish before submitting."
        : "Release the microphone button and wait for speech capture to finish before submitting.");
      return;
    }
    if (!canAnswer()) {
      showStatus(attemptsUsed() >= attemptLimit()
        ? `The ${isQuestionAnswer(session) ? "Q&A" : "read-aloud"} retry limit has been reached. Start a new practice on desktop to continue.`
        : "This session is not ready to accept speech. Refresh to check its status.");
      return;
    }
    if (!finalSpeechReady) {
      showStatus("No completed speech is ready to send. Capture and finish your speech before submitting.");
      return;
    }
    if (transcript.textContent.length > 6000) {
      showStatus("The transcript exceeds the 6,000-character limit and was not sent. Use the microphone button to capture a shorter response.");
      return;
    }
    const spoken = { transcript: transcript.textContent, language };
    const epoch = sessionEpoch;
    submitting = true;
    showStatus(`Submitting your ${taskName()}...`);
    result.textContent = "";
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
            ? "The server rejected the spoken transcript (HTTP 400). Capture your speech again, then finish and submit."
            : error.status
              ? `Submission failed (HTTP ${error.status}). Choose Retry connection to check whether your answer was saved before submitting again.`
              : "Submission timed out or could not connect. Choose Retry connection to check whether your answer was saved before submitting again.";
      connectionFailed = !error.status || error.status >= 500;
      updateControls();
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
    if (submitting || !languageOptions.some(option => option.id === languageSelect.value)) {
      languageSelect.value = language || "";
      return;
    }
    language = languageSelect.value;
    languageSelect.value = language;
    resetPending();
    try { mobileStorage?.setItem(LANGUAGE_KEY, language); } catch { /* Optional preference. */ }
    if (isSupported()) {
      question.textContent = ["pairing", "claimed", "generating_question", "awaiting_question_approval"]
        .includes(session?.status) ? "" : readingText();
      question.lang = language;
      showStatus(`Language changed. The matching ${isQuestionAnswer(session) ? "question" : "passage"} is shown above. The previous unsent speech was discarded.`);
    } else {
      showStatus("Language changed. The previous unsent speech was discarded. Start a new QR session for read-aloud practice.");
    }
  });
  startSpeech.addEventListener("pointerdown", event => {
    if (toggleSpeech) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    try { startSpeech.setPointerCapture?.(event.pointerId); } catch { /* Capture may be unavailable to assistive input. */ }
    speak();
  });
  const releaseHold = () => { if (!toggleSpeech) releaseSpeech(); };
  startSpeech.addEventListener("pointerup", releaseHold);
  startSpeech.addEventListener("pointercancel", releaseHold);
  startSpeech.addEventListener("lostpointercapture", releaseHold);
  if (toggleSpeech) startSpeech.onclick = () => holding ? releaseSpeech() : speak();
  startSpeech.addEventListener("keydown", event => {
    if (toggleSpeech) return;
    if (![" ", "Enter"].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) speak();
  });
  startSpeech.addEventListener("keyup", event => {
    if (toggleSpeech) return;
    if (![" ", "Enter"].includes(event.key)) return;
    event.preventDefault();
    releaseSpeech();
  });
  startSpeech.addEventListener("contextmenu", event => event.preventDefault());
  windowRef.addEventListener("pointerup", releaseHold);
  windowRef.addEventListener("pointercancel", releaseHold);
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
      if (session?.id !== data.id) {
        sessionEpoch++; refreshing = false; pendingTurn = null; resetPending();
      }
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
