import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bindVoiceMarks } from "../v2/voice-marks.js";

function fixture(fetcher, saved = "") {
  const element = () => ({
    value: "", hidden: false, disabled: false, textContent: "", children: [], events: {},
    addEventListener(name, handler) { this.events[name] = handler; },
    replaceChildren(...children) { this.children = children; },
    append(child) { this.children.push(child); },
  });
  const nodes = Object.fromEntries(["key", "refresh", "status", "results", "rows", "summary", "form", "activities", "wallet"]
    .map(id => [`voice-marks-${id}`, element()]));
  const events = {};
  bindVoiceMarks({
    document: { getElementById: id => nodes[id], createElement: element },
    storage: { getItem: () => saved }, fetcher,
    eventTarget: { addEventListener: (name, callback) => { events[name] = callback; } },
  });
  return { get: id => nodes[`voice-marks-${id}`],
    storageKey(value) { saved = value; events.storage({ key: "api_key" }); },
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
