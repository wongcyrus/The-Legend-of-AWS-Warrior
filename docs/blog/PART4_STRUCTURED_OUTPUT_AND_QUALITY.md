## The Legend of AWS Warrior V2 (Part 4 - Question Quality): From Valid JSON to Better Drafts with Strands Structured Output and Source-Backed Review

**By Cyrus Wong**
*AWS AI Hero | AWS AI User Group Hong Kong Leader | Programme Leader of Higher Diploma in Cloud and Data Centre Administration (IT114115), Hong Kong Institute of Information Technology (HKIIT)*

> **Draft for review.** Implementation and trial observations as of 8 November 2026.
>
> Series: [Part 1 - The Game](PART1_THE_GAME.md), [Part 2 - The AWS Design](PART2_AWS_DESIGN.md), [Part 3 - The Original Question Generator](PART3_GEN_QUESTION.md), and Part 4 - Structured Output and Question Quality.

---

## 1. The Problem: A Question Can Score 100 and Still Be Wrong

In [Part 3](PART3_GEN_QUESTION.md), I described a four-agent pipeline that mines AWS interview topics, checks documentation, translates prompts, and calibrates rubrics against synthetic student answers.

The idea was sensible: generate a good English answer, a good Cantonese answer, and an outdated answer. The good answers should score at least 80, while the outdated answer should fail below 60.

But a live trial exposed a gap:

**Passing calibration tells us that an answer matches the rubric. It does not tell us that the rubric is correct.**

If the writer invents a wrong fact, the synthetic "good answer" can repeat it. The grader can then faithfully award full marks for explaining the wrong fact. We have tested internal agreement, not external correctness.

Our earlier five-question batch demonstrated this:

| Area | What the automated checks missed |
| --- | --- |
| S3 timeline | A scenario described 30 active days followed by another 90 retained days, but the answer archived at day 90 instead of day 120. |
| S3 storage rules | The rubric confused minimum-duration considerations with a blanket prohibition on entering a target storage class. |
| RDS defaults | The answer presented seven days as the universal backup-retention default, ignoring the CLI/API default of one day. |
| Translation | Point-in-time recovery became point-to-point recovery in both Chinese prompts. |
| Grading fairness | Open questions heavily rewarded particular implementations, such as Image Builder or Origin Shield, even when alternatives could satisfy the scenario. |

All five final candidates passed their automated critic and calibration checks. They still needed human review.

This led to two separate engineering questions:

1. Can we make agent outputs reliable enough for software to consume?
2. Can we make the questions accurate, well translated, and fair enough for students?

Structured output addresses the first problem. The recent quality enhancements address parts of the second. Neither should be confused with a guarantee of correctness.

---

## 2. First Enhancement: Replace JSON Scraping with Strands Structured Output

The earlier generator asked models to return JSON as text. Application code then tried to extract and parse that text. A `GoalLoop` could feed parsing failures back into the agent.

This meant that our application owned a fragile formatting problem: code fences, surrounding prose, missing fields, and inconsistent output shapes.

The current generator instead supplies a Zod schema through Strands' `structuredOutputSchema`.

This abbreviated excerpt shows the integration:

```javascript
const agent = await createHarness({
  model,
  systemPrompt,
  tools,
  structuredOutputSchema,
  // Production also configures plugins, restrictions, and turn limits.
});

const result = await agent.invoke(input);
const output = structuredOutputSchema.parse(result.structuredOutput);
```

The production implementation is in [question-generator.mjs](../../src/VoiceAgent/question-generator.mjs).

Strands exposes a `strands_structured_output` tool. It validates the submitted arguments using the supplied Zod schema. Invalid arguments become tool-error feedback, allowing the model to correct them inside the bounded agent invocation.

Our application no longer needs to scrape a question out of model prose. The SDK owns structured-output validation and its supported exact-JSON fallback.

### Can this work with Amazon Nova?

Yes. We use this path with Nova, including the Nova-only generator profile.

