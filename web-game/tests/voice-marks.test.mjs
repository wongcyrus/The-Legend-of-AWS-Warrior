import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bindVoiceMarks } from "../v2/voice-marks.js";

function fixture(fetcher, saved = "") {
  const element = () => ({
    value: "", hidden: false, disabled: false, textContent: "", children: [], events: {},
    addEventListener(name, handler) { this.events[name] = handler; },
    setAttribute(name, value) { (this.attributes ||= {})[name] = value; },
    replaceChildren(...children) { this.children = children; },
    append(child) { this.children.push(child); },
  });
  const nodes = Object.fromEntries(["key", "refresh", "status", "results", "rows", "summary", "form", "activities", "wallet",
    "search", "filter", "type", "count", "empty"]
    .map(id => [`voice-marks-${id}`, element()]));
  const events = {};
  bindVoiceMarks({
    document: { getElementById: id => nodes[id], createElement: element },
    storage: { getItem: () => saved }, fetcher,
    eventTarget: { addEventListener: (name, callback) => { events[name] = callback; } },
  });
  return { get: id => nodes[`voice-marks-${id}`],
    storageKey(value) { saved = value; events.storage({ key: "api_key" }); },
    clearStorage() { saved = ""; events.storage({ key: null }); },
    search(value) { nodes["voice-marks-search"].value = value; nodes["voice-marks-search"].events.input(); },
    filter(value) { nodes["voice-marks-filter"].value = value; nodes["voice-marks-filter"].events.change(); },
    type(value) { nodes["voice-marks-type"].value = value; nodes["voice-marks-type"].events.change(); },
    submit: () => nodes["voice-marks-form"].events.submit({ preventDefault() {} }) };
}
const services = () => ["S3", "EC2", "IAM", "VPC", "Lambda", "DynamoDB"].map((label, index) => ({
  label, completed: index === 1, completedAt: index === 1 ? 1793191336 : null,
}));
const marks = () => ({
  wallet: { balance: 12, max: 100, earned: 18, spent: 6, revision: 3 },
  services: services(),
  activities: [
    { activityId: "s3-round-1-v1", serviceId: "s3", label: "S3 foundations", round: 1,
      completed: true, bestScore: 85, latestScore: 80, feedback: "Clear reading; review bucket access.",
      mpAwarded: 3, completedAt: 1793191336 },
    { activityId: "s3-round-2-v1", serviceId: "s3", label: "S3 practice", round: 2,
      completed: false, bestScore: null, latestScore: null, feedback: null, mpAwarded: 0, completedAt: null },
    { activityId: "ec2-history", serviceId: "ec2", label: "Historical EC2 participation", round: 1,
      completed: true, bestScore: null, latestScore: null, feedback: null, mpAwarded: null, completedAt: 1793191336 },
  ],
});

test("marks open separately without replacing the active game tab", () => {
  const game = readFileSync(new URL("../game-v2.html", import.meta.url), "utf8");
  const marks = readFileSync(new URL("../voice-marks.html", import.meta.url), "utf8");
  const link = game.match(/<a\b[^>]*href="\.\/voice-marks\.html"[^>]*>/)?.[0];
  assert.ok(link);
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.match(link, /aria-label="Voice marks \(opens in a new tab\)"/);
  assert.match(marks, /close this tab or switch back to your game tab/);
});

