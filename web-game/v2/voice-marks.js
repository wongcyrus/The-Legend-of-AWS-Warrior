import { baseUrl } from "../src/constant.js";
import { validWallet } from "./magic.js?v=20261028-voice-mp-1";

export function bindVoiceMarks({ document = globalThis.document, storage = globalThis.localStorage,
  fetcher = (...args) => globalThis.fetch(...args), eventTarget = globalThis } = {}) {
  const get = id => document.getElementById(id);
  const key = get("voice-marks-key"), button = get("voice-marks-refresh");
  const status = get("voice-marks-status"), results = get("voice-marks-results");
  let revision = 0;
  try { key.value = storage.getItem("api_key") || ""; }
  catch { /* The key can still be entered when storage is unavailable. */ }
  const clear = () => {
    revision++;
    results.hidden = true;
    get("voice-marks-rows").replaceChildren();
    get("voice-marks-activities").replaceChildren();
    get("voice-marks-wallet").textContent = "";
    get("voice-marks-summary").textContent = "";
    status.textContent = "";
    button.disabled = false;
  };
  key.addEventListener("input", clear);
  eventTarget.addEventListener?.("storage", event => {
    if (event.key === "api_key" || event.key === null) {
      clear();
      try { key.value = storage.getItem("api_key") || ""; } catch { key.value = ""; }
    }
  });
  const refresh = async event => {
    event?.preventDefault();
    clear();
    const apiKey = key.value.trim(), request = revision;
    if (!apiKey) { status.textContent = "Enter your game API key to check your marks."; return; }
    button.disabled = true;
    status.textContent = "Checking saved grades and MP...";
    try {
      const response = await fetcher(new URL("voice/completions", baseUrl), {
        headers: { "x-api-key": apiKey }, cache: "no-store", signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403
        ? "Your API key was rejected. Check that you entered the same key as the game."
        : "Could not load voice marks. Please try again.");
      const data = await response.json();
      if (request !== revision || key.value.trim() !== apiKey) return;
      const scoreValid = score => score == null || (Number.isFinite(score) && score >= 0 && score <= 100);
      if (!validWallet(data.wallet) || !Array.isArray(data.activities) ||
          data.activities.some(activity => typeof activity.activityId !== "string" ||
            typeof activity.serviceId !== "string" || typeof activity.label !== "string" ||
            !Number.isInteger(activity.round) || activity.round < 1 ||
            typeof activity.completed !== "boolean" ||
            !scoreValid(activity.bestScore) || !scoreValid(activity.latestScore) ||
            (activity.feedback != null && typeof activity.feedback !== "string") ||
            (activity.mpAwarded != null && (!Number.isSafeInteger(activity.mpAwarded) || activity.mpAwarded < 0)) ||
            (activity.completed && (!Number.isFinite(activity.completedAt) || activity.completedAt <= 0))) ||
          !Array.isArray(data.services) || data.services.length !== 6 ||
          data.services.some(service => typeof service.label !== "string" ||
            typeof service.completed !== "boolean" || (service.completed &&
            (!Number.isFinite(service.completedAt) || service.completedAt <= 0)))) {
        throw new Error("The server returned an invalid result. Please check again.");
      }
      const date = value => Number.isFinite(value) && value > 0 ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short",
      }).format(new Date(value * 1000)) : "-";
      const makeRow = values => {
        const row = document.createElement("tr");
        for (const text of values) {
          const cell = document.createElement("td");
          cell.textContent = text;
          row.append(cell);
        }
        return row;
      };
      const rows = data.services.map(service => makeRow([
        service.label, service.completed ? "Completed (ungraded participation)" : "Not yet completed",
        service.completed ? date(service.completedAt) : "-",
      ]));
      const activityRows = data.activities.map(activity => {
        const graded = activity.bestScore != null || activity.latestScore != null;
        const grades = graded
          ? `Best: ${activity.bestScore ?? "-"} / 100; latest: ${activity.latestScore ?? "-"} / 100`
          : activity.completed ? "Ungraded participation" : "Not graded";
        const reward = activity.mpAwarded != null && graded ? `${activity.mpAwarded} MP` :
          activity.completed && !graded ? "No graded reward recorded" : "-";
        return makeRow([
          activity.label, String(activity.round),
          activity.completed ? "Completed" : graded ? "In progress" : "Not yet completed",
          grades, activity.feedback || "-", reward, activity.completed ? date(activity.completedAt) : "-",
        ]);
      });
      get("voice-marks-rows").replaceChildren(...rows);
      get("voice-marks-activities").replaceChildren(...activityRows);
      const completed = data.activities.filter(activity => activity.completed).length;
      get("voice-marks-summary").textContent = `${completed} of ${data.activities.length} voice activities completed`;
      get("voice-marks-wallet").textContent =
        `MP: ${data.wallet.balance} / ${data.wallet.max} · Total earned: ${data.wallet.earned} MP · Total spent: ${data.wallet.spent} MP`;
      results.hidden = false;
      status.textContent = "Up to date. Results come from your saved server records.";
    } catch (error) {
      if (request !== revision || key.value.trim() !== apiKey) return;
      status.textContent = error.name === "TimeoutError" || error.name === "AbortError"
        ? "Checking timed out. Please try again."
        : error instanceof TypeError ? "Could not connect. Check your connection and try again." : error.message;
    } finally {
      if (request === revision && key.value.trim() === apiKey) button.disabled = false;
    }
  };
  get("voice-marks-form").addEventListener("submit", refresh);
  if (key.value.trim()) refresh();
}

if (globalThis.document?.getElementById("voice-marks-form")) bindVoiceMarks();
