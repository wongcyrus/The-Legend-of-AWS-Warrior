# Voice practice backend

Node.js 22 Lambda: `index.handler`. Package this directory including production dependencies. Run `npm test` here, `npm test --prefix ../VoiceAgent` for the agent, and `python3 -m unittest discover -s tests -p test_voice_deployment.py` from the repository root. Tests use no live AWS services.

## Authored reading and grading

New sessions default to server-owned `mode:"graded_read_aloud"`. `activities.json` contains 308 immutable versioned activities covering all 302 discoverable services, initially in English and Cantonese. Every service has round one; s3, ec2, iam, vpc, lambda and dynamodb retain their existing second round. The twelve original identifiers and passages are unchanged. No questions are generated for these sessions.

The server selects unfinished round-one activities before round two. A requested service is preferred only within the eligible round's unfinished services. Thus requesting an already-passed service can return another service. Once all authored activities pass, creation returns 409 with a safe exhaustion message; no unlimited reward generation is available.

AgentCore's `grade_reading` operation makes one bounded model call, assessing the current browser transcript against either/both language versions. It grades coverage (integer 0–70) and content fidelity (integer 0–30), summing to integer score 0–100. It tolerates Cantonese, English, code switching, paraphrases and recognition variants. It does not assess pronunciation or comprehension, request explanations or run a conversation. Both the agent and Lambda validate grades and bounded feedback. The server alone determines passing (`score >= 60`) and nominal first-pass rewards: 5 at 60, 10 at 75, 15 at 90.

The adapter and agent sort language-map keys before invocation, because DynamoDB does not preserve map insertion order. Weighted rubric bounds remain strict: malformed model grades (such as content 35/30) produce processing failure, never clamping, invented scores or rewards. The language's configured feedback instructions are server-owned, never supplied by a student.

Speech recognition runs in the browser, which may send audio to its own provider. The backend receives final text only: no recording, audio upload, presigning or Amazon Transcribe integration. Transcript maximum is 6,000 characters. Client-supplied scores, passage text, history, owner identities and reward claims are ignored.

Desktop and phone graded reading submissions reject silence, punctuation and insufficient speech with 400 before reserving attempts or daily budget or queuing model work. Meaningful reading speech requires two word groups totaling at least eight letters/digits, or six non-Latin letters with at least three distinct characters, allowing scripts that do not separate words with spaces. This is only an input-quality gate, not a reading grade.

## Database-backed Q&A

Q&A uses the same Lambda, AgentCore runtime, table, authentication, transfer and
retry paths. No additional agent or public authoring endpoint is required.
One service has many independently rewarded questions. The server enables this
type only when a valid `approved` question exists for the requested service and
language. An empty bank, draft or retired record cannot start a new session;
there is no runtime question generation or read-aloud fallback.

POST `/voice/sessions` with
`{"serviceId":"s3","type":"question_answer","language":"en-US"}` returns
`mode:"graded_question_answer"`, `questionId`, `questionTitle`, translated
`questionTexts` and the usual session/device/attempt fields. The server chooses
an unfinished approved question in that service/language independently of reading
rounds. Passed questions are unavailable for one week, then can be retried without additional rewards.
PC task selection uses authenticated `/voice/completions` availability; the server
rechecks availability on creation. Selecting Q&A discards unsent reading speech.
After completion, close and reopen the service's voice dialog to start another
question; there is no duplicated result or next-activity button.

Questions are individual items with `PK:QUESTION_BANK` and
`SK:SERVICE#serviceId#QUESTION#questionId`. Prefix queries group one service's
questions; a paginated catalog query supports availability and marks without
a table scan or a new index. Draft/retired/invalid items are excluded server-side.
This shared partition is intended for the educational question bank, not a
high-volume multi-tenant content platform.

Each record has a stable ID, increasing integer version, revision, title,
language-to-prompt map, weighted concepts, misconceptions, acceptable answers and
a reference answer. Concept weights must be positive integers summing to 100.
Rubrics and reference answers are never returned in session/marks/availability
responses. A session snapshots the full approved question and language metadata;
later edits/retirement do not change an already-started attempt.

`grade_answer` grades the **current answer only**, using one bounded model call
and at most one additional call if the assessment fails schema or evidence validation.
Both results must pass the same strict validation: reference-answer text cannot
substitute for transcript evidence. If the retry is invalid, no grade or MP is awarded.

