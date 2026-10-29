# The Legend of AWS Warrior V2 — Player Guide

Welcome to **The Legend of AWS Warrior V2**, an interactive 3D RPG adventure where you master AWS Cloud architecture, battle across four realms of the Cloudlands, practice AWS terminology in English, Cantonese, and Mandarin, and unleash AWS-themed Cloud Arts.

---

## 1. Quick Start & Core Quest Loop

1. **Explore or Connect Your API Key**:
   - You can freely explore all four maps, fight monsters, test weapons/shields, and read AWS service plaques without an API key.
   - To receive graded AWS missions, earn MP from Voice Practice, and save checkpoints to the cloud, click **Set Key** in the top navigation bar and enter your student API key.
2. **Receive an AWS Mission (`E`)**:
   - Approach any NPC Guide marked with a floating golden octahedron and ground ring (also shown as golden dots on your minimap) and press **`E`** (or click **`E Get task`** on the bottom control bar).
   - Read the generated task instructions in the scrollable **AWS Task Instructions** window. You can reopen the instructions at any time from the **Mission details** button on the right-hand quest card.
3. **Build in AWS & Defeat a Monster to Grade**:
   - Complete the required infrastructure configuration in your AWS Academy Learner Lab account.
   - Return to the game and **defeat any monster** (using melee weapons or Cloud Arts) to trigger automated NUnit grading in AWS Lambda.
   - **Passed validation**: Repairs one of the six buildings in Cloudhaven Village, saves your marks, and unlocks cosmetic weapon finishes.
   - **Failed validation**: Check the test log link on the quest card, adjust your AWS resources, and defeat another monster to retry.

---

## 2. Controls & Tactical HUD

You can use keyboard/mouse shortcuts or click the interactive action chips in the bottom control bar:

| Input / Shortcut | Action | Notes |
|---|---|---|
| **`W` `A` `S` `D`** | Move & Turn | Standard character movement relative to facing |
| **`Shift`** | Run | Hold while moving to sprint |
| **`Space`** *(or click `Space Attack`)* | Melee Attack | Swings your equipped weapon (or punches if Unarmed) |
| **`1` / `2` / `0`** | Quick Weapon Select | Equips **Sword** (`1`), **Axe** (`2`), or **Unarmed** (`0`) |
| **`C` / `Shift + C`** *(or `Shift + Scroll`)* | Cycle Weapons | Cycles forward/backward through all 15 melee styles |
| **`V` / `Shift + V`** | Cycle Shields | Cycles forward/backward through all 5 shields + No shield |
| **`R`** *(Hold)* | Block & **Perfect Parry** | Hold to block frontal attacks (within 60°). Press within **0.25s** before impact for a **Timed Perfect Parry** |
| **`Q`** *(or click `Q Dodge`)* | Dodge Roll | Dash backward (or toward held movement key) with brief invulnerability |
| **`3` `4` `5` `6` `7`** | Toggle Cloud Arts | Toggles selection of the 5 Cloud Arts in your HUD |
| **`X`** *(or click `Cast` / `X Magic`)* | Cast Cloud Arts | Unleashes all currently selected Cloud Arts |
| **`E`** *(or click `E Get task`)* | Talk to Guide / View Task | Requests a quest near a golden guide marker, or reopens active instructions |
| **`F`** *(or click `F Open chest`)* | Open Hidden Cache | Opens a nearby glowing treasure chest in Cloudlands Village |
| **Walk into Gate** *(or press `T`)* | Region Travel | Teleports between Cloudlands Village and the three outer realms |
| **`Mouse Scroll`** | Camera Zoom | Smoothly zooms the 3D camera in or out |

---

## 3. Weapons, Shields & Timed Perfect Parry

