# Voice practice backend

Node.js 22 Lambda: `index.handler`. Package this directory including production dependencies. Run `npm test` here, `npm test --prefix ../VoiceAgent` for the agent, and `python3 -m unittest discover -s tests -p test_voice_deployment.py` from the repository root. Tests use no live AWS services.

## Authored reading and grading

New sessions default to server-owned `mode:"graded_read_aloud"`. `activities.json` contains 308 immutable versioned activities covering all 302 discoverable services in English, Cantonese and Mandarin (Simplified Chinese). Every service has round one; s3, ec2, iam, vpc, lambda and dynamodb retain their existing second round. The twelve original identifiers and English/Cantonese passages are unchanged. No questions are generated for these sessions.

The server selects unfinished activities within the requested service, preferring the earliest available round. It never switches to another service. A reading pass locks every reading round at that service for seven days, across all languages. If reading is locked, creation returns 409; no unlimited reward generation is available.

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

After passing any reading activity, all reading rounds for that service have a seven-day cooldown.
Each Q&A question has its own seven-day cooldown,
per student, enforced by the backend across devices, languages and question versions.
Failed answers do not start a cooldown. Reading and Q&A locks are independent;
other Q&A questions at the same service remain available. Selection never moves the student to another service. Availability
summaries expose `onCooldown` and `availableAt` (Unix seconds).
Existing records use `completedAt` until a later pass records `lastPassedAt`.
Passing again after the week renews the cooldown. The existing first-pass-only
reward rule per activity remains unchanged; a previously unpassed reading round
can earn its first reward after the service reading lock expires.
The PC checks database availability on icon click and again when opening voice tasks;
it disables locked actions and never creates a reading session merely by opening the dialog.
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

`questions.json` contains **12 questions in English, Cantonese and Mandarin** across six services. Use
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

# Strands Multi-Agent Question Generator & AWS Docs Auditor (resumable per service):
# Mines common interview questions via Amazon Nova Web Grounding (nova_grounding),
# verifies both question and answer against official AWS docs via https://knowledge-mcp.global.api.aws,
# localizes into en-US, zh-HK and zh-CN, calibrates against synthetic student transcripts,
# and checkpoints/publishes approved questions per service:
node src/VoicePractice/question-bank.mjs generate generated-questions.json rds,cloudfront,ecs --count=2
node src/VoicePractice/question-bank.mjs refresh refreshed-questions.json s3,ec2

# Single-service generation with live Strands OpenTelemetry tracing (Jaeger on http://localhost:16686):
OTEL_TRACES_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=aws-warrior-question-generator \
node src/VoicePractice/question-bank.mjs generate /tmp/s3-single-question.json s3 \
  --count=1 --no-publish --force --otel --trace-console --trace-json=/tmp/s3-single-trace.json
