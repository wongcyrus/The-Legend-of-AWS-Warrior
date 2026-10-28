import { readFileSync } from "node:fs";

const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const locale = value => {
  if (!text(value, 80)) return false;
  try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; }
};

export function validateLanguages(value) {
  if (!Array.isArray(value?.languages) || !value.languages.length || value.languages.length > 32)
    throw new Error("Invalid voice language configuration");
  const ids = new Set();
  for (const language of value.languages) {
    if (!locale(language?.id) || ids.has(language.id) || !locale(language.speechLocale) ||
        !text(language.label, 150) || !text(language.feedbackLanguage, 500))
      throw new Error("Invalid or duplicate voice language");
    ids.add(language.id);
  }
  if (!ids.has(value.defaultLanguage)) throw new Error("Voice default language is not configured");
  return {
    defaultLanguage: value.defaultLanguage,
    languages: value.languages.map(({ id, label, speechLocale, feedbackLanguage }) =>
      ({ id, label, speechLocale, feedbackLanguage })),
  };
}

export function validateActivities(value, config) {
  if (!Array.isArray(value) || !value.length) throw new Error("No voice activities configured");
  const ids = new Set(), labels = new Map(), locales = new Set(config.languages.map(language => language.id));
  return value.map(activity => {
    if (!activity || !text(activity.activityId, 150) || !/^[a-zA-Z0-9_-]+$/.test(activity.activityId) ||
        ids.has(activity.activityId) || !text(activity.serviceId, 100) ||
        !/^[a-zA-Z0-9_-]+$/.test(activity.serviceId) || !text(activity.version, 40) ||
        !text(activity.label, 150) || !Number.isSafeInteger(activity.round) || activity.round < 1 ||
        !activity.readingTexts || Array.isArray(activity.readingTexts) ||
        typeof activity.readingTexts !== "object" || !Object.keys(activity.readingTexts).length ||
        Object.entries(activity.readingTexts).some(([id, passage]) => !locales.has(id) || !text(passage, 2000)) ||
        (labels.has(activity.serviceId) && labels.get(activity.serviceId) !== activity.label))
      throw new Error(`Invalid voice activity: ${activity?.activityId ?? "unknown"}`);
    ids.add(activity.activityId);
    labels.set(activity.serviceId, activity.label);
    return { activityId: activity.activityId, version: activity.version, serviceId: activity.serviceId,
      label: activity.label, round: activity.round, readingTexts: { ...activity.readingTexts } };
  });
}

export const languageConfig = validateLanguages(
  JSON.parse(readFileSync(new URL("./languages.json", import.meta.url), "utf8")));

export function activityLanguages(readingTexts, config = languageConfig) {
  return config.languages.filter(language => text(readingTexts?.[language.id], 2000));
}

export function defaultActivityLanguage(readingTexts, config = languageConfig) {
  const available = activityLanguages(readingTexts, config);
  return available.find(language => language.id === config.defaultLanguage)?.id ?? available[0]?.id;
}
