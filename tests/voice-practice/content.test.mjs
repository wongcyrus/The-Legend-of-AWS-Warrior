import test from "node:test";
import assert from "node:assert/strict";
import { validateLanguages, validateActivities, activityLanguages, defaultActivityLanguage } from "../../src/VoicePractice/content.mjs";

const config = {
  defaultLanguage: "fr-FR",
  languages: [
    { id: "fr-FR", label: "Français", speechLocale: "fr-FR", feedbackLanguage: "French" },
    { id: "ja-JP", label: "日本語", speechLocale: "ja-JP", feedbackLanguage: "Japanese" },
  ],
};
const activity = { activityId: "new-service-reading-r1-v1", serviceId: "new-service", label: "New service",
  version: "1", round: 1, readingTexts: { "fr-FR": "Une activité configurée." } };

test("voice configuration accepts additional locales and services without application changes", () => {
  const languages = validateLanguages(config);
  assert.deepEqual(languages, config);
  assert.deepEqual(validateActivities([activity], languages), [activity]);
  assert.deepEqual(activityLanguages(activity.readingTexts, languages), [config.languages[0]]);
  assert.equal(defaultActivityLanguage(activity.readingTexts, languages), "fr-FR");
  assert.equal(defaultActivityLanguage({ "ja-JP": "こんにちは世界の皆さん" }, languages), "ja-JP");
});

test("voice configuration rejects duplicate or malformed locales, missing defaults and unsafe activity data", () => {
  for (const bad of [null, {}, { ...config, defaultLanguage: "de-DE" },
    { ...config, languages: [...config.languages, config.languages[0]] },
    { ...config, languages: [{ ...config.languages[0], speechLocale: "bad_locale" }] },
    { ...config, languages: [{ ...config.languages[0], feedbackLanguage: "" }] }])
    assert.throws(() => validateLanguages(bad));
  for (const bad of [[], [activity, activity], [{ ...activity, round: 0 }],
    [{ ...activity, activityId: "../unsafe" }], [{ ...activity, readingTexts: {} }],
    [{ ...activity, readingTexts: { "de-DE": "Not configured." } }],
    [{ ...activity, readingTexts: { "fr-FR": "x".repeat(2001) } }],
    [activity, { ...activity, activityId: "another-id", label: "Different label" }]])
    assert.throws(() => validateActivities(bad, config));
});