However, **Strands structured output is not the same claim as provider-native constrained decoding**. In this implementation, the important contract is the SDK's structured-output tool and validation path. We are not relying on a JSON instruction in a prompt, nor claiming that every provider must always produce valid output.

Provider compatibility still matters. One initial IAM generation in the latest trial failed because the model neither called the structured-output tool nor returned a valid JSON object within that execution.

Structured output gives us a controlled failure instead of silently accepting malformed data.

### Separate schemas for separate responsibilities

Each graph node has a different output contract:

| Node | Structured result |
| --- | --- |
| Interview miner | Topic, candidate ID, community answer, suspected outdated claims, and citations |
| Documentation writer | English prompt, grading concepts, misconceptions, acceptable answers, and source claims |
| Localizer | Complete English, Cantonese, and Mandarin question |
| Calibration critic | Candidate question, synthetic answers, and review verdict |

This prevents a generic "JSON object" from being mistaken for a valid handoff between specialist agents.

The graph forwards validated structured results through its content handoffs. Existing host-side checks still enforce requirements such as concept weights totaling 100, duplicate detection, and preservation of the verified English rubric.

---

## 3. A Small Schema Lesson: Server-Owned Metadata Should Stay Server-Owned

Our first Chinese-profile trials revealed a practical compatibility issue: the localizer repeatedly omitted a nullable `expectedRevision` field.

The distinction matters:

```javascript
expectedRevision: z.number().int().min(0).nullable().optional()
```

Making this field optional in model output does not mean abandoning revision protection.

The server still knows whether a question is new or being refreshed, assigns the authoritative revision metadata, and checks consistency before accepting the result. Refresh and approval retain their revision checks.

The lesson is broader than this one field:

**Do not make an LLM reproduce metadata that the application already owns.**

Structured output improves the contract, but the contract itself still needs good ownership boundaries.

---

## 4. Second Enhancement: Configurable Models and Two Distinct Research Roles

The generator now has per-role model configuration. The default Chinese profile used in these trials is:

| Responsibility | Bedrock model |
| --- | --- |
| Interview mining | `us.amazon.nova-2-lite-v1:0` |
| English rubric writing | `zai.glm-5` |
| Cantonese and Mandarin localization | `qwen.qwen3-next-80b-a3b` |
| Calibration critic and isolated factual reviewer | `deepseek.v3.2` |
| Answer grading | `us.amazon.nova-2-lite-v1:0` |
| Nova web grounding | `us.amazon.nova-2-lite-v1:0` |

These are the selected configuration values, not a universal model ranking. A Chinese-capable model does not automatically produce natural Hong Kong Cantonese, and an independent model is not automatically an accurate reviewer.

An explicit `--model-profile=nova` selects Nova-only generation. Individual roles can also be overridden. Invocation access and tool compatibility must be verified for the selected environment; a model appearing in a catalog is not enough.

### Nova grounding versus Web Answer

The two research mechanisms serve different purposes:

**Nova web grounding helps the miner discover interview topics and community claims.** It answers the discovery question: what are people asking, and what might be outdated?

**Web Answer helps the writer find official AWS evidence.** In the trial configuration, it is accessed through an IAM-signed AgentCore Gateway with an official-AWS domain filter. The public AWS Knowledge MCP path remains another configurable evidence option.

Web Answer is not a student grading tool. It is also not the final proof of a rubric claim. After discovery, the writer must read actual AWS pages.

The deployed `CloudProjectMarkerResearch` stack is separate from the game and student-grading stacks. The generator runs as offline administration tooling. Our latest deployment check found no infrastructure changes, and the student runtime remained unchanged.

---

## 5. Third Enhancement: A Citation URL Is Not Evidence

Adding source links improved traceability, but it did not establish that the linked documentation supported the answer.

We therefore added `read_aws_sources`. In the bounded writer workflow, one successful evidence search is followed by one source-read call for up to three official AWS pages.

The reader:

- Accepts allowlisted AWS HTTPS URLs and validates every redirect.
- Uses a shared 15-second timeout per page read and a one-megabyte download limit.
- Retains at most 16,000 characters of readable source text per page.
- Rejects unsupported content and records truncation.

