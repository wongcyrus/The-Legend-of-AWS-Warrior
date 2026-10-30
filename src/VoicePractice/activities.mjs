import { readFileSync } from "node:fs";
import { languageConfig, validateActivities } from "./content.mjs";

// Activity identifiers are immutable: future passage edits require a new version.
export const activities = validateActivities(
  JSON.parse(readFileSync(new URL("./activities.json", import.meta.url), "utf8")), languageConfig);

const forbiddenVoiceClaim = /\b(?:pronunciat\w*|mispronounc\w*|your\s+voice|voice\s+(?:is|was|quality|tone|clarity|inaccurate|accurate)|accent|intonation|enunciat\w*)\b|發音|讀音|咬字|聲線|語調|口音|发音|读音/iu;

export function validateGrade(value) {
  const { score, feedback, breakdown } = value ?? {};
  if (!Number.isInteger(score) || score < 0 || score > 100 ||
      !Number.isInteger(breakdown?.coverage) || breakdown.coverage < 0 || breakdown.coverage > 70 ||
      !Number.isInteger(breakdown?.content) || breakdown.content < 0 || breakdown.content > 30 ||
      breakdown.coverage + breakdown.content !== score ||
      typeof feedback !== "string" || !feedback.trim() || feedback.length > 1600 ||
      forbiddenVoiceClaim.test(feedback)) {
    throw new Error("Invalid reading grade");
  }
  return { score, passed: score >= 60, feedback: feedback.trim(),
    breakdown: { coverage: breakdown.coverage, content: breakdown.content } };
}

export const rewardFor = (score, type = "read_aloud") =>
  (score >= 90 ? 15 : score >= 75 ? 10 : score >= 60 ? 5 : 0) * (type === "question_answer" ? 2 : 1);
