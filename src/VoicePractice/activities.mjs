import { readFileSync } from "node:fs";

const lessons = JSON.parse(readFileSync(new URL("./lessons.json", import.meta.url), "utf8"));
const roundTwo = {
  s3: {
    "en-US": "I save a game's screenshots in an Amazon S3 bucket. Each screenshot is an object with its own key. I keep the bucket private and use a presigned URL when a friend needs temporary access to one picture.",
    "zh-HK": "我將遊戲截圖放喺 Amazon S3 bucket。每張截圖都係一個物件，有自己嘅 key。我會保持 bucket 私隱，如果朋友需要暫時睇一張相，就用 presigned URL 分享。",
  },
  ec2: {
    "en-US": "I run my game server on an Amazon EC2 virtual server. I choose Linux, install the game software, and keep the operating system updated. A security group allows the game's network traffic and blocks access that I have not allowed.",
    "zh-HK": "我用 Amazon EC2 虛擬伺服器運行遊戲。我會揀 Linux，安裝遊戲軟件，同埋更新作業系統。Security group 只容許遊戲需要嘅網絡流量，冇批准嘅連線就唔可以入嚟。",
  },
  iam: {
    "en-US": "My game needs to read pictures from one S3 bucket. With AWS IAM, I give its role only the permissions needed for that bucket. The role supplies temporary credentials instead of permanent access keys in my game code.",
    "zh-HK": "我嘅遊戲需要讀取一個 S3 bucket 入面嘅圖片。我用 AWS IAM，只畀遊戲嘅 role 存取嗰個 bucket 所需嘅權限。Role 提供臨時憑證，唔使喺遊戲程式放永久 access key。",
  },
  vpc: {
    "en-US": "I organize my game's resources in an Amazon VPC, a logically isolated network. Separate subnets hold my web servers and databases. Route tables direct traffic, and security groups and network ACLs filter which traffic is allowed.",
    "zh-HK": "我用 Amazon VPC 呢個邏輯上隔離嘅網絡安排遊戲資源。網頁伺服器同資料庫放喺唔同 subnet。Route table 決定流量去邊，而 security group 同 network ACL 會過濾獲准通過嘅流量。",
  },
  lambda: {
    "en-US": "When a player uploads a picture, an event starts an AWS Lambda function. AWS manages the servers that run my code. The function uses an execution role to access the picture, and saves lasting results in external storage.",
    "zh-HK": "當玩家上載圖片，事件就會啟動 AWS Lambda function。AWS 管理執行程式嘅伺服器。Function 用 execution role 存取圖片，再將需要長期保存嘅結果放喺外部儲存服務。",
  },
  dynamodb: {
    "en-US": "I store player profiles as items in an Amazon DynamoDB table. DynamoDB is a managed NoSQL database. I choose a player identifier as the partition key and design my keys and indexes around the reads and writes my game needs.",
    "zh-HK": "我將玩家資料當作 item，放喺 Amazon DynamoDB table。DynamoDB 係託管嘅 NoSQL 資料庫。我用玩家編號做 partition key，再按遊戲需要嘅讀寫方式設計 key 同 index。",
  },
};

// Activity identifiers are immutable: future passage edits require a new version.
export const activities = [1, 2].flatMap(round => Object.entries(lessons).map(([serviceId, lesson]) => ({
  activityId: `${serviceId}-reading-r${round}-v1`,
  version: "1", serviceId, label: lesson.label, round,
  readingTexts: round === 1 ? lesson.readingTexts : roundTwo[serviceId],
})));

export function validateGrade(value) {
  const { score, feedback, breakdown } = value ?? {};
  if (!Number.isInteger(score) || score < 0 || score > 100 ||
      !Number.isInteger(breakdown?.coverage) || breakdown.coverage < 0 || breakdown.coverage > 70 ||
      !Number.isInteger(breakdown?.content) || breakdown.content < 0 || breakdown.content > 30 ||
      breakdown.coverage + breakdown.content !== score ||
      typeof feedback !== "string" || !feedback.trim() || feedback.length > 1600) {
    throw new Error("Invalid reading grade");
  }
  return { score, passed: score >= 60, feedback: feedback.trim(),
    breakdown: { coverage: breakdown.coverage, content: breakdown.content } };
}

export const rewardFor = score => score >= 90 ? 15 : score >= 75 ? 10 : score >= 60 ? 5 : 0;
