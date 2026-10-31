# The Legend of AWS Warrior V2 — 3-Part Technical Blog Series

**By Cyrus Wong**  
*AWS Community Hero | Programme Leader of Higher Diploma in Cloud and Data Centre Administration (IT114115), Hong Kong Institute of Information Technology (HKIIT)*

---

## Series Overview

Welcome to the 3-part technical deep dive into **The Legend of AWS Warrior V2**—an open-source 3D Action RPG and Generative AI oral cloud architecture training platform built with **Three.js (`r118`)**, **AWS SAM (`template.yaml`)**, **Amazon Bedrock AgentCore Runtime**, **Amazon Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`)**, **`@strands-agents/harness`**, and **`@strands-agents/sdk`**.

### 1. [Part 1 — The Game: Gamifying Cloud Architecture, Oral Interview Prep & 19 Anime × AWS Cloud Arts in a 3D Action RPG](BLOG_POST_V2_PART1.md)
- **Defeating the "Copy-to-AI, Paste-Back" Reflex**: Why students copy questions to AI and paste back answers without ever reading them—and how requiring a **spoken answer** (with typing and pasting disabled) ensures students **read and vocalize the answer at least once**, while **fun gameplay** motivates voluntary practice.
- Exploring **302 discoverable AWS service plaques** across 4 open-world realms (*Cloudlands Village*, *Frostpeak Highlands*, *Sunspire Desert*, and *The Forgotten Vault*), dynamic **AZ Outage Alerts**, and **Timed Perfect Parry** + **Close-Range 360° & Standoff Melee Combat**.
- Solving the "university lab PC has no microphone" bottleneck with **Ephemeral Mobile QR-Code Wireless Microphone Handoff** in English (`en-US`), Hong Kong Cantonese (`zh-HK`), and Simplified Chinese Mandarin (`zh-CN`).
- Charging the 100 MP wallet to unleash **19 Anime × AWS Cloud Arts** and the 50/50 5-Art Cataclysmic Ultimates (**Global Deployment / 全域部署** and **Hyperscale Rumbling / 地鳴・超大規模踏境**).

### 2. [Part 2 — The AWS Design: Zero-Trust Serverless Referee, Amazon Bedrock AgentCore Runtime & Single-Table DynamoDB Architecture](BLOG_POST_V2_PART2.md)
- Why our architecture places a **Trusted Referee Lambda (`VoicePracticeFunction`)** between API Gateway and an IAM-isolated **Untrusted AI Sandbox (`AWS::BedrockAgentCore::Runtime`)** with zero DynamoDB permissions.
- Bypassing API Gateway's 29-second timeout with asynchronous self-invoking Lambda workers, dual authentication bridging (`x-api-key` + SHA-256 mobile capability tokens → IAM SigV4), and speech input quality gates.
- Inside the single-turn Strands Harness grader (`createHarness` + `BedrockModel`, `temperature: 0`, `limits: { turns: 1 }`), **Operation-Dispatched Multi-Persona Grading (`grade_reading` vs. `grade_answer`)**, **Two-Phase `NFKC` Substring Evidence Verification**, and the **Two-Layer Anti-Voice-Claim Guardrail**.
- Single-table DynamoDB schema (`VoicePracticeTable`), atomic `TransactWrite` MP wallet & cast receipts, **Per-Student Sticky Shuffle + Post-Cooldown LRU Rotation**, and Dual-Stack CloudFormation/SAM DevOps (`Game Mode` vs. `Exam Mode`).

### 3. [Part 3 — Gen Question: Autonomous AWS Question Bank Generation with Loop Engineering, Strands Multi-Agent Graphs, Harness Plugins & Live OpenTelemetry Tracing](BLOG_POST_V2_PART3.md)
- **Loop Engineering vs. Prompt Engineering vs. Context Engineering**: The 5 pillars of building closed-loop, self-verifying agent systems.
- **Dual-Level Loop Architecture**:
  - **Level 1 (Inner Agent Loop)**: `@strands-agents/harness` (`createHarness`) + `GoalLoop` (intra-node JSON self-correction) + `ContextOffloader` (`InMemoryStorage`) + hard inner turn caps (`maxTurnsPerNode = 4`).
  - **Level 2 (Outer Graph Loop)**: The 4-Agent Strands `Graph` (`interview_miner` with Amazon Nova Web Grounding `nova_grounding` → `aws_docs_fact_checker` with live AWS Knowledge MCP `https://knowledge-mcp.global.api.aws` → `trilingual_localizer` → `calibration_critic`) and **Stage-Classified Conditional Feedback Routing** (`localization`, `rubric`, `topic`).
- **5 Deterministic Verification Gates & 3-Way Synthetic Student Calibration** (`goodEn >= 80`, `goodZhHk >= 80`, `wrongOutdated < 60`) + stopword-filtered Jaccard semantic anti-duplication.
- **Native Strands OpenTelemetry (`@strands-agents/sdk/telemetry`) & Live UI Tracing in Jaeger (`http://localhost:16686`)**: Complete 41-span trace walkthrough of generating and calibrating a live Amazon S3 question (`s3-lifecycle-optimization`).