A canonical URL does not have to appear in the discovery results, but it must actually be fetched successfully before it can support a claim.

### Claims cover the rubric, not just its headline

The writer supplies private records such as:

```json
{
  "field": "concepts.interface-defaults",
  "claim": "Console creation defaults to seven days; CLI/API creation defaults to one day.",
  "sourceUrl": "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.BackupRetention.html"
}
```

Coverage is required for the English prompt, every concept, every misconception, every acceptable answer, and the reference answer.

### Why the server now owns quotations

An earlier approach asked the writer to supply verbatim quotations. Live testing showed that the model sometimes paraphrased or joined separate sentences and presented them as a quote.

The current writer does not author trusted quotations.

Instead, the server selects a contiguous excerpt from the fetched page and binds it to the claim. Writer-supplied quotation fields are not trusted evidence. Source-reference errors are returned directly as structured-output validation feedback.

This establishes provenance: the excerpt came from a page we actually read.

**It does not establish entailment.** Lexical overlap can select relevant-looking text that still fails to support a claim. That is why the next stage must inspect the full referenced field and the full supplied source passage, including qualifications.

---

## 6. Fourth Enhancement: Review Facts Before Grading Answers

The outer graph still has four nodes. Inside its calibration verifier, we now invoke a fresh `FactualReviewAgent` using the configured critic model.

This is an isolated internal review invocation, not a fifth graph node or another independently configurable model role.

> **[INSERT IMAGE: docs/images/aws_warrior_v2_part4_question_quality_pipeline_diagram.png — AWS Strands Question Quality Pipeline: Structured Output, Evidence-Backed Review & Calibration]**

![AWS Strands Question Quality Pipeline: Structured Output, Evidence-Backed Review & Calibration](docs/images/aws_warrior_v2_part4_question_quality_pipeline_diagram.png)

The factual reviewer receives the question, source claims, source passages, and technical glossary. It does not receive synthetic scores or the writer's approval.

Every distinct claim field needs a supported verdict. A top-level `passed=true` cannot override a contradicted, insufficient, or omitted field.

If factual review fails, the verifier does not call the graders for that candidate.

Reviews, including rejections, are cached for the same question and evidence snapshot. Private traces record the verdicts and errors in `qualityReviews`.

We also added a consistency check: an approved review must have an empty `issues` list. During testing, a reviewer placed positive explanations in that list and caused a false rejection. The schema now returns correction feedback rather than silently discarding the inconsistency.

This is another example of structured output doing useful work beyond checking whether a response parses.

---

## 7. Fifth Enhancement: Translation Checks and Valid Alternatives

### Technical terminology needs explicit protection

PITR means point-in-time recovery. It must not become:

- Cantonese: `點對點恢復`
- Mandarin: `点对点恢复`

The glossary gives time-point terminology such as `時間點恢復 (PITR)` and `时间点恢复 (PITR)`. Deterministic checks reject the observed point-to-point mistranslation.

The Hong Kong prompt must also contain spoken Cantonese expressions. But presence is not fluency: inserting `嘅` into an otherwise formal Mandarin-style sentence does not make it natural Cantonese.

The latest drafts still showed that limitation.

### Calibration must include answers the writer did not choose

For open architectural questions, the factual reviewer must propose up to two source-backed, genuinely different valid answers. These are graded alongside the good English, good Cantonese, and outdated answers.

The acceptance targets are:

| Calibration answer | Required result |
| --- | --- |
| Good English | Pass and score at least 80 |
| Good Cantonese | Pass and score at least 80 |
| Outdated answer | Fail and score below 60 |
| Each valid alternative | Pass and score at least 80 |

Fixed feature-comparison questions may have no alternatives, with an explicit reason.

The objective is to stop a rubric from turning the writer's preferred implementation into the only acceptable solution.

However, the reviewer can still misclassify an open question as a fixed-definition question. In that case, the alternatives check can be skipped even though it was needed.

