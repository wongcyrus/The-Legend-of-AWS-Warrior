import { languageConfig } from "./content.mjs";
import { taskAvailableAt } from "./economy.mjs";

const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const identifier = value => text(value, 100) && /^[a-zA-Z0-9_-]+$/.test(value);
const strings = value => Array.isArray(value) && value.length <= 12 && value.every(item => text(item, 600));
const normalize = value => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
export const questionKey = (serviceId, id) => ({ PK: "QUESTION_BANK", SK: `SERVICE#${serviceId}#QUESTION#${id}` });
export const questionActivityId = (serviceId, id) => `qa:${serviceId}:${id}`;
export const isAnswerTranscript = value => typeof value === "string" && /[\p{L}\p{N}]/u.test(value);

export function validateQuestion(value, config = languageConfig) {
  if (!value || !identifier(value.id) || !identifier(value.serviceId) ||
      !Number.isSafeInteger(value.version) || value.version < 1 ||
      !["draft", "approved", "retired"].includes(value.status) ||
      !text(value.title, 150) || !value.prompts || Array.isArray(value.prompts) ||
      typeof value.prompts !== "object" || !Object.keys(value.prompts).length ||
      Object.entries(value.prompts).some(([id, prompt]) =>
        !config.languages.some(language => language.id === id) || !text(prompt, 2000)) ||
      !Array.isArray(value.concepts) || !value.concepts.length || value.concepts.length > 8 ||
      value.concepts.some(concept => !identifier(concept?.id) || concept.id.length > 60 ||
        !text(concept.description, 500) || !Number.isInteger(concept.weight) || concept.weight < 1 || concept.weight > 100) ||
      new Set(value.concepts.map(concept => concept.id)).size !== value.concepts.length ||
      value.concepts.reduce((sum, concept) => sum + concept.weight, 0) !== 100 ||
      !strings(value.misconceptions) || !strings(value.acceptableAnswers) || !text(value.referenceAnswer, 2000))
    throw new Error("Invalid Q&A question");
  return { id: value.id, serviceId: value.serviceId, version: value.version, status: value.status,
    title: value.title.trim(), prompts: { ...value.prompts },
    concepts: value.concepts.map(({ id, description, weight }) => ({ id, description, weight })),
    misconceptions: [...value.misconceptions], acceptableAnswers: [...value.acceptableAnswers],
    referenceAnswer: value.referenceAnswer };
}

export function questionRubric(question, language) {
  return { id: question.id, prompt: question.prompts[language], concepts: question.concepts,
    misconceptions: question.misconceptions, acceptableAnswers: question.acceptableAnswers,
    referenceAnswer: question.referenceAnswer };
}

const forbiddenVoiceClaim = /\b(?:pronunciat\w*|mispronounc\w*|your\s+voice|voice\s+(?:is|was|quality|tone|clarity|inaccurate|accurate)|accent|intonation|enunciat\w*)\b|發音|讀音|咬字|聲線|語調|口音|发音|读音/iu;

export function validateAnswerGrade(value) {
  if (!Number.isInteger(value?.score) || value.score < 0 || value.score > 100 ||
      value.breakdown?.understanding !== value.score || !text(value.feedback, 1600) ||
      forbiddenVoiceClaim.test(value.feedback))
    throw new Error("Invalid answer grade");
  return { score: value.score, passed: value.score >= 60,
    breakdown: { understanding: value.score }, feedback: value.feedback.trim() };
}

export function gradeAnswer(value, question, transcript) {
  if (!Array.isArray(value?.concepts) || value.concepts.length !== question.concepts.length ||
      new Set(value.concepts.map(concept => concept?.id)).size !== value.concepts.length)
    throw new Error("Invalid answer assessment");
  let score = 0;
  for (const result of value.concepts) {
    const approved = question.concepts.find(concept => concept.id === result?.id);
    if (!approved || !["met", "missing", "contradicted"].includes(result.verdict) ||
        typeof result.evidence !== "string" || result.evidence.length > 600 ||
        (result.verdict === "missing" ? result.evidence !== "" :
          !normalize(result.evidence) || !normalize(transcript).includes(normalize(result.evidence))))
      throw new Error("Answer assessment lacks valid transcript evidence");
    if (result.verdict === "met") score += approved.weight;
  }
  return validateAnswerGrade({ score, breakdown: { understanding: score }, feedback: value.feedback });
}

export function createQuestions({ store, config, services, fail, now }) {
  const approved = async serviceId => {
    const rows = await store.listQuestions?.(serviceId) ?? [];
    return rows.filter(row => row.status === "approved").flatMap(row => {
      try {
        const question = validateQuestion(row, config);
        return services.has(question.serviceId) ? [question] : [];
      } catch { return []; }
    }).sort((a, b) => a.serviceId.localeCompare(b.serviceId) || a.id.localeCompare(b.id));
  };
  const activities = async () => (await approved()).map(question => ({
    activityId: questionActivityId(question.serviceId, question.id), type: "question_answer",
    serviceId: question.serviceId, label: services.get(question.serviceId), title: question.title,
    questionId: question.id, version: question.version, round: 1,
    languages: Object.keys(question.prompts),
  }));
  const choose = async (owner, serviceId, language) => {
    const options = (await approved(serviceId)).filter(question =>
      question.serviceId === serviceId && Object.hasOwn(question.prompts, language));
    if (!options.length) fail(409, "No approved questions are available for this service and language.");
    const progress = await Promise.all(options.map(question => store.get({
      PK: `PLAYER#${owner}`, SK: `ACTIVITY#${questionActivityId(serviceId, question.id)}`,
    })));
    const eligible = options.filter((_, index) => taskAvailableAt(progress[index]) <= now());
    if (!eligible.length) fail(409, `All Q&A questions for this service are on a one-week cooldown. Available again ${new Date(Math.min(...progress.map(taskAvailableAt)) * 1000).toISOString()}. Return to the game to discover another service.`);
    return eligible.find(question => !progress[options.indexOf(question)]?.completed) ?? eligible[0];
  };
  return { activities, choose };
}