### 15 Melee Weapon Styles
Switch weapons anytime outside of an active swing/dodge by clicking the icon bar, scrolling with `Shift + Scroll`, or pressing `C`.
- **Fast Blades (`Dagger`, `Sword`, `Sword_Golden`, `Cutlass`, `Scimitar`)**: High animation speed (`1.1x–1.35x`) for quick hit-and-dodge skirmishes.
- **Balanced & Cleaving (`Axe`, `Axe_Small`, `Mace`, `Cleaver`, `Bone`)**: Solid damage multipliers with medium swing speed.
- **Heavy & Long-Reach (`Spear`, `Claymore`, `Axe_Double`, `Hammer_Double`, `Scythe`)**: Extended reach (`6.0–7.2` units) and up to `1.55x` Power damage.

### 5 Shields & Timed Perfect Parry
You begin with a **Round Shield** equipped (`Shield_Round`, `Shield_Round_2`, `Shield_Square`, `Shield_Spikes`, `Shield_Celtic_Golden`).
- **Standard Guard (`Hold R`)**: Blocks 100% of ordinary frontal melee hits and cactus spikes within 60° of your facing direction. Heavy boss/elite attacks deal 50% damage and break your guard for `1.5s`.
- **Timed Perfect Parry (`Press R within 0.25s of impact`)**:
  - **Zero Damage & No Guard Break**: Completely negates even heavy boss blows without breaking your shield.
  - **Projectile Reflection**: Parrying a ranged Cactus or Sunspire Overlord spike reflects the damage back at the attacker for **2× damage**.
  - **Melee Stagger**: Parrying a melee attacker staggers and slows them for `2.5s`, causing them to take **+25% bonus damage** from your counterattacks.

---

## 4. Cloud Arts, Elemental Synergies & Global Deployment

Earn **MP** (up to 100 MP) by passing graded **Voice Practice** activities on AWS service discovery signs. Select one or more Cloud Arts using keys **`3`–`7`** or clicking their buttons, then press **`X`** to cast.

| Key | Cloud Art | AWS Theme | Cost / Cooldown | Effect |
|---:|---|---|---|---|
| **`3`** | **瞬式・事件雷切** (`Event-Driven λ`) | AWS Lambda | `12 MP` / `12s` | Chains lightning up to 120 units across 3 targets (`100%`, `50%`, `25%` damage). |
| **`4`** | **影分身・彈性軍勢** (`Auto Scaling Army`) | EC2 Auto Scaling | `15 MP` / `20s` | Summons 5 animated shadow clones that advance and strike 3 times each. |
| **`5`** | **領域展開・無量儲存** (`Domain: Infinite Storage`) | Amazon S3 | `20 MP` / `45s` | Creates a 16-unit domain for 6s dealing 6 damage pulses + final burst and slowing enemies. |
| **`6`** | **結界術・私有雲界** (`Private Cloud Barrier`) | Amazon VPC | `15 MP` / `25s` | Forms a 12-unit ward for 8s that halves incoming damage and knocks back intruders. |
| **`7`** | **終式・跨區復甦** (`Cross-Region Recovery`) | Disaster Recovery | `25 MP` / `60s` | Places a 12s recovery anchor (after a 1s windup) that intercepts one lethal/low-HP hit and restores you to 35% HP at the anchor. |

### Anime × AWS Awakening Combo Arts
Combining **2, 3, or 4 Cloud Arts** in a single cast awakens one of **six Anime × AWS Combo Arts** alongside your selected spells. Each Awakening Combo displays a **2-line English + Chinese banner** at top-center, announces **only the Awakening Combo Art name** in a male Cantonese voice (without repeating the individual combination elements), and unleashes a multi-stage 3D anime visual effect:

