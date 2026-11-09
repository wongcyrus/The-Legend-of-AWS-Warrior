const novaModel = "us.amazon.nova-2-lite-v1:0";
export const generatorModelRoles = ["miner", "factChecker", "localizer", "critic", "grader", "grounding"];
export const chineseGeneratorModels = {
  miner: novaModel,
  factChecker: "zai.glm-5",
  localizer: "qwen.qwen3-next-80b-a3b",
  critic: "deepseek.v3.2",
  grader: novaModel,
  grounding: novaModel,
};
const envNames = {
  miner: "QUESTION_MINER_MODEL_ID",
  factChecker: "QUESTION_FACT_CHECKER_MODEL_ID",
  localizer: "QUESTION_LOCALIZER_MODEL_ID",
  critic: "QUESTION_CRITIC_MODEL_ID",
  grader: "QUESTION_GRADER_MODEL_ID",
  grounding: "QUESTION_GROUNDING_MODEL_ID",
};

export function resolveGeneratorModels({ modelId, models = {}, modelProfile, env = process.env } = {}) {
  if (modelProfile !== undefined && !["nova", "chinese"].includes(modelProfile)) {
    throw new Error("modelProfile must be nova or chinese");
  }
  if (Object.keys(models).some(role => !generatorModelRoles.includes(role))) {
    throw new Error("Unknown question generator model role");
  }
  const fallback = modelId ?? env.QUESTION_MODEL_ID ?? env.VOICE_MODEL_ID ?? novaModel;
  const profile = (modelProfile ?? "chinese") === "chinese" ? chineseGeneratorModels : {};
  const sharedOverride = modelProfile === undefined ? modelId ?? env.QUESTION_MODEL_ID : undefined;
  const resolved = Object.fromEntries(generatorModelRoles.map(role => [
    role, models[role] ?? env[envNames[role]] ?? (role === "grounding" ? undefined : sharedOverride) ??
      profile[role] ?? (role === "grounding" ? novaModel : fallback),
  ]));
  if (Object.values(resolved).some(id => typeof id !== "string" || !id.trim() || /\s/.test(id))) {
    throw new Error("Question generator model IDs must be non-empty and contain no whitespace");
  }
  if (!/^(?:(?:us|eu|apac|global)\.)?amazon\.nova/.test(resolved.grounding)) {
    throw new Error("Nova web grounding requires an Amazon Nova model, independent of generator models");
  }
  return resolved;
}

export function parseGeneratorFlags(flags) {
  const values = {};
  const models = {};
  const roles = {
    "miner-model": "miner", "fact-checker-model": "factChecker", "localizer-model": "localizer",
    "critic-model": "critic", "grader-model": "grader", "grounding-model": "grounding",
  };
  const options = {
    model: "modelId", "model-profile": "modelProfile", "web-answer-url": "webAnswerUrl",
    "evidence-source": "evidenceSource",
  };
  for (const flag of flags) {
    const match = /^--([^=]+)=(.*)$/.exec(flag);
    if (!match || !(match[1] in roles || match[1] in options)) continue;
    if (!match[2].trim()) throw new Error(`--${match[1]} requires a value`);
    if (match[1] in roles) models[roles[match[1]]] = match[2];
    else values[options[match[1]]] = match[2];
  }
  return { ...values, models };
}
