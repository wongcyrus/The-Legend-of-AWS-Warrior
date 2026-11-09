## The Legend of AWS Warrior V2 - 4-Part Technical Blog Series

**By Cyrus Wong**
*AWS AI Hero | AWS AI User Group Hong Kong Leader | Programme Leader of Higher Diploma in Cloud and Data Centre Administration (IT114115), Hong Kong Institute of Information Technology (HKIIT)*

---

## Series Overview

Welcome to the 4-part technical deep dive into **The Legend of AWS Warrior V2**—an open-source 3D Action RPG and Generative AI oral cloud architecture training platform built with **Three.js (`r118`)**, **AWS SAM (`template.yaml`)**, **Amazon Bedrock AgentCore Runtime**, **Amazon Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`)**, **`@strands-agents/harness`**, and **`@strands-agents/sdk`**. Part 4 is a draft follow-up covering structured output, source-backed review, and the limitations exposed by live question-generation trials.

### 1. [Part 1 - The Game: Gamifying Cloud Architecture, Oral Interview Prep and 19 Anime x AWS Cloud Arts in a 3D Action RPG](https://github.com/wongcyrus/The-Legend-of-AWS-Warrior/blob/main/docs/blog/PART1_THE_GAME.md)

- **Description (for Search Results & Feeds)**: Discover how we defeated the "Copy-to-AI, Paste-Back" reflex in university cloud classes by turning spoken English, Cantonese, and Mandarin AWS architectural explanations into the Magic Power (MP) economy of a 4-region Three.js 3D Action RPG. Equipped with ephemeral mobile QR-code wireless microphone handoff for lab PCs and 19 anime-inspired AWS Cloud Arts, students practice real-world oral interview skills to unlock cataclysmic multi-region spells.
- **Cover Image**: `docs/images/aws_warrior_v2_blog_part1_cover.png` (`1.64 MiB`, `< 2 MB`)
- **Defeating the "Copy-to-AI, Paste-Back" Reflex**: Why students copy questions to AI and paste back answers without ever reading them—and how requiring a **spoken answer** (with typing and pasting disabled) ensures students **read and vocalize the answer at least once**, while **fun gameplay** motivates voluntary practice.
- Exploring **302 discoverable AWS service plaques** across 4 open-world realms (*Cloudlands Village*, *Frostpeak Highlands*, *Sunspire Desert*, and *The Forgotten Vault*), dynamic **AZ Outage Alerts**, and **Timed Perfect Parry** + **Close-Range 360-Degree and Standoff Melee Combat**.
- Solving the "university lab PC has no microphone" bottleneck with **Ephemeral Mobile QR-Code Wireless Microphone Handoff** in English (`en-US`), Hong Kong Cantonese (`zh-HK`), and Simplified Chinese Mandarin (`zh-CN`).
- Charging the 100 MP wallet to unleash **19 Anime x AWS Cloud Arts** and the 50/50 5-Art Cataclysmic Ultimates (**Global Deployment / 全域部署** and **Hyperscale Rumbling / 地鳴・超大規模踏境**).

### 2. [Part 2 - The AWS Design: Zero-Trust Serverless Referee, Amazon Bedrock AgentCore Runtime and Single-Table DynamoDB Architecture](https://github.com/wongcyrus/The-Legend-of-AWS-Warrior/blob/main/docs/blog/PART2_AWS_DESIGN.md)

- **Description (for Search Results & Feeds)**: Learn how to prevent LLM hallucinated grading, score drift, and adversarial prompt injection in educational games by placing a deterministic Zero-Trust Referee Lambda in front of an IAM-isolated Amazon Bedrock AgentCore Runtime powered by `@strands-agents/harness` and Amazon Nova 2 Lite. We walk through Two-Phase `NFKC` verbatim substring evidence verification, asynchronous Amazon Transcribe pipelines, and atomic single-table DynamoDB transactions.
- **Cover Image**: `docs/images/aws_warrior_v2_blog_part2_cover.png` (`1.65 MiB`, `< 2 MB`)
- Why our architecture places a **Trusted Referee Lambda (`VoicePracticeFunction`)** between API Gateway and an IAM-isolated **Untrusted AI Sandbox (`AWS::BedrockAgentCore::Runtime`)** with zero DynamoDB permissions.
- Bypassing API Gateway's 29-second timeout with asynchronous self-invoking Lambda workers, dual authentication bridging (`x-api-key` + SHA-256 mobile capability tokens to IAM SigV4), and speech input quality gates.
- Inside the single-turn Strands Harness grader (`createHarness` + `BedrockModel`, `temperature: 0`, `limits: { turns: 1 }`), **Operation-Dispatched Multi-Persona Grading (`grade_reading` vs. `grade_answer`)**, **Two-Phase `NFKC` Substring Evidence Verification**, and the **Two-Layer Anti-Voice-Claim Guardrail**.
- Single-table DynamoDB schema (`VoicePracticeTable`), atomic `TransactWrite` MP wallet and cast receipts, **Per-Student Sticky Shuffle + Post-Cooldown LRU Rotation**, and Dual-Stack CloudFormation/SAM DevOps (`Game Mode` vs. `Exam Mode`).

### 3. [Part 3 - Gen Question: Autonomous AWS Question Bank Generation with Loop Engineering, Strands Multi-Agent Graphs, Harness Plugins and Live OpenTelemetry Tracing](https://github.com/wongcyrus/The-Legend-of-AWS-Warrior/blob/main/docs/blog/PART3_GEN_QUESTION.md)

- **Implementation Context**: Part 3 records the earlier JSON/`GoalLoop` design. Part 4 explains the current structured-output and draft-only quality workflow; synthetic calibration alone does not prove factual correctness.
- **Description (for Search Results & Feeds)**: Explore how Dual-Level Loop Engineering with `@strands-agents/harness` (`GoalLoop`, `ContextOffloader`) and cyclic `@strands-agents/sdk` multi-agent graphs autonomously mines, fact-checks, localizes, and calibrates trilingual AWS interview questions across 302 services. Grounded by Amazon Nova Web Grounding and the live AWS Knowledge MCP Server, every candidate rubric is verified against a 3-way live grader with full OpenTelemetry trace visibility in Jaeger.
- **Cover Image**: `docs/images/aws_warrior_v2_blog_part3_cover.png` (`1.35 MiB`, `< 2 MB`)

- **Loop Engineering vs. Prompt Engineering vs. Context Engineering**: The 5 pillars of building closed-loop, self-verifying agent systems.
- **Dual-Level Loop Architecture**:
  - **Level 1 (Inner Agent Loop)**: `@strands-agents/harness` (`createHarness`) + `GoalLoop` (intra-node JSON self-correction) + `ContextOffloader` (`InMemoryStorage`) + hard inner turn caps (`maxTurnsPerNode = 4`).
  - **Level 2 (Outer Graph Loop)**: The 4-Agent Strands `Graph` (`interview_miner` with Amazon Nova Web Grounding `nova_grounding` -> `aws_docs_fact_checker` with live AWS Knowledge MCP `https://knowledge-mcp.global.api.aws` -> `trilingual_localizer` -> `calibration_critic`) and **Stage-Classified Conditional Feedback Routing** (`localization`, `rubric`, `topic`).