| Combo Keys | English / Chinese Banner | Base MP / Shared Cooldown | AWS Service Theme | Anime Reference & Combat Effect |
|---|---|---|---|---|
| **`3 + 4`** *(or `4 + 5`)* | **`Fargate Blade Barrage`**<br>**千刃・容器萬解** | `27 MP` / `20s` *(or `35 MP` / `45s`)* | AWS Fargate & Amazon ECS | *Bleach (Senbonzakura) / Fate (Gate of Babylon)* — Opens 5 golden container portals behind the Warrior and fires **18 glowing blades** up to **75 units** ahead across 3 staggered volleys (`2.2×` Power per volley). |
| **`3 + 5`** | **`Dynamo Singularity`**<br>**赫式・毫秒爆裂** | `32 MP` / `45s` | Amazon DynamoDB | *Jujutsu Kaisen (Hollow Purple `虛式「茈」`)* — Spirals *Blue (`蒼`)* and *Red (`赫`)* orbs into a *Hollow Purple (`茈`)* singularity **20 units** ahead, pulling enemies within **26 units** inward twice before detonating for **`5.5×` Power** damage (plus **Cold-Start Surge** lightning across the Storage domain). |
| **`4 + 6`** *(or `3 + 6`)* | **`ALB Almighty Push`**<br>**神羅・負載天徵** | `30 MP` / `25s` *(or `27 MP` / `25s`)* | Elastic Load Balancing (ALB) | *Naruto (Shinra Tensei `神羅天徵`)* — The Warrior flies up into the sky (`y = 18`) while a **360° gravity sphere** and 16 radial shock-spikes expand outward directly from his body across **32 units**, dealing **`3.0×` Power** damage per wave and hurling enemies backward (`6` units) while summoning **VPC Peered Fleet** shadow clones. |
| **`5 + 6`** *(or `6 + 7`)* | **`CloudWatch Omniscience`**<br>**天照・全知之眼** | `35 MP` / `45s` *(or `40 MP` / `60s`)* | Amazon CloudWatch & AWS X-Ray | *Naruto (Sharingan & Amaterasu `天照`)* — Darkens the field into an obsidian void and erupts **24 roaring pitch-black Amaterasu flame pillars** (`0x050208`) with a floating Mangekyō eye and sweeping X-Ray beam that pulse **6 times over 7s** (`1.8×` Power + `1.5s` slow). |
| **`3 + 7`** *(or `4 + 7`)* | **`CloudFront Edge Flash`**<br>**炎呼吸・邊緣瞬閃** | `37 MP` / `60s` *(or `40 MP` / `60s`)* | Amazon CloudFront | *Demon Slayer (Thunderclap and Flash × Rengoku)* — Unleashes **twin spiraling flame-and-thunder dragon helices** and 8 sequential Edge-PoP fire pillars along a **65-unit** corridor for **3 rapid slashes** (`3.2×` Power each). |
| **`5 + 7`** | **`Bedrock Titan Meteor`**<br>**天礙震星・基岩星隕** | `45 MP` / `60s` | Amazon Bedrock | *Naruto (Tengai Shinsei `天礙震星`)* — Tears open a sky portal and drops **twin colossal craggy rock boulders** straight down from the sky **22 units** ahead after `1.2s`, dealing **`9.0×` Power** AoE damage across a **26-unit** radius and raising tectonic spires. |

### Ultimate: 全域部署 / Global Deployment
Select **all 5 Cloud Arts (`3`–`7`)** to transform the cast button into **全域部署 (`87 MP`, `60s` cooldown)**:
- Summons **four giant Cloud Avatars** (6× player size) facing outward in cardinal directions.
- Releases three expanding execution waves across a **128-unit radius** that defeat ordinary monsters and bosses on contact (blocked only by solid walls and buildings).

---

## 5. World Regions, Guides, Dynamic Events & Bestiary

### Four Regions & NPC Guides
Each region features its own distinct **NPC Guide character**, environmental modifiers, and AWS service discoveries (302 total across the world):

