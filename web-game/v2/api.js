export const QUEST_KEY = "aws-warrior:v2:quest";
export const MARKS_RESET_KEY = "aws-warrior:marks-reset";
const RESET_SEEN_KEY = "aws-warrior:v2:marks-reset";

export class GameApi {
  constructor({ baseUrl, storage = sessionStorage, keys = localStorage, fetcher = (...args) => globalThis.fetch(...args) }) {
    this.baseUrl = baseUrl;
    this.storage = storage;
    this.keys = keys;
    this.fetcher = fetcher;
    this.grading = null;
  }

  get quest() {
    try {
      this.syncMarksReset();
      const quest = JSON.parse(this.storage.getItem(QUEST_KEY));
      return quest && ["filter", "instruction", "name"].every(field =>
        typeof quest[field] === "string" && quest[field].trim()) ? quest : null;
    } catch {
      return null;
    }
  }

  syncMarksReset() {
    const reset = this.keys.getItem(MARKS_RESET_KEY);
    if (reset && reset !== this.storage.getItem(RESET_SEEN_KEY)) {
      this.storage.removeItem(QUEST_KEY);
      this.storage.setItem(RESET_SEEN_KEY, reset);
    }
  }

  async request(controller, parameters, timeout = 20000) {
    const key = this.keys.getItem("api_key")?.trim();
    if (!key) throw new Error("Set your API key to talk to a guide and start grading.");
    const url = new URL(controller, this.baseUrl);
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    try {
      const response = await this.fetcher(url, {
        headers: { "x-api-key": key },
        signal: abort.signal, cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(response.status === 403 || response.status === 401
          ? "Your API key was rejected. Check it in Set Key."
          : "The grader is unavailable. Please try again.");
      }
      return await response.json();
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("The request timed out. Your quest is saved; please try again.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async requestQuest() {
    this.syncMarksReset();
    const key = this.keys.getItem("api_key");
    const reset = this.keys.getItem(MARKS_RESET_KEY);
    // Without game mode, the server returns the original AWS requirements, not NPC dialogue.
    const data = await this.request("game", {});
    if (key !== this.keys.getItem("api_key")) throw new Error("Your API key changed. Press E to receive a task for this account.");
    if (reset !== this.keys.getItem(MARKS_RESET_KEY)) {
      throw new Error("Your marks were reset. Talk again to receive a new quest.");
    }
    if (typeof data === "string") return { message: data };
    if (Array.isArray(data) && data.length === 0) {
      this.storage.removeItem(QUEST_KEY);
      return { completed: true, message: "You have completed all tasks!" };
    }
    const task = Array.isArray(data) ? data[0] : null;
    if (!task || !["filter", "instruction", "name"].every(field =>
      typeof task[field] === "string" && task[field].trim())) {
      throw new Error("No task instructions were returned. Please try again.");
    }
    this.storage.setItem(QUEST_KEY, JSON.stringify(task));
    return { task };
  }

  gradeQuest() {
    if (this.grading) return this.grading;
    const quest = this.quest;
    if (!quest) return Promise.resolve(null);
    const key = this.keys.getItem("api_key");
    const reset = this.keys.getItem(MARKS_RESET_KEY);
    this.grading = this.request("grader", { filter: quest.filter }, 180000)
      .then(result => {
        if (reset !== this.keys.getItem(MARKS_RESET_KEY)) {
          throw new Error("Your marks were reset. Talk to a guide to start again.");
        }
        if (!result || typeof result.isSuccess !== "boolean") {
          throw new Error("The grader returned an invalid result. Your quest is still saved.");
        }
        if (result.isSuccess && this.quest?.filter === quest.filter &&
            this.keys.getItem("api_key") === key) {
          this.storage.removeItem(QUEST_KEY);
        }
        return result;
      })
      .finally(() => { this.grading = null; });
    return this.grading;
  }
}
