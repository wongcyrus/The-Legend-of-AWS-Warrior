import { spawnSync } from "node:child_process";
import { lessons } from "./domain.mjs";

const [action, serviceId, version, revision, reviewer] = process.argv.slice(2);
if (!["show", "approve"].includes(action) || !Object.hasOwn(lessons, serviceId ?? "") || !/^[0-9]+$/.test(version ?? "") ||
    (action === "approve" && (!/^[0-9]+$/.test(revision ?? "") || !reviewer?.trim()))) {
  console.error("Usage: VOICE_TABLE=... node review-bank.mjs show SERVICE VERSION\n       VOICE_TABLE=... node review-bank.mjs approve SERVICE VERSION EXPECTED_REVISION REVIEWER");
  process.exit(1);
}
if (!process.env.VOICE_TABLE) throw new Error("VOICE_TABLE is required");
const key = JSON.stringify({ PK: { S: `BANK#${serviceId}` }, SK: { S: `LESSON#${version}` } });
const args = action === "show" ? ["dynamodb", "get-item", "--consistent-read", "--key", key] : [
  "dynamodb", "update-item", "--key", key,
  "--update-expression", "SET #status = :approved, revision = :next, approvedBy = :reviewer, approvedAt = :now",
  "--condition-expression", "#status = :pending AND revision = :revision AND lessonVersion = :version",
  "--expression-attribute-names", JSON.stringify({ "#status": "status" }),
  "--expression-attribute-values", JSON.stringify({
    ":approved": { S: "approved" }, ":pending": { S: "pending_approval" }, ":revision": { N: revision },
    ":next": { N: String(Number(revision) + 1) }, ":version": { S: version },
    ":reviewer": { S: reviewer }, ":now": { N: String(Math.floor(Date.now() / 1000)) },
  }),
];
const result = spawnSync("aws", [...args, "--table-name", process.env.VOICE_TABLE, "--no-cli-pager"], { stdio: "inherit" });
process.exit(result.status ?? 1);