After passing, each reading activity and Q&A question has a seven-day cooldown
per student, enforced by the backend across devices, languages and question versions.
Failed answers do not start a cooldown. Other tasks at the same service remain
available; selection never moves the student to another service. Availability
summaries expose `onCooldown` and `availableAt` (Unix seconds).
Existing records use `completedAt` until a later pass records `lastPassedAt`.
Passing again after the week renews the cooldown but does not award MP again:
the existing first-pass-only reward rule remains unchanged.
The model returns each approved concept as met, missing or contradicted, with
verbatim transcript evidence for met/contradicted concepts and short feedback.
Both layers validate the concept partition; evidence must occur in the submitted
transcript after case, Unicode and whitespace normalization. Lambda sums only met
concept weights; the model cannot choose scores, pass status or rewards.
This is a meaning assessment, not pronunciation, word-count or passage coverage.
Short answers such as `S3` are accepted for assessment, not automatically passed.
Empty/punctuation-only answers are rejected before reserving an attempt.

The result uses `breakdown:{understanding:score}`. First-pass Q&A rewards are
**10 MP at 60, 20 MP at 75, 30 MP at 90**, versus 5/10/15 for reading. Both use
the same 100 MP wallet cap, six attempts and 100 daily submissions. Credit is
atomic and once-only, including when the wallet is full. Progress is keyed by
`ACTIVITY#qa:serviceId:questionId`, independent of reading and shared across
languages/versions. Editing a question does **not** reset its reward. Do not
rename IDs to refresh rewards. Old grade records retain their assessed version;
question edits cannot regrade history.

Marks include type, public title/ID and available languages, with a task-type
filter. Saved marks for retired or temporarily unapproved questions remain
visible with `available:false`. Q&A does not rewrite legacy service participation
or give a cosmetic read-aloud badge.

### Batch publishing and exporting questions

`questions.json` contains **12 bilingual questions** across six services. Use
`publish` to import a batch directly as available questions, without a separate
draft or approval step. Publishing still validates wording bounds, languages,
rubric weights, stable IDs and revisions. Deployment does not implicitly import
this file: content publication is an explicit operator command.

From the repository root, use authorised AWS operator credentials (for example
your configured AWS profile). Student game API keys cannot run these commands.
Select the deployment and resolve its actual table name:

```sh
export AWS_REGION=us-east-1
export VOICE_TABLE="$(aws cloudformation describe-stack-resource \
  --stack-name CloudProjectMarker --logical-resource-id VoicePracticeTable \
  --query 'StackResourceDetail.PhysicalResourceId' --output text --no-cli-pager)"
```

Change the region and stack name for a different deployment. Then:

```sh
# Offline validation, no AWS calls:
node src/VoicePractice/question-bank.mjs validate src/VoicePractice/questions.json

# Authenticated operator commands; set AWS_REGION and VOICE_TABLE first.
# First publication only: the bundled file has expectedRevision:null.
# Do not rerun it against existing questions; export before editing instead.
node src/VoicePractice/question-bank.mjs publish src/VoicePractice/questions.json

# Export all questions, or just one service, to a NEW private JSON file:
node src/VoicePractice/question-bank.mjs export questions-export.json
node src/VoicePractice/question-bank.mjs export s3-export.json s3

# After editing an export (increment version on each changed row), publish it:
node src/VoicePractice/question-bank.mjs validate s3-export.json
node src/VoicePractice/question-bank.mjs publish s3-export.json

# Retirement takes the CURRENT revision (a new publication starts at 0):
node src/VoicePractice/question-bank.mjs retire s3 private-screenshots 0
```

Exports include private concepts, acceptable answers and reference answers, **not
student attempts, grades or wallets**. They use owner-only file permissions and
refuse to overwrite an existing file. Never put exports under `web-game`, the
public web bucket, or a shared public location.

For a new question, copy an example and set a new `id`, known `serviceId`,
`status:"approved"`, `version:1`, and `expectedRevision:null`. Supply its title,
translated `prompts`, `concepts` (weights sum to 100), `misconceptions`,
`acceptableAnswers`, and `referenceAnswer`. Empty arrays for the two optional
guidance lists are allowed. No game-code change or frontend deployment is needed
for questions on an existing service and configured language.