| Region | NPC Guide Character | Environmental Modifier | Boss / Super Monster |
|---|---|---|---|
| **Cloudlands Village** | **Village Keeper** (`peasant_girl.fbx`), **Forest Watcher** (`KnightCharacter.glb`), **Lake Guardian** (`castle_guard_01.fbx`), **Ruins Scholar** (`RobotExpressive.glb`) | Safe central village hub + 3 hidden cosmetic caches | **Crystal Warden** *(northeast of Crystal Ruins)* |
| **Frostpeak Highlands** *(Northwest Gate)* | **Mountain Ranger** *(Highland Knight — `KnightCharacter.glb`)* | **Highland Tailwind**: `+12%` movement speed in the northern highlands (`z < 0`) | **Frostpeak Titan** *(Glacial Shockwave + 2.5s Frost Slow)* |
| **Sunspire Desert** *(Northeast Gate)* | **Desert Wayfinder** *(Sunspire Guardian — `castle_guard_01.fbx`)* | **Sunspire Oasis**: `+2 HP/s` regeneration near the central oasis (`(45, -35)`) | **Sunspire Overlord** *(3-Way Fan Spike Volley)* |
| **Forgotten Vault** *(South Gate)* | **Vault Scholar** *(Vault Construct — `RobotExpressive.glb`)* | **Compute Overclock**: `+15%` melee attack speed in the central chamber | **Vault Nightlord** *(Shadow Step teleport ambush)* |

### Dynamic World Events: AZ Outage Alerts
Every `75 seconds`, an **Availability Zone Outage Alert** can trigger on your current map, highlighted by a pulsing amber ring on your **minimap** and a status prompt in your HUD:
- Defeat **2 monsters** near the outage zone within **45 seconds** to restore the Availability Zone.
- Restoring an AZ immediately heals **`+20 HP`** and grants a **High Availability Surge** (`+20%` movement speed and `+20%` attack speed for `20 seconds`).

### 16-Monster Bestiary
Across the four maps, you will battle **16 animated creature species** from the Quaternius CC0 collection:
- **Cloudlands Village & Outskirts**: `Ghost`, `Green demon`, `Cyclops`, `Skull`, `Whispering treant` (`Tree`), `Mirrorwater crab` (`Crab`), `Cloud hornet` (`Bee`), `Crimson demon` (`Demon`), `Bamboo guardian` (`Panda`), `Highland stag` (`Deer`), `Sunspire wyvern` (`YellowDragon`), `Void stalker` (`Alien`), and `Vault sentinel` (`Alien_Tall`).
- **Frostpeak Highlands**: `Frostpeak yeti` (`Yeti`), `Highland stag` (`Deer`), `Bamboo guardian` (`Panda`), `Sunspire wyvern` (`YellowDragon`), `Whispering treant` (`Tree`), `Cyclops`, and `Ghost`.
- **Sunspire Desert**: `Sunspire cactus` (`Cactus` — ranged spikes), `Sunspire wyvern` (`YellowDragon`), `Cloud hornet` (`Bee`), `Mirrorwater crab` (`Crab`), `Crimson demon` (`Demon`), `Green demon`, and `Skull`.
- **Forgotten Vault**: `Vault bat` (`Bat`), `Void stalker` (`Alien`), `Vault sentinel` (`Alien_Tall`), `Crimson demon` (`Demon`), `Ghost`, `Skull`, and `Green demon`.

---

## 6. Voice Practice & Earning MP

1. Click any **AWS Service Sign**, **Building Plaque**, or **Mission Service Badge** to open the **Service Reader**.
2. Click **Voice practice** to choose between:
   - **Read Aloud (`5 / 10 / 15 MP`)**: Available across all 302 AWS service discoveries in **English (`en-US`)**, **Cantonese (`zh-HK`)**, and **Mandarin (`zh-CN`)**.
   - **Answer a Question (`10 / 20 / 30 MP`)**: Available on services with approved Q&A questions.
3. Speak using your computer's microphone or click **Use phone microphone (QR)** to pair your phone. Passing with a score of `60+` awards MP directly to your server-backed wallet and marks the service discovery as **Read**.