test("marks distinguish multiple Q&A questions and combine task-type, status and title filters", async () => {
  let calls = 0;
  const data = marks();
  data.activities.push({ ...data.activities[0], activityId: "qa:s3:private", type: "question_answer",
    title: "Private screenshots", mpAwarded: 20, available: true });
  data.activities.push({ ...data.activities[1], activityId: "qa:s3:assets", type: "question_answer",
    title: "Store assets", available: true });
  const f = fixture(async () => { calls++; return { ok: true, json: async () => data }; });
  f.get("key").value = "key";
  await f.submit();
  f.type("question_answer");
  assert.equal(f.get("activities").children.length, 2);
  assert.match(f.get("activities").children[0].children[0].textContent, /Q&A: Private screenshots/);
  assert.equal(f.get("activities").children[0].children[5].textContent, "20 MP");
  f.filter("passed");
  assert.equal(f.get("activities").children.length, 1);
  f.search("assets");
  assert.equal(f.get("activities").children.length, 0);
  f.filter("all");
  assert.equal(f.get("activities").children.length, 1);
  assert.match(f.get("activities").children[0].children[0].textContent, /Store assets/);
  assert.equal(calls, 1);
  f.storageKey("other");
  assert.equal(f.get("type").disabled, true);
  assert.equal(f.get("type").value, "all");
});

test("marks render service-level unattempted Q&A and service Q&A exhaustion status without leaking unseen question IDs", async () => {
  const data = marks();
  data.activities.push(
    { activityId: "qa:s3:private", serviceId: "s3", label: "Amazon S3", type: "question_answer",
      title: "Private screenshots", round: 1, completed: true, bestScore: 90, latestScore: 90,
      feedback: "Good answer.", mpAwarded: 30, completedAt: 1793191336, available: true, exhausted: false },
    { activityId: "qa:s3", serviceId: "s3", label: "Amazon S3", type: "question_answer",
      round: 1, completed: false, bestScore: null, latestScore: null,
      feedback: null, mpAwarded: 0, completedAt: null, available: true, exhausted: false },
    { activityId: "qa:ec2: sizing", serviceId: "ec2", label: "Amazon EC2", type: "question_answer",
      title: "Instance sizing", round: 1, completed: true, bestScore: 80, latestScore: 80,
      feedback: "Solid.", mpAwarded: 20, completedAt: 1793191336, available: true, exhausted: true },
  );
  const f = fixture(async () => ({ ok: true, json: async () => data }));
  f.get("key").value = "key";
  await f.submit();
  f.type("question_answer");
  const rows = f.get("activities").children;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].children[0].textContent, "Amazon S3 - Q&A: Private screenshots");
  assert.equal(rows[0].children[2].textContent, "Completed (more Q&A available)");
  assert.equal(rows[1].children[0].textContent, "Amazon S3 - Q&A");
  assert.equal(rows[1].children[2].textContent, "Not yet answered (Q&A available)");
  assert.equal(rows[2].children[0].textContent, "Amazon EC2 - Q&A: Instance sizing");
  assert.equal(rows[2].children[2].textContent, "Completed (service Q&A exhausted)");
});

test("marks require a key and show grades, feedback, MP and ungraded history without transcripts", async () => {
  let url, options;
  const f = fixture(async (target, request) => {
    url = target; options = request;
    return { ok: true, json: async () => ({ ...marks(), transcript: "PRIVATE TRANSCRIPT" }) };
  });
  await f.submit();
  assert.match(f.get("status").textContent, /Enter your game API key/);
  f.get("key").value = "student-key";
  await f.submit();
  assert.equal(url.pathname, "/Prod/voice/completions");
  assert.equal(url.search, "");
  assert.equal(options.headers["x-api-key"], "student-key");
  assert.equal(options.cache, "no-store");
  assert.equal(f.get("results").hidden, false);
  assert.equal(f.get("summary").textContent, "2 of 3 voice activities completed");
  assert.equal(f.get("wallet").textContent, "MP: 12 / 100 · Total earned: 18 MP · Total spent: 6 MP");
  const row = f.get("rows").children[1];
  assert.equal(row.children[1].textContent, "Completed (ungraded participation)");
  assert.match(row.children[2].textContent, /20:42/);
  assert.equal(f.get("rows").children[0].children[1].textContent, "Not yet completed");
  const activities = f.get("activities").children;
  assert.equal(activities[0].children[3].textContent, "Best: 85 / 100; latest: 80 / 100");
  assert.equal(activities[0].children[4].textContent, "Clear reading; review bucket access.");
  assert.equal(activities[0].children[4].attributes["data-label"], "Feedback");
  assert.equal(activities[0].children[5].textContent, "3 MP");
  assert.equal(activities[1].children[3].textContent, "Not graded");
  assert.equal(activities[1].children[5].textContent, "-");
  assert.equal(activities[2].children[3].textContent, "Ungraded participation");
  assert.equal(activities[2].children[5].textContent, "No graded reward recorded");
  assert.ok(!JSON.stringify(activities).includes("PRIVATE TRANSCRIPT"));
  assert.equal(f.get("refresh").disabled, false);
});