For edits, export first, keep each ID and `expectedRevision`, and increment
`version`. Remove unchanged rows from the publication file; every supplied
existing row requires a higher version. A stale revision fails the entire batch
instead of overwriting someone else's update. Publication accepts 1-100 questions
per atomic batch; exports can contain more, so split larger imports into batches.
Repeating a fresh-file publication safely fails rather than overwriting records.
If a revision conflict occurs, export to a new filename, reapply the intended
edits to the current version, and publish again. Do not reset `expectedRevision`
to null or delete database items to bypass the conflict.

After publishing, reopen the service's voice dialog to refresh its question
availability. Export again to a new filename if you need to verify the saved
content and updated revisions. Existing sessions keep their snapshotted question;
new sessions receive the published content. Services with no available questions
continue to show "Questions coming soon."

The optional `import`/`approve` commands remain for anyone who wants a draft
workflow, but are not required by `publish`. Run these commands
with an authorised operator role, never student API keys or browser credentials.
Question items have no TTL; do not delete student activity, grade or wallet rows
when editing or retiring content.

For grading quality, calibrate the deployed model against teacher-labelled
correct, partial, wrong, off-topic, short, code-switched, STT-variant and
prompt-injection answers. Mocked unit tests verify contracts and accounting, not
grading quality. The previously observed repeated 65/100 reading grades remain a
separate unresolved calibration issue; this feature does not change that rubric
or regrade historical attempts.

Deploy the updated agent operation first, then Lambda, then the frontend modules
and HTML (HTML last). The existing table/routes/permissions suffice. Publish or
approve question records only after this rollout is ready. No Q&A data migration,
new AWS resource, automatic approval or live-model calibration is performed by
the local test suite.

## Editing services, passages and languages

The voice catalog is bundled JSON configuration, not database records or application-code lists:

* `languages.json`: `defaultLanguage` and a `languages` array. Each entry defines a unique BCP 47 `id`, display `label`, browser `speechLocale`, and `feedbackLanguage` instructions for the grader. Browser support for a locale depends on the device/provider.
* `activities.json`: an array of `{activityId,version,serviceId,label,round,readingTexts}`. `readingTexts` maps configured language IDs to authored passages, each at most 2,000 characters. Service IDs must match the discovery catalog's keys for signs to open that service.
* `lessons.json`: the six **legacy** comprehension lessons. Do not edit these to add new graded voice services or languages; approved historical banks remain separate.

For example, to offer French, append this entry to `languages.json`:

```json
{"id":"fr-FR","label":"Français","speechLocale":"fr-FR","feedbackLanguage":"French"}
```

Then add a `"fr-FR": "..."` translation to `readingTexts` for each activity that should offer French. No HTML, JavaScript whitelist, agent-code or infrastructure change is required. Partial translation coverage is allowed: PC and phone list only languages with an actual passage for that activity. They never present an English fallback as another language. The configured default is preferred when available; otherwise the first available configured language is used. Language selection changes discard unsent speech.

To add another service, add its activity object using the catalog's service ID and a new stable activity ID. To add a round, add another activity with a higher `round`. Keep service labels consistent across its activities. New discovery services must also exist in the game's discovery catalog; configuration does not create world geometry.

Do not rename/delete existing rewarded activity IDs to edit text: saved progress and once-only rewards are keyed by ID. Adding a faithful translation uses the **same ID/version**, so it grants no second reward. Materially changing an activity's meaning requires a new version and activity ID and intentionally creates a new reward opportunity. Keep older configured versions when their grades should remain visible. Never delete student data to update content.

Run `npm test --prefix src/VoicePractice` and `npm test --prefix src/VoiceAgent`, then package/redeploy the voice backend using the existing deployment process. Both JSON files are included automatically. These are bundled files: saving a file locally does **not** hot-update the deployed Lambda. Routine content/language edits require a backend deployment but no frontend rebuild. Invalid configuration is rejected during loading/tests rather than silently enabling bad passages.

New sessions snapshot passages, labels, available-language metadata and defaults; later configuration edits cannot change an active PC/phone session. Existing grades and MP are not rewritten. Grading feedback follows the selected configured language; different languages of one activity share its single reward. Progress loads through an authenticated, paginated player activity-prefix query instead of one database read per catalog entry.

## Authenticated desktop contract

All desktop routes use the existing API Gateway API-key requirement and canonical Email identity lookup. Success is 200 JSON with `Cache-Control:no-store`; errors are `{error}`. Capabilities are never accepted in query parameters. Timestamps are Unix seconds.