- **5 Deterministic Verification Gates and 3-Way Synthetic Student Calibration** (`goodEn >= 80`, `goodZhHk >= 80`, `wrongOutdated < 60`) + stopword-filtered Jaccard semantic anti-duplication.
- **Native Strands OpenTelemetry (`@strands-agents/sdk/telemetry`) and Live UI Tracing in Jaeger (`http://localhost:16686`)**: Complete 41-span trace walkthrough of generating and calibrating a live Amazon S3 question (`s3-lifecycle-optimization`).

### 4. [Part 4 - Question Quality: From Valid JSON to Better Drafts with Strands Structured Output and Source-Backed Review](PART4_STRUCTURED_OUTPUT_AND_QUALITY.md)

- **Status**: Draft for review, based on implementation and trial observations from 8 November 2026.
- **Description (for Search Results & Feeds)**: Follow the question generator's transition from JSON text parsing to Strands structured output, configurable model roles, official AWS source passages, isolated factual review, technical translation checks, and valid-alternative calibration. The five-question trial shows concrete improvements alongside false rejections, unfair optional-feature grading, and remaining source-support and Cantonese problems.
- **Architecture Diagram**: `docs/images/aws_warrior_v2_part4_question_quality_pipeline_diagram.png` (`1.4 MiB`, `< 2 MB`)
- **Structured Output Is Not Factual Correctness**: Separate typed agent contracts and server-owned metadata from evidence provenance, semantic review, and grading fairness.
- **Two Research Roles**: Nova grounding discovers interview topics; Web Answer finds official AWS evidence, followed by bounded source-page reads and server-owned excerpts.
- **Honest Trial Results**: Three services completed initially; IAM needed a retry and RDS a narrower question. CloudFront improved, while a valid S3 answer still lost 25 points for omitting optional MFA Delete.
- **Trace-Based Costing in USD**: Distinguish the older Nova trial's incomplete $0.36 recorded subtotal from the latest $2.11 five-question estimate, explain the 44.2-call average including retries, and scope the $255.37 projection for 604 questions.
- **Draft-Only Workflow**: Keep private rubrics and traces separate from student runtime data, and require human factual and language review before approval.