test("rejected keys, network failures and malformed responses never display invented marks", async () => {
  for (const fetcher of [
    async () => ({ ok: false, status: 403 }),
    async () => { throw new TypeError("fetch failed"); },
    async () => ({ ok: true, json: async () => ({ services: [] }) }),
    async () => ({ ok: true, json: async () => ({ ...marks(), wallet: { balance: 1000 } }) }),
    async () => ({ ok: true, json: async () => ({
      ...marks(), activities: [{ ...marks().activities[0], bestScore: 101 }],
    }) }),
  ]) {
    const f = fixture(fetcher);
    f.get("key").value = "key";
    await f.submit();
    assert.equal(f.get("results").hidden, true);
    assert.ok(f.get("status").textContent.length > 10);
    assert.equal(f.get("refresh").disabled, false);
  }
});

test("changing keys clears old marks and ignores an in-flight result", async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  f.get("key").value = "first";
  const pending = f.submit();
  f.get("key").value = "second";
  f.get("key").events.input();
  resolve({ ok: true, json: async () => marks() });
  await pending;
  assert.equal(f.get("results").hidden, true);
  assert.equal(f.get("rows").children.length, 0);
  assert.equal(f.get("activities").children.length, 0);
  assert.equal(f.get("wallet").textContent, "");
  assert.equal(f.get("status").textContent, "");
});

test("saved game keys load automatically and service labels render as text only", async () => {
  const data = marks();
  data.services[0].label = "<img src=x onerror=alert(1)>";
  data.activities[0].feedback = "<script>unsafe()</script>";
  const f = fixture(async () => ({ ok: true, json: async () => data }), "saved-key");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.get("key").value, "saved-key");
  assert.equal(f.get("rows").children[0].children[0].textContent, data.services[0].label);
  assert.equal(f.get("activities").children[0].children[4].textContent, data.activities[0].feedback);
});

test("storage key changes clear prior wallet and grades, and stale errors cannot replace a newer result", async () => {
  let reject;
  let request = 0;
  const f = fixture(async () => {
    if (++request === 2) return new Promise((resolve, fail) => { reject = fail; });
    return { ok: true, json: async () => marks() };
  });
  f.get("key").value = "first";
  await f.submit();
  assert.equal(f.get("results").hidden, false);
  const stale = f.submit();
  f.storageKey("second");
  assert.equal(f.get("key").value, "second");
  assert.equal(f.get("results").hidden, true);
  assert.equal(f.get("wallet").textContent, "");
  assert.equal(f.get("activities").children.length, 0);
  await f.submit();
  const status = f.get("status").textContent;
  reject(new TypeError("old key failed"));
  await stale;
  assert.equal(f.get("results").hidden, false);
  assert.equal(f.get("status").textContent, status);
});

test("capped zero MP rewards display as recorded and marks never persist or expose credentials", async () => {
  const data = marks();
  data.activities[0].mpAwarded = 0;
  const f = fixture(async () => ({ ok: true, json: async () => data }));
  f.get("key").value = "key";
  await f.submit();
  assert.equal(f.get("activities").children[0].children[5].textContent, "0 MP");
  const html = readFileSync(new URL("../voice-marks.html", import.meta.url), "utf8");
  const source = readFileSync(new URL("../v2/voice-marks.js", import.meta.url), "utf8");
  assert.match(html, /id="voice-marks-key" type="password" autocomplete="off"/);
  assert.doesNotMatch(source, /setItem|URLSearchParams|location\.search|innerHTML/);
});

