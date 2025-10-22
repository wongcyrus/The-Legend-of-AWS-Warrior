const child_process = require("node:child_process");
const path = require("node:path");
const fs = require("fs");

// Load configuration from .env file
const loadEnv = () => {
  const envPath = path.resolve(__dirname, "../../.env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    const config = {};
    envContent.split("\n").forEach((line) => {
      if (line && !line.startsWith("#")) {
        const [key, value] = line.split("=");
        if (key && value) {
          config[key.trim()] = value.trim();
        }
      }
    });
    return config;
  }
  return { STACK_NAME: "CloudProjectMarker", AWS_REGION: "us-east-1" };
};

const config = loadEnv();
const STACK_NAME = config.STACK_NAME || "CloudProjectMarker";
const AWS_REGION = config.AWS_REGION || "us-east-1";

const getCloudFormationOuputValue = (key) => {
  const command = `
    aws cloudformation describe-stacks \
        --stack-name ${STACK_NAME} \
        --region ${AWS_REGION} \
        --no-paginate \
        --no-cli-pager \
        --output text \
        --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue"
    `;
  return child_process.execSync(command);
};

const uploadFiles = () => {
  const sourceDir = path.resolve(path.join(__dirname, "../build"));
  const s3BucketName = getCloudFormationOuputValue("WebAppS3BucketName");

  console.log(`Uploading files from ${sourceDir} to s3://${s3BucketName}`);
  child_process.execSync(
    `aws s3 sync --region ${AWS_REGION} ${sourceDir} s3://${s3BucketName}`,
    { stdio: "inherit" }
  );

  const gameSourceDir = path.resolve(path.join(__dirname, "../../web-game/"));
  child_process.execSync(
    `aws s3 sync --region ${AWS_REGION} ${gameSourceDir} s3://${s3BucketName}`,
    { stdio: "inherit" }
  );
};

const clearCloudFrontCache = () => {
  const distributionId = getCloudFormationOuputValue(
    "CloudFrontDistributionId"
  );
  console.log(`Clearing CloudFront cache for distribution ${distributionId}`);

  const command = `
    aws cloudfront create-invalidation \
        --region ${AWS_REGION} \
        --no-paginate \
        --no-cli-pager \
        --paths "/*" \
        --distribution-id ${distributionId}
    `;
  child_process.execSync(command, { stdio: "inherit" });
};

uploadFiles();
clearCloudFrontCache();

const domain = getCloudFormationOuputValue("WebAppDomain");
console.log(`Deployment done, visit https://${domain}`);