That happened in the latest S3 draft.

---

## 8. The Latest Five-Question Trial: What Actually Improved?

On 8 November 2026, we ran the current Chinese-default pipeline for S3, IAM, EC2, RDS, and CloudFront.

The initial unrestricted batch completed **three of five services**: S3, EC2, and CloudFront.

IAM succeeded in a fresh retry. Broad RDS read-scaling generation exhausted its attempts; a bounded retry focused on backup-retention facts produced the fifth draft.

Across generation and retained retries, we recorded five failed graph traces and thirteen rejected factual-review records. These are different measures: a rejected review is not necessarily a failed service, and not every rejection was correct.

All five final drafts passed question-bank validation and their final automated review and calibration checks. The English and Cantonese calibration answers scored 100 for each. The outdated answers scored between 0 and 50.

Those scores still did not make the drafts publication-ready.

| Service | Improvement observed | Remaining limitation |
| --- | --- | --- |
| S3 | More visible evidence and review history | Optional MFA Delete still carried 25 mandatory points; Object Lock wording needed qualifications. |
| IAM | Supported group-permission explanation and more colloquial Cantonese | The first run failed; the successful question was a relatively simple comparison. |
| EC2 | Correct instance-store reboot versus stop/termination behavior | The final topic was narrower than the earlier rolling-update architecture question. |
| RDS | Correct Console seven-day versus CLI/API one-day defaults, plus the zero/nonzero outage caveat | Some range exceptions and a backup-cleanup timing claim were not properly handled. |
| CloudFront | Origin Shield was no longer mandatory; two proposed alternatives scored 100 | Cache-policy TTLs, origin headers, and alternative-specific conditions still needed precise wording. |

### A concrete improvement: CloudFront fairness

We separately graded a valid answer using content-hashed filenames, updated client URLs, long-lived immutable assets, and a short-lived manifest.

It did not require Origin Shield or query-string versioning.

The live Nova grader awarded **100**. This is a meaningful improvement over the earlier rubric that allocated 30 points to Origin Shield despite the scenario not requiring it.

### A concrete remaining failure: S3 fairness

We also tested an answer using S3 Versioning and Object Lock in Compliance mode, treating MFA Delete as optional for that design.