test("search and status controls are labelled, unavailable before results, and default to All", () => {
  const f = fixture(() => assert.fail("No request without a key"));
  assert.equal(f.get("results").hidden, true);
  assert.equal(f.get("search").disabled, true);
  assert.equal(f.get("filter").disabled, true);
  assert.equal(f.get("filter").value, "all");
  assert.equal(f.get("count").textContent, "");
  f.search("s3");
  f.filter("passed");
  assert.equal(f.get("activities").children.length, 0);
  const html = readFileSync(new URL("../voice-marks.html", import.meta.url), "utf8");
  for (const id of ["search", "filter"]) {
    assert.match(html, new RegExp(`<label for="voice-marks-${id}">`));
    assert.match(html, new RegExp(`id="voice-marks-${id}"[^>]*aria-controls="voice-marks-activities"[^>]*disabled`));
  }
  assert.match(html, /id="voice-marks-count" role="status" aria-live="polite"/);
});

test("all completion/score combinations have deterministic categories, intersected with service search", async () => {
  const data = marks();
  data.activities = Array.from({ length: 8 }, (_, index) => ({
    ...data.activities[0], activityId: `activity-${index}`, label: `Service ${index}`,
    serviceId: index % 2 ? "compute" : "storage", completed: index >= 4,
    bestScore: index & 1 ? 0 : null, latestScore: index & 2 ? 100 : null,
  }));
  let requests = 0;
  const f = fixture(async () => {
    requests++;
    return { ok: true, json: async () => data };
  });
  f.get("key").value = "student";
  await f.submit();
  const history = f.get("rows").children;
  const summary = f.get("summary").textContent, wallet = f.get("wallet").textContent;
  assert.equal(f.get("search").disabled, false);
  assert.equal(f.get("filter").disabled, false);
  const categories = {
    all: [0, 1, 2, 3, 4, 5, 6, 7],
    attempted: [1, 2, 3, 5, 6, 7],
    passed: [4, 5, 6, 7],
    "needs-retry": [1, 2, 3],
    "not-started": [0],
  };
  for (const [category, indices] of Object.entries(categories)) {
    f.filter(category);
    for (const [query, matches] of [
      ["", indices], [" \t ", indices], ["  sErViCe  ", indices],
      ["  CoMpUtE  ", indices.filter(index => index % 2)],
      [" STORAGE ", indices.filter(index => !(index % 2))],
      [" SERVICE 4 ", indices.filter(index => index === 4)], ["not-a-service", []],
    ]) {
      f.search(query);
      assert.deepEqual(f.get("activities").children.map(row => row.children[0].textContent),
        matches.map(index => `Service ${index} - Read aloud`), `${category}: ${query}`);
      assert.equal(f.get("count").textContent, `Showing ${matches.length} of 8 voice activities`);
      assert.equal(f.get("empty").hidden, matches.length > 0);
      assert.equal(f.get("summary").textContent, summary);
      assert.equal(f.get("wallet").textContent, wallet);
      assert.equal(f.get("rows").children, history);
    }
    f.search("");
  }
  assert.equal(requests, 1);
});

