# Voice practice backend

Node.js 22 Lambda: `index.handler`. Package this directory including production dependencies. Run `npm test` here, `npm test --prefix ../VoiceAgent` for the agent, and `python3 -m unittest discover -s tests -p test_voice_deployment.py` from the repository root. Tests use no live AWS services.

## Authored reading and grading

New sessions always use server-owned `mode:"graded_read_aloud"`. `activities.mjs` contains twelve immutable versioned activities: two bilingual (`en-US`, `zh-HK`) authored passages per service, for s3, ec2, iam, vpc, lambda and dynamodb. Passage changes require new version identifiers. No questions are generated for these sessions.

The server selects unfinished round-one activities before round two. A requested service is preferred only within the eligible round's unfinished services. Thus requesting an already-passed service can return another service. Once all authored activities pass, creation returns 409 with a safe exhaustion message; no unlimited reward generation is available.

AgentCore's `grade_reading` operation makes one bounded model call, assessing the current browser transcript against either/both language versions. It grades coverage (integer 0–70) and content fidelity (integer 0–30), summing to integer score 0–100. It tolerates Cantonese, English, code switching, paraphrases and recognition variants. It does not assess pronunciation or comprehension, request explanations or run a conversation. Both the agent and Lambda validate grades and bounded feedback. The server alone determines passing (`score >= 60`) and nominal first-pass rewards: 5 at 60, 10 at 75, 15 at 90.

The adapter and agent canonicalize language maps to English then Cantonese before invocation, because DynamoDB does not preserve map insertion order. Weighted rubric bounds remain strict: malformed model grades (such as content 35/30) produce processing failure, never clamping, invented scores or rewards.

Speech recognition runs in the browser, which may send audio to its own provider. The backend receives final text only: no recording, audio upload, presigning or Amazon Transcribe integration. Transcript maximum is 6,000 characters. Client-supplied scores, passage text, history, owner identities and reward claims are ignored.

Desktop and phone graded submissions reject silence, punctuation and insufficient speech with 400 before reserving attempts or daily budget or queuing model work. Meaningful speech requires two word groups totaling at least eight letters/digits, or six Han characters with at least three distinct characters. This is only an input-quality gate, not a reading grade.

## Authenticated desktop contract

All desktop routes use the existing API Gateway API-key requirement and canonical Email identity lookup. Success is 200 JSON with `Cache-Control:no-store`; errors are `{error}`. Capabilities are never accepted in query parameters. Timestamps are Unix seconds.

* POST `/voice/sessions`, `{serviceId}`: returns `{id,activityId,serviceId,serviceLabel,round,mode,readingTexts,question,status:"ready",paired:false,inputDevice:"desktop",attempts:0,maxAttempts:6,expiresAt,...}`. `question` aliases the English passage. `pairingToken` is also returned for compatibility, but **cannot be claimed before explicit transfer**.
* GET `/voice/sessions/{id}`: returns full passage, device, attempts, expiry, status, result and optional wallet. Never raw transcripts. `completed` preserves service-completion semantics; only `status:"completed"` proves this session passed.
* POST `/voice/sessions/{id}/answer`, `{source:"browser",speechCompleted:true,transcript,language}`: accepts only the owner's desktop session. Returns `status:"evaluating"`; poll the owner GET route for completion.
* POST `/voice/sessions/{id}/transfer`, `{}`: ready desktop sessions only. Keeps the same session/activity, revokes old pairing/mobile hashes, creates a five-minute `pairingToken`, and returns `inputDevice:"phone",status:"pairing"`. Cannot transfer an evaluating/completed session or take phone input back.
* POST `/voice/sessions/{id}/cancel`, `{}`: cancels and revokes capabilities.
* GET `/voice/wallet`: `{balance,max:100,earned,spent,revision}`. Initial balance, lifetime credited earnings, spending and revision are zero. No read-badge conversion.
* POST `/voice/casts`, `{requestId:UUID,spell,level}`: spells are lightning/fireball/frost/storm/shockwave, level is integer 1–3, cost equals level. Returns `{requestId,spell,level,cost,cooldownUntil,wallet}`. Shared server cooldown is respectively 6/5/4/9/2 seconds, across tabs and spell types. Insufficient balance, active cooldown and reuse with different payload return 409 without debit. A successful retry returns its original response, including the original wallet snapshot; GET wallet refreshes current state. Request IDs are scoped per owner and normalized to lowercase. Bounded contention exhaustion returns 503: retry the **same requestId**, especially after a network failure.
* GET `/voice/completions`: `{services,completed,total,wallet,activities}`. `services` preserves six service rows and existing completed/total semantics; new graded rows may add `bestScore,latestScore,feedback,mpAwarded`. `activities` contains twelve `{activityId,serviceId,label,round,completed,bestScore,latestScore,feedback,mpAwarded,completedAt}` rows. Ungraded slots have null scores/feedback/time and zero MP; historical ungraded participation stays in service rows only, without manufactured scores or rewards.

New session results are `{score,passed,feedback,breakdown:{coverage,content},mpAwarded,activityId}`. `mpAwarded` is the actual credited amount, not nominal entitlement. Responses include `resultActivity:{activityId,serviceId,round,path:"/voice/completions"}` for result navigation.

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

Required environment: `VOICE_TABLE` (string PK/SK, TTL `expiresAt`), `API_KEY_LOOKUP_TABLE` (`ApiKey`/canonical `Email`), `VOICE_WEB_ORIGIN` (exact origin), `VOICE_AGENT_RUNTIME_ARN`, optional `VOICE_AGENT_QUALIFIER`. Lambda supplies `AWS_REGION` and its own function name. AgentCore uses the existing configured `VOICE_MODEL_ID`.

No new broad permissions: voice-table conditional transactions, existing identity lookup, existing AgentCore invocation, self async invocation and encrypted logging. Browser routes have no audio-bucket or Transcribe access. Preserve async age/retry/failure queue settings. The retired encrypted bucket remains lifecycle-managed for cleanup; no recording CORS. Keep encrypted logs, restricted staff access, CloudTrail and monitoring.