[AWS documents MFA Delete as an optional additional security layer](https://docs.aws.amazon.com/AmazonS3/latest/userguide/MultiFactorAuthenticationDelete.html).

The grader nevertheless marked the omission as a contradiction and awarded **75**.

That answer passed the student's 60-point threshold, but lost unjustified marks. It would also fail the generator's 80-point threshold for a valid alternative.

The alternatives mechanism did not catch this because the reviewer had classified the question as having no architectural choice.

### Correct facts can coexist with unsupported details

The focused RDS question correctly distinguished the [Console and CLI/API defaults](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.BackupRetention.html).

But its misconception text also claimed that existing backups were removed after the next backup cycle. The fetched sources did not establish that timing. The reviewer incorrectly treated the absence of an immediate-deletion statement as evidence for the proposed explanation.

The cited [ModifyDbInstance SDK documentation](https://docs.aws.amazon.com/sdk-for-kotlin/api/latest/rds/aws.sdk.kotlin.services.rds.model/-modify-db-instance-request/backup-retention-period.html) also lists exceptions to allowing zero retention, including read-replica sources and RDS Custom for Oracle.

These details matter because students should not lose marks for knowing an exception that the question failed to scope out.

---

## 9. What the Trial Does Not Prove

This was a small engineering trial, not a controlled model-quality benchmark.

We did not regenerate exactly the same questions before and after every enhancement. Some successful questions became simpler, and the RDS retry intentionally narrowed the topic.

We therefore cannot honestly claim:

- A measured overall quality gain across the full question bank.
- That Chinese-default models outperform Nova for this task.
- That thirteen review rejections represent thirteen genuinely bad questions.
- That source-backed review guarantees factual correctness or natural Cantonese.

Some reviews correctly challenged unsupported cost-optimization claims and an unnecessary RDS Proxy requirement. Others wrongly rejected a misconception precisely because the documentation showed the belief was false.

For example, if the misconception says users cannot inherit group permissions, documentation showing that they do inherit permissions establishes that the belief is false. It should support the misconception's inclusion, not trigger rejection.

The broad RDS review also alternated between requiring architectural alternatives and rejecting them because the question asked for a singular "strategy." A singular question can still have multiple valid answers.

These failures are useful diagnostic evidence, but they are not improvements in themselves.

There is also a cost tradeoff. Generation and retained retries reported **1,726,279 model tokens**, excluding the two separate fairness probes. [The trace-based costing below](#10-costing-from-traces-not-token-limits) separates model usage, paid research tools, and missing billing data.

The extra checks need to justify their execution cost by catching meaningful defects, not merely adding more agents and more approvals.

---

## 10. Costing from Traces, Not Token Limits

How much did these experiments cost? And does a four-agent graph mean four model calls?

**All amounts here are USD**, priced using public Standard rates checked on **8 November 2026** for `us-east-1` and the Nova US inference profile. These are estimates from reported usage, not an AWS invoice and not configured maximum token counts.

### The earlier Nova trial was cheaper, but its accounting was incomplete

The saved Nova-only structured-output trial contains five successful question traces. They report **204,020 tokens** and **48 main-agent model calls**: an average of **9.6 main-agent calls per question**, ranging from 8 to 12.

Those are not all the calls. A research tool can invoke Nova grounding inside a main-agent turn, and a calibration tool can invoke multiple graders.

| Earlier Nova trial: priced recorded portion | USD |
| --- | ---: |
| Reported model tokens | $0.1196 |
| Eight known Nova grounding requests | $0.2400 |
| **Recorded subtotal for five questions** | **$0.3596** |
| **Recorded subtotal per question** | **$0.0719** |

The original run note explicitly says that these saved traces exclude failed attempts and may omit nested grounding/grader token usage. Completing that trial also needed retries and a temporary forced-output workaround.

Therefore, **about $0.36 is not the complete cost of the earlier Nova trial**. A useful trace visualization does not automatically establish complete cost accounting.

### The latest trial includes more checks, retries, and recorded calls

The Chinese-default trial, including retained failures and fresh IAM/RDS retries, records **221 model calls and 1,726,279 tokens** across all recorded roles. That is **44.2 model calls per completed question**, not 44 calls for the whole five-question batch.

Retries substantially inflated that average, but not every call was a retry. Research requires calls before and after tool results; writing and localization can need schema corrections; independent review and multiple grading tests add calls too. We have not measured a clean, no-retry baseline for the current pipeline.

| Latest Chinese-profile trial | Estimated USD |
| --- | ---: |
| Reported model tokens, priced per model | $1.4231 |
| Seventeen known Nova grounding requests | $0.5100 |
| Eighteen known Web Answer calls | $0.1800 |
| Gateway planning allowance | $0.0009 |
| **Subtotal for five completed questions** | **$2.1140** |
| **Subtotal per completed question** | **$0.4228** |

Nova grounding is priced at **$0.03 per request**; Web Answer at **$10 per 1,000 calls**; Gateway API invocations at **$0.005 per 1,000 operations**. The Gateway allowance assumes ten operations per Web Answer call because those operations were not directly traced.

The model-token calculation uses the actual reported input/output tokens, not `maxTokens`. Long source passages and repeated writer/reviewer turns drive much of the token cost. Structured output is not a separate priced service in this estimate; its corrections can still trigger additional model calls.

The two fairness probes are excluded. Unreported errors and SDK-internal retries can still leave billing gaps. The older and newer subtotals also have different accounting scopes and question topics, so they are **not an apples-to-apples provider comparison**. Selecting Nova for the current workflow does not automatically recover the older workflow's cost.

With default model settings, `--model-profile=nova` selects Nova for all generator roles, including factual review. Explicit shared and per-role model settings can override that selection. The profile changes models, not Web Answer, quality checks, or the live student grader.

### What this means for all 302 services

Using the current trial's unrounded average, rather than a theoretical maximum, gives:

| Questions per service | New questions | Baseline estimate | Illustrative budget reserve |
| --- | ---: | ---: | ---: |
| 1 | 302 | $127.68 | $200-$300 |
| 2 | 604 | $255.37 | $400-$600 |

These are sample extrapolations, not measured full-bank costs. The reserves apply 1.5-2 times the baseline, rounded up to $100 increments; they are planning allowances, not guaranteed billing caps or implemented spending controls.

Harder services, additional retries, and second-question diversity can increase costs. Fewer retries can lower them. Taxes, discounts, unmeasured database/storage/log charges, and unrelated student-runtime costs are excluded. Successful generation for every service is not guaranteed, and this estimate did not trigger an all-service generation or database replacement.

The cost lesson is not "more agents are always better." It is **measure the complete workflow, distinguish failed work from successful output, and require each extra check to earn its cost by catching meaningful defects**.

For per-model rates, aggregation rules, and measurement inputs, see [the generator costing documentation](../QUESTION_GENERATOR_AGENT.md#costing-from-traces-not-token-limits). Public pricing sources are [Amazon Bedrock](https://aws.amazon.com/bedrock/pricing/) and [AgentCore](https://aws.amazon.com/bedrock/agentcore/pricing/).

---

## 11. Draft-Only Operation Is Part of the Design

The current CLI produces private drafts and does not publish generated questions.

An unpublished trial can be run with the approved Gateway URL and appropriately scoped caller permissions:

```bash
AWS_REGION=us-east-1 env -u VOICE_TABLE \
node src/VoicePractice/question-bank.mjs generate \
  /tmp/aws-warrior-drafts.json s3,iam,ec2,rds,cloudfront \
  --count=1 --no-publish --continue-on-error \
  --model-profile=chinese --evidence-source=web-answer \
  --web-answer-url="$QUESTION_WEB_ANSWER_URL" \
  --trace-json=/tmp/aws-warrior-draft-traces.json
```

This is a paid, bounded trial, not a publication command. Use private output locations and keep rubrics and traces out of public website assets.

The deployment and trial in this article did not change student scores, rewards, or the live Nova grader. No generated question was approved for publication.

At the time of this draft, **55 targeted tests passed**. They cover contracts, source provenance, translation regressions, independent-review behavior, and alternative calibration. Passing tests establishes those behaviors, not the truth of every future model-generated question.

For implementation details, see:

- [Current generator architecture](../QUESTION_GENERATOR_AGENT.md)
- [Strands graph and structured-output contracts](../../src/VoiceAgent/question-generator.mjs)
- [Source binding, translation checks, and factual-review validation](../../src/VoiceAgent/question-quality.mjs)
- [Per-role model configuration](../../src/VoiceAgent/question-generator-config.mjs)
- [Web Answer adapter](../../src/VoiceAgent/web-answer.mjs)
- [Generator regression tests](../../tests/voice-practice/question-generator.test.mjs)

---

## 12. Conclusion: Better Contracts, Better Evidence, Still Human Review

The recent enhancements move the generator through three distinct layers:

**Structured output** makes agent results safer for software to consume.

**Source provenance and isolated review** make factual support inspectable and can reject unsupported candidates before grading.

**Alternative calibration and language checks** help expose unfair rubrics and translation errors.

None of these layers replaces the others. A valid schema is not a true answer. A real quotation is not proof of entailment. A high synthetic score is not evidence that every valid student answer will be treated fairly.

The practical outcome is partial but useful improvement: clearer contracts, better diagnostic evidence, corrected RDS defaults, and a fairer CloudFront example.

The remaining work is equally clear: more reliable misconception reasoning, better handling of valid alternatives and conditional facts, and stronger Cantonese review. These are follow-up needs, not capabilities already proven by the current implementation.

**The generator is a draft-authoring and triage system, not an automatic examiner or publisher.** The five-question trial made that boundary more important, not less.