```

See [`docs/QUESTION_GENERATOR_AGENT.md`](../../docs/QUESTION_GENERATOR_AGENT.md) for the complete architecture of the 4-agent Strands `Graph` pipeline (`interview_miner` → `aws_docs_fact_checker` → `trilingual_localizer` → `calibration_critic`), `@strands-agents/harness` (`createHarness`, `GoalLoop`, `ContextOffloader`), multi-layer turn limits (`maxTurnsPerNode = 4`, `limits: { turns: 1 }`, `maxAttempts = 3`), stage-classified feedback routing (`localization`, `rubric`, `topic`), and native Strands OpenTelemetry tracing.

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

Mandarin is configured as `zh-CN`, displayed as **普通话 · Mandarin (Simplified Chinese)**.
All 308 authored readings and 12 Q&A prompts have Simplified Chinese translations.
Browser recognition uses `zh-CN`; grading feedback explicitly requests Mandarin
in Simplified Chinese, not Cantonese. Device/browser recognition support still varies.
English and Cantonese content, activity IDs, rewards and cooldowns are unchanged.
Deploy the backend configuration and passages, then update existing approved
database questions with the additional `zh-CN` prompts using the revision-checked
export/publish process and a higher question version. Do not republish the seed
file over existing rows or reset grades, wallets or completion records.
Already-open PC/phone sessions keep their saved language snapshot; start a new
session to see Mandarin after deployment/publication.

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
* POST `/voice/casts`, `{requestId:UUID,spell,level}`: persisted IDs lightning/fireball/frost/storm/shockwave select event lightning, elastic clones, storage domain, private-cloud ward and recovery anchor. Fixed costs are respectively 12/15/20/15/25 MP and shared server cooldowns are 12/20/45/25/60 seconds. Legacy integer levels 1–3 remain accepted but do not change costs or strength. Returns `{requestId,spell,level,cost,cooldownUntil,wallet}`.
* Combined casts use `{requestId:UUID,spells:[...]}` with 1–5 unique IDs and no `spell` or `level`. The server sorts IDs, sums costs and uses the maximum cooldown. All five cost 87 MP with 60 seconds shared cooldown. A single transaction records the entire debit and idempotent response `{requestId,spells,cost,cooldownUntil,wallet}`. Selecting all five also activates Global Deployment (全域部署): three local execution waves expand to a 128-unit radius over 1.2 seconds each, defeating normal enemies and bosses when reached, using normal damage/death events. Buildings and solid walls block waves; ground clutter and water do not. Four directional guardian avatars animate those waves. There is no additional MP charge; combat remains client-side. All kills from one cast share one grading batch, preventing repeated AWS grading requests across successive waves.
* Insufficient balance, active cooldown and request-ID reuse with a different selection return 409 without debit. Retrying the same selection (even reordered) returns its original response; GET wallet refreshes current state. IDs are owner-scoped and normalized to lowercase. Bounded contention returns 503: retry the **same requestId**, especially after network failure. Existing single-art records remain replayable.
* GET `/voice/completions`: `{services,completed,total,wallet,activities}`. `services` preserves six service rows and existing completed/total semantics; new graded rows may add `bestScore,latestScore,feedback,mpAwarded`. `activities` contains all configured `{activityId,serviceId,label,round,completed,bestScore,latestScore,feedback,mpAwarded,completedAt}` rows. Ungraded slots have null scores/feedback/time and zero MP; historical ungraded participation stays in service rows only, without manufactured scores or rewards.

New session results are `{score,passed,feedback,breakdown:{coverage,content},mpAwarded,activityId}`. `mpAwarded` is the actual credited amount, not nominal entitlement. Responses include `resultActivity:{activityId,serviceId,round,path:"/voice/completions"}` for result navigation.

## Browser AJAX audit and request lifecycle

This section covers the V2 game, PC/phone voice practice, and voice-marks page.
It does not imply identical behavior in Classic, the React administration app,
scheduled bulk grading or direct API clients. Static model/icon/CDN downloads,
browser-managed speech services and CORS preflight requests are separate from
the application calls below.

### Request inventory

| Trigger | Application request | Concurrency and repetition |
|---|---|---|
| E near a guide, with a saved key and no active quest | GET `game` | `Game.talking` blocks repeated guide requests while pending. Existing instructions reopen locally. Twenty-second client timeout; no automatic request retry. |
| First eligible monster death from an attack | GET `grader?filter=...` | One grading attempt per cast batch, plus one in-flight grading promise per `GameApi` instance. No active quest means no request. Client timeout is 180 seconds. |
| Game startup, account/key change, or a displayed voice result | GET `voice/wallet` | Explicit refreshes, not a frame timer. Concurrent refreshes are possible; wallet revision prevents stale responses replacing newer balances. Twenty-second timeout. |
| One selected art | POST `voice/casts` with `requestId`, `spell`, `level` | One pending reservation per wallet instance. Cost/cooldown are server-owned; no local effects before authorization. |
| Several selected arts, including Global Deployment | POST `voice/casts` with `requestId`, `spells` | One request for the entire selection, not one per art, clone, wave or enemy. Same atomic wallet/receipt transaction as single casting. |
| Click a service sign or mission-service badge | GET `voice/completions` | Checks availability for the signed-in owner; the client filters the catalog to that service. Epoch/owner guards ignore stale responses. |
| Open the task chooser, close/revisit the reader, or complete a task | GET `voice/completions` | Availability may be checked again deliberately. Opening the chooser does not itself create or submit a task. These catalog reads are not billed grading attempts. |
| Press Start on an available task | POST `voice/sessions` | `starting` prevents repeated starts from that chooser while pending. Current reading/Q&A creation selects authored content; it does not assess speech. |
| Select phone transfer | POST `voice/sessions/{id}/transfer` | Uses the same starting/busy guard. The saved task is transferred, not duplicated; old pairing credentials are revoked. |
| Open a valid QR on phone | POST `voice/mobile/claim` | Claims the existing session conditionally. Recovered device capabilities use the existing session. The pairing token is removed from the address bar after successful claim. |
| Submit final desktop speech | POST `voice/sessions/{id}/answer` | Shared speech UI has a submitting guard and requires final speech. Server transcript-hash deduplication controls attempts and rewards. |
| Submit final phone speech | POST `voice/mobile/answer` | Same speech guards and backend attempt rules, using the phone capability rather than the account API key. |
| Active-device grading progress | GET `voice/sessions/{id}` or `voice/mobile/session` | One immediate status check after an evaluating submission, then sequential four-second timers. At most 150 timer checks before manual recovery; not overlapping fixed-interval requests. |
| Desktop checks a task transferred to phone | GET `voice/sessions/{id}` | Explicit Check action; there is no background desktop polling of phone results. Normal UI disables the check control while requesting. |
| Load a signed-in checkpoint | GET `game/save` | One operation at a time per `GameSave` instance; generation guards reject old-account responses. Fifteen-second timeout. |
| Equipment, primary art, map, chest, boss or mission progress changes | POST `game/save` | Debounced by 750 ms and serialized. Unchanged state does not POST. Visibility changes may flush a pending save. No per-frame position saves. |
| Open voice marks with a key, or submit its refresh form | GET `voice/completions` | Twenty-second timeout; response revision and key checks reject stale displays. Search/type/status filters are entirely local. |
| Change attack voice, preview or announce an art | No application AJAX | Uses browser speech synthesis; mute, volume, voice availability and browser-provider behavior still apply. |

Game/mission requests explicitly use `cache:"no-store"`. Wallet and marks
requests also bypass browser caching. Voice/session and checkpoint responses
carry server `Cache-Control:no-store`. Keys go in headers, never in resource
URLs. Phone capabilities are not accepted in API query strings. Error text is
rendered as text rather than HTML.

### Exactly what “one grading call” means

1. A successful local cast creates one in-memory batch object. A combined cast
   shares it across every selected art, clone, delayed pulse and execution wave.
2. Damage messages carry the batch into the victim's health component. Only a
   real death invokes the normal monster-death handler; already-dead targets
   cannot trigger another death reward.
3. `Game.grade(batch)` marks the batch consumed before starting asynchronous
   work. Subsequent deaths in that batch cannot retry it, even after its first
   check fails or returns “changes needed.”
4. `GameApi.gradeQuest()` also shares one in-flight promise. If another cast
   kills while a check is pending, that cast's grading opportunity is consumed;
   it does not queue a follow-up check after the pending request completes.
5. A separate later cast or ordinary melee kill may request another check.
   No quest means zero grading requests. Successful grading clears the matching
   active quest and updates verified mission progression.

The scope is **one browser game instance and its current in-memory cast**.
`GraderFunction` does not accept a durable idempotency key or maintain a
server-side per-cast receipt. Another tab/device, a reload, direct API calls,
or another cast after a timeout can therefore execute another grader invocation.
A client abort stops waiting; it does not prove Lambda or its AWS resource
checks stopped. The grader may itself run multiple unit tests and AWS API calls,
so one browser AJAX request is not one downstream AWS request.

Mass kills still update individual death animations, kill counts, XP, boss
cosmetics and respawn scheduling. Those effects do not each request another
mission grade. Boss progression and a grading result can separately schedule
checkpoint saves; these are not additional grader calls.

### MP reservations, retries and account changes

`MagicWallet.busy` and `checking` block overlapping cast submissions within a
game instance. The complete spell selection is validated and its total cost is
checked before reserving. The server atomically writes a revised wallet and
an owner-scoped cast receipt. Duplicate or reordered combined requests return
the same stored receipt without charging again; a changed selection using the
same ID returns 409. Wallet revision checks serialize requests from different
tabs/devices and prevent overspending.

A network failure, 5xx response, invalid JSON or mismatched authorization keeps
the same pending request ID for an explicit retry. A confirmed 4xx response
clears it; 409 also refreshes the wallet. Cast POSTs are not automatically retried.
An authorization received while gameplay has become invalid is held for retry
without another charge. The local receipt is marked applied before effects run,
preventing effect replay if local rendering throws.

Pending cast IDs are in memory, not durable browser recovery records. Reloading
after an uncertain reservation can lose the local retry ID even if the server
debited MP. There is no automatic refund or replay of a paid effect after reload.
Prefer retrying the same pending selection before refreshing the page.

Changing the key resets wallet state, pending local IDs and applied-effect
tracking; late responses from the old epoch cannot affect the new wallet or
execute its effects. This does not undo a request already accepted by the server
for the previous owner. Mission result and error UI also check the key, marks
reset value and progress version before changing the current account's display.

### Voice assessment, polling and checkpoint recovery

Speech submissions are deduplicated by the server's normalized transcript and
language hash within a session. Attempt count, daily budget and work reservation
are conditional/transactional. Duplicate deliveries do not grant another reward.
First-pass progress, immutable grade and wallet credit are committed together.
Different sessions can still produce distinct assessments; the shared activity
record prevents duplicate first-pass MP.

Only an evaluating/generating session schedules automatic status checks.
Terminal/ready states stop that schedule. A network/status error stops polling
and exposes recovery controls; it does not automatically resubmit the transcript.
After an uncertain submission, check the saved session before submitting again.
Status GETs may conditionally redispatch a stalled grading attempt; they are not
unconditionally read-only, and workers enforce their own leases/idempotency.
See the atomicity section below for the bounded worker-recovery policy.

Session creation and transfer have UI guards but no general client-supplied
request-ID contract. A timed-out create followed by another explicit Start may
leave an unused earlier session; it must not be described as exactly-once
creation. Availability and result GETs can repeat across modal lifecycle events.
Owner/session epochs prevent stale rendering, not necessarily duplicate HTTP
traffic. Repeated result checks can also refresh the wallet, without adding MP.

Checkpoint POSTs are different: the pending revision, request ID and immutable
payload are stored in an account-scoped local recovery record. Network failures
retry with the same payload, using backoff from 2 to 30 seconds. A successful
POST followed by a lost response can be acknowledged by GET using its request ID.
New edits while a save is pending are sent later with a new revision and ID.
409 conflicts stop automatic writes and require explicit loading of the latest
save; auth, malformed-request and unsupported-version failures do not loop.
The saved server record retains only the latest save request ID, not a permanent
history of all save receipts.

### Audit evidence and limits

Focused regressions cover cast-batch identity across delayed hits, checks after
completed/failed AJAX requests, shared in-flight grading, stale-account errors,
atomic multi-art debit, uncertain-response retries, save conflicts, session
submission guards and bounded polling. The served-page browser harness exercises
real monster deaths and map travel with mocked API responses. These checks do
not prove production exactly-once Lambda execution or test a physical microphone.
No student records, marks or MP are changed by the local audit.

## Client gameplay and release scope

The player-facing [cloud-art guide](../../README.md#cloud-arts-and-combined-attacks)
documents costs, multi-selection and Global Deployment. Selecting all five
uses the ordinary cast control; there is no separate ultimate button.
Its four six-times-size avatars animate three expanding execution waves.
Effects, range display and temporary camera framing use the same 128-unit range;
the server continues to authorize only the 87 MP debit and 60-second cooldown.
One client-side grading batch spans every damaging component of a cast, so later
kills from its clones, fields or waves do not issue additional mission-grader
requests. A later independent attack may trigger another check.

World populations are 24 ordinary enemies plus the Warden in the village, and
14 ordinary enemies plus one elite in each expedition. Boss models are twice
their earlier size, without changing their HP or the execution-wave rule.
Melee target acquisition (`findAttackTarget()` in `web-game/v2/main.js`) accounts
for both point-blank contact (`closeRangeLeeway = 2.6 + (m.hitRadius ?? 0)`,
allowing 360° hits when an enemy overlaps the player) and large monster attack
ranges (`Math.max(weapon.reach, (m.attackRange ?? 0) + 1.0)`), ensuring any
monster close enough to melee-strike the player can always be struck back with
any equipped melee weapon.
Existing actor pools and respawn behavior are retained; these frontend changes
do not migrate student data or create new rewards.

Attack announcements use browser text-to-speech, separate from voice-practice
recognition and grading. Cantonese voice choice and preview depend on the
device's exposed voices; a male voice is not guaranteed. Global Deployment reads
both its Chinese and English names. These announcements do not invoke Bedrock
or upload application audio.

For gameplay releases, publish changed dependencies before `v2/main.js` and
`game-v2.html`, update module cache tags, invalidate affected CloudFront paths
including query-string variants, and verify served files against local hashes.
Relevant dependencies include `v2/magic.js`, `v2/magic-effects.js`,
`v2/audio.js`, `v2/maps.js`, `v2/monsters.js` and `v2/style.css`.
Deploy Lambda first when cast request/response contracts change. Back up replaced
assets, review resource changes, and preserve all grades, wallets, questions
and saved progress. A frontend-only visual or naming change requires no
question-bank republication or backend deployment.

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