test("308 activities filter locally without losing rows, order, feedback or global totals", async () => {
  const data = marks();
  data.activities = Array.from({ length: 308 }, (_, index) => ({
    ...data.activities[0], activityId: `service-${index}-round-1`, serviceId: `service-${index}`,
    label: `AWS service ${index}`, completed: index % 4 === 0,
    bestScore: index % 2 === 0 ? 80 : null, latestScore: null,
    feedback: index === 2 ? "<img src=x onerror=alert(1)>" : `Feedback ${index}`,
  }));
  let requests = 0;
  const f = fixture(async () => {
    requests++;
    return { ok: true, json: async () => data };
  });
  f.get("key").value = "student";
  await f.submit();
  const original = [...f.get("activities").children];
  assert.equal(original.length, 308);
  assert.equal(f.get("summary").textContent, "77 of 308 voice activities completed");
  for (const [filter, total] of [["attempted", 154], ["passed", 77], ["needs-retry", 77], ["not-started", 154]]) {
    f.filter(filter);
    assert.equal(f.get("count").textContent, `Showing ${total} of 308 voice activities`);
  }
  f.filter("needs-retry");
  f.search("SERVICE-2");
  assert.ok(f.get("activities").children.length > 0);
  assert.equal(f.get("activities").children[0].children[4].textContent, data.activities[2].feedback);
  f.search("<img");
  assert.equal(f.get("activities").children.length, 0);
  assert.match(f.get("empty").textContent, /No activities match/);
  f.filter("all");
  f.search("  ");
  assert.deepEqual(f.get("activities").children, original);
  assert.equal(f.get("summary").textContent, "77 of 308 voice activities completed");
  assert.equal(requests, 1);
});

test("empty datasets have a distinct empty state and zero shown/global totals", async () => {
  const f = fixture(async () => ({ ok: true, json: async () => ({ ...marks(), activities: [] }) }));
  f.get("key").value = "student";
  await f.submit();
  for (const category of ["all", "attempted", "passed", "needs-retry", "not-started"]) {
    f.filter(category);
    f.search("s3");
    assert.equal(f.get("empty").hidden, false);
    assert.equal(f.get("empty").textContent, "No voice activities available.");
    assert.equal(f.get("count").textContent, "Showing 0 of 0 voice activities");
    assert.equal(f.get("summary").textContent, "0 of 0 voice activities completed");
    assert.equal(f.get("rows").children.length, 6);
  }
});

test("key changes erase cached activities and queries; filtering cannot restore another account's data", async () => {
  for (const change of [
    f => { f.get("key").value = "second"; f.get("key").events.input(); },
    f => f.storageKey("second"),
    f => f.clearStorage(),
    f => { f.get("key").value = "second"; f.search("s3"); },
  ]) {
    let requests = 0;
    const f = fixture(async () => {
      requests++;
      return { ok: true, json: async () => marks() };
    });
    f.get("key").value = "first";
    await f.submit();
    f.search("S3");
    f.filter("passed");
    change(f);
    assert.equal(f.get("search").value, "");
    assert.equal(f.get("filter").value, "all");
    for (const filter of ["all", "attempted", "passed", "needs-retry", "not-started"]) {
      f.search("");
      f.filter(filter);
      assert.equal(f.get("activities").children.length, 0);
      assert.equal(f.get("rows").children.length, 0);
      assert.equal(f.get("summary").textContent, "");
      assert.equal(f.get("wallet").textContent, "");
      assert.equal(f.get("count").textContent, "");
      assert.equal(f.get("results").hidden, true);
      assert.equal(f.get("search").disabled, true);
      assert.equal(f.get("filter").disabled, true);
    }
    assert.equal(requests, 1);
  }
});

test("late JSON cannot replace cached results after switching accounts, even back to the same key", async () => {
  let resolveJson, startedJson;
  const jsonStarted = new Promise(resolve => { startedJson = resolve; });
  let requests = 0;
  const data = marks();
  data.activities = [{ ...data.activities[0], label: "Current account activity" }];
  const f = fixture(async () => {
    requests++;
    return { ok: true, json: requests === 1
      ? () => { startedJson(); return new Promise(resolve => { resolveJson = resolve; }); }
      : async () => data };
  });
  f.get("key").value = "first";
  const pending = f.submit();
  await jsonStarted;
  f.storageKey("second");
  f.storageKey("first");
  await f.submit();
  resolveJson(marks());
  await pending;
  f.filter("all");
  f.search("");
  assert.equal(f.get("count").textContent, "Showing 1 of 1 voice activities");
  assert.equal(f.get("activities").children[0].children[0].textContent, "Current account activity - Read aloud");
  assert.equal(requests, 2);
});