* POST `/voice/sessions`, `{serviceId}`: returns `{id,activityId,serviceId,serviceLabel,round,mode,readingTexts,languages,defaultLanguage,question,status:"ready",paired:false,inputDevice:"desktop",attempts:0,maxAttempts:6,expiresAt,...}`. `languages` contains safe `{id,label,speechLocale}` metadata for available passages; `question` aliases the activity's default passage. `pairingToken` is also returned for compatibility, but **cannot be claimed before explicit transfer**.
* GET `/voice/sessions/{id}`: returns full passage, device, attempts, expiry, status, result and optional wallet. Never raw transcripts. `completed` preserves service-completion semantics; only `status:"completed"` proves this session passed.
* POST `/voice/sessions/{id}/answer`, `{source:"browser",speechCompleted:true,transcript,language}`: accepts only the owner's desktop session. Returns `status:"evaluating"`; poll the owner GET route for completion.
* POST `/voice/sessions/{id}/transfer`, `{}`: ready desktop sessions only. Keeps the same session/activity, revokes old pairing/mobile hashes, creates a five-minute `pairingToken`, and returns `inputDevice:"phone",status:"pairing"`. Cannot transfer an evaluating/completed session or take phone input back.
* POST `/voice/sessions/{id}/cancel`, `{}`: cancels and revokes capabilities.
* GET `/voice/wallet`: `{balance,max:100,earned,spent,revision}`. Initial balance, lifetime credited earnings, spending and revision are zero. No read-badge conversion.
* POST `/voice/casts`, `{requestId:UUID,spell,level}`: spells are lightning/fireball/frost/storm/shockwave, level is integer 1–3, cost equals level. Returns `{requestId,spell,level,cost,cooldownUntil,wallet}`. Shared server cooldown is respectively 6/5/4/9/2 seconds, across tabs and spell types. Insufficient balance, active cooldown and reuse with different payload return 409 without debit. A successful retry returns its original response, including the original wallet snapshot; GET wallet refreshes current state. Request IDs are scoped per owner and normalized to lowercase. Bounded contention exhaustion returns 503: retry the **same requestId**, especially after a network failure.
* GET `/voice/completions`: `{services,completed,total,wallet,activities}`. `services` preserves six service rows and existing completed/total semantics; new graded rows may add `bestScore,latestScore,feedback,mpAwarded`. `activities` contains all configured `{activityId,serviceId,label,round,completed,bestScore,latestScore,feedback,mpAwarded,completedAt}` rows. Ungraded slots have null scores/feedback/time and zero MP; historical ungraded participation stays in service rows only, without manufactured scores or rewards.

New session results are `{score,passed,feedback,breakdown:{coverage,content},mpAwarded,activityId}`. `mpAwarded` is the actual credited amount, not nominal entitlement. Responses include `resultActivity:{activityId,serviceId,round,path:"/voice/completions"}` for result navigation.

## V2 checkpoint saves

GET and POST `/game/save` require the same validated API key as desktop voice.
POST accepts `{revision,requestId:UUID,state}`; GET and successful POST return
`{revision,requestId,updatedAt,state}`. `state` schema 2 contains a configured
`checkpoint`, `equipment:{weapon,shield,finish,spell,level}`,
`adventure:{chests,boss}` and `missions` (prior task-filter identities). Enum
values are in `game-save.json`; tests keep them aligned with the playable world.
Schema 1's `{schemaVersion,checkpoint,weapon,shield}` migrates to schema 2.
Removed stored checkpoints fall back to village; unknown versions cannot be
overwritten. Bodies are bounded to 65,536 characters and contain no raw position,
health, XP, MP, grades, owner identity or credentials.

The durable key is `PLAYER#owner / GAME_SAVE`, without TTL. Conditional writes
check the previous revision (0 means no save) and record the request ID/hash.
An identical latest request can be retried after a lost response; a changed
payload or stale revision returns 409. Clients must not auto-overwrite conflicts.
Only the latest request ID is retained: replaying an older request after another
save conflicts rather than moving progress backwards.

Saved mission filters contribute only while all named tests still exist with
positive marks in the owner's `PASSED_TEST_TABLE` partition. Reads are consistent
and paginated, scoped through canonical Email lookup; the Lambda has Query-only
access to this table. Cached client data is not a source of marks, MP or grades.
Chest/boss state is **client-reported cosmetic progress**, not anti-cheat proof;
neither migration nor saves create any wallet, grade or passed-test records.
Task resets invalidate mission-derived finishes on load; exploration-derived
cosmetics are independent. Saves recover known mission identities, not a new
cross-device task-assignment system.

Deploy the backend/template before publishing `v2/game-save.js`, updated main
and HTML. Marks filtering also adds `v2/voice-marks.css`. Include the updated
favicon and React app's public icons when publishing branding; the old nine-file
voice-only publication list is not sufficient for this release.

## Phone contract

POST `/voice/mobile/claim`, `{id,pairingToken}`, after desktop transfer: one conditional claim sets `ready`, keeps `inputDevice:"phone"` and returns a short-lived `mobileToken`. Use bearer authorization for GET `/voice/mobile/session` and POST `/voice/mobile/answer`; answer payload is identical to desktop. Desktop answers then return 409. Phone and desktop polls share evaluation recovery. New graded polls never return transcripts or conversation history. Retired upload/transcribe routes return 404.

Current statuses are `pairing`, `ready`, `evaluating`, `completed`, `failed`, `cancelled`; mode-less legacy generation also uses `claimed`, `generating_question`, `awaiting_question_approval`. Expired/cancelled sessions return 410. Sessions last twenty minutes; a transfer's pairing capability lasts five minutes. TTL is cleanup only, never authorization.

## Atomicity, limits and recovery

At most six distinct submissions per session and 100 per canonical owner per UTC day. Reservation of session, transcript-hash attempt and daily counter is transactional; retries of identical normalized transcript/language reuse the reservation. Concurrent reservation conflicts return 409 safely.

New grading is asynchronously enqueued to avoid API Gateway timeouts. Workers conditionally claim attempts and mark model evaluation started before invoking AgentCore. A validated grade is saved before crediting; storage conflicts and repeated workers reuse that saved grade, never rerun the model for it. Credit atomically updates the session result, attempt, durable grade, activity, optional service metadata and wallet. Each activity gets one reward on its **first passing grade** across all sessions/tabs, never improvement rewards.

Wallet capacity is 100; earned MP is capped to actual remaining capacity, including zero when full. First pass consumes the activity reward even when capped: no hidden overflow or later credit. Wallet transactions serialize grade credits and cast debits with revisions. Cast authorization, cooldown and idempotency record are atomic.

Model/malformed-response failure returns `result.error:"processing_failed"` and retryable `ready`, never a fake zero score or MP. Retrying the identical transcript may re-enqueue failed processing up to three times without another daily/session reservation; after that start a new practice later. A different transcript counts as another submission. Nonpassing sixth grades end in `failed`. Poll recovery redispatches stale unleased work; a ten-minute processing timeout releases interrupted model processing safely. A saved grade remains recoverable rather than being replaced by processing failure.

Sessions and raw transcript attempts retain their existing TTL (attempt expiry is session expiry plus one day). `PLAYER#owner` / `ACTIVITY#versionedId`, `GRADE#session#hash`, `WALLET`, `CAST#requestId` and completion metadata have **no TTL**. Daily counters expire two days after day start. Never log transcripts, authorization, request bodies, API keys or capabilities.

## Legacy compatibility and permissions

Existing `read_aloud` sessions keep deterministic ungraded participation completion. Mode-less sessions keep the bounded legacy comprehension flow. Existing ungraded completions are never rewritten, assigned historical grades, converted to MP or used to mark new activities passed. The six approved legacy banks remain untouched by new sessions.

Legacy banks remain `BANK#service` / `LESSON#version`, with operator review:

```
VOICE_TABLE=... node review-bank.mjs show s3 1
VOICE_TABLE=... node review-bank.mjs approve s3 1 EXPECTED_REVISION REVIEWER
```

Required environment: `VOICE_TABLE` (string PK/SK, TTL `expiresAt`), `API_KEY_LOOKUP_TABLE` (`ApiKey`/canonical `Email`), `PASSED_TEST_TABLE` (read-only mission validation for game saves), `VOICE_WEB_ORIGIN` (exact origin), `VOICE_AGENT_RUNTIME_ARN`, optional `VOICE_AGENT_QUALIFIER`. Lambda supplies `AWS_REGION` and its own function name. AgentCore uses the existing configured `VOICE_MODEL_ID`.

No new broad permissions: voice-table conditional transactions, existing identity lookup, existing AgentCore invocation, self async invocation and encrypted logging. Browser routes have no audio-bucket or Transcribe access. Preserve async age/retry/failure queue settings. The retired encrypted bucket remains lifecycle-managed for cleanup; no recording CORS. Keep encrypted logs, restricted staff access, CloudTrail and monitoring.
