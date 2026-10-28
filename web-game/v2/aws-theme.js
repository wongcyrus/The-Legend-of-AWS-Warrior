import { ADDITIONAL_SERVICES } from "./aws-discoveries.js?v=20261028-all-discoveries-1";
import { MAPS, isMapWalkable } from "./maps.js?v=20261027-maps-1";
import { CHESTS, BOSS, isWalkable, seededRandom } from "./layout.js";

export const AWS_SERVICES = {
  ...ADDITIONAL_SERVICES,
  s3: { label: "Amazon S3", category: "Object storage", icon: "./v2/assets/aws/s3.png",
    description: "Amazon Simple Storage Service (S3) stores files as objects in buckets. Each object has a key that identifies it; S3 is designed for durable object storage, not as a shared disk or relational database.",
    example: "A game can keep screenshots in a private bucket. The application checks who is signed in, then gives that player a short-lived download link instead of making the bucket public.",
    benefit: "S3 separates file storage from game servers. Bucket policies and other access controls help keep objects private; versioning and lifecycle rules can help protect files and manage how long and at what cost they are kept.",
    url: "https://aws.amazon.com/s3/" },
  ec2: { label: "Amazon EC2", category: "Cloud compute", icon: "./v2/assets/aws/ec2.png",
    description: "Amazon Elastic Compute Cloud (EC2) provides resizable virtual machines. You choose an instance type, operating system image, storage, and network settings, and remain responsible for the software running on the instance.",
    example: "A team could run a multiplayer game server on an EC2 instance. It selects CPU and memory for expected player load, patches the operating system, and permits only the network traffic the game needs.",
    benefit: "EC2 offers control over the server environment and many instance sizes. That flexibility also means teams must plan capacity, security updates, availability, and ongoing operations.",
    url: "https://aws.amazon.com/ec2/" },
  iam: { label: "AWS IAM", category: "Identity & access", icon: "./v2/assets/aws/iam.png",
    description: "AWS Identity and Access Management (IAM) lets an AWS account define identities and permissions for actions on resources. Policies describe what is allowed; roles provide temporary credentials to trusted users or services.",
    example: "Give a game server an IAM role that can read only the required bucket and objects. The server receives temporary role credentials rather than embedding a person's long-lived access keys.",
    benefit: "Least-privilege permissions limit the impact of mistakes or credential exposure. Review both who can assume a role and what its policies allow; roles provide temporary credentials instead of long-lived keys.",
    url: "https://aws.amazon.com/iam/" },
  vpc: { label: "Amazon VPC", category: "Cloud networking", icon: "./v2/assets/aws/vpc.png",
    description: "Amazon Virtual Private Cloud (VPC) gives AWS resources a logically isolated network. Subnets, route tables, gateways, and security controls determine how resources communicate with each other and the internet.",
    example: "Place a public-facing game service in a public subnet and a database in a private subnet. Allow database traffic from the application security group rather than opening the database to every internet address.",
    benefit: "A VPC makes network boundaries and traffic paths explicit. A private subnet alone is not a complete security plan: routes, security groups, network ACLs, and identity permissions all matter.",
    url: "https://aws.amazon.com/vpc/" },
  lambda: { label: "AWS Lambda", category: "Serverless compute", icon: "./v2/assets/aws/lambda.png",
    description: "AWS Lambda runs code in response to events without requiring you to manage the underlying servers. You provide a function and configure its trigger, permissions, runtime, and resource limits.",
    example: "When a screenshot is added to S3, an event can invoke a Lambda function to create a thumbnail. The function processes the event and writes the result to a separate location.",
    benefit: "Event-driven execution can suit intermittent work and scales without operating a server fleet. Its execution role controls access to other AWS resources. Design for retries and duplicate events, and monitor execution time and service limits.",
    url: "https://aws.amazon.com/lambda/" },
  dynamodb: { label: "Amazon DynamoDB", category: "NoSQL database", icon: "./v2/assets/aws/dynamodb.png",
    description: "Amazon DynamoDB is a managed NoSQL database for key-value and document data. Tables use primary keys, and the access patterns you need should guide the key design.",
    example: "Store a player's settings in an item keyed by player ID. The game can fetch that player's preferences directly by key; a separate index can support another planned query pattern.",
    benefit: "DynamoDB can serve predictable, high-volume access patterns without managing database servers. It is not a drop-in replacement for relational joins, so model data around the queries the application will make.",
    url: "https://aws.amazon.com/dynamodb/" },
  autoscaling: { label: "EC2 Auto Scaling", category: "Compute scaling", icon: "./v2/assets/aws/autoscaling.png",
    description: "Maintain a group of EC2 instances and adjust its capacity as demand changes.",
    example: "Add game servers when more players arrive, then reduce the group after the rush. Health checks can help replace unhealthy instances instead of leaving players on a broken server.",
    url: "https://aws.amazon.com/ec2/autoscaling/" },
  ecs: { label: "Amazon ECS", category: "Container orchestration", icon: "./v2/assets/aws/ecs.png",
    description: "Deploy and manage containerized applications using task definitions and services.",
    example: "Package a matchmaking service in a container. Run it as an ECS service so the desired number of copies stays available as containers stop or new versions are deployed.",
    url: "https://aws.amazon.com/ecs/" },
  eks: { label: "Amazon EKS", category: "Managed Kubernetes", icon: "./v2/assets/aws/eks.png",
    description: "Run Kubernetes applications with an AWS-managed Kubernetes control plane.",
    example: "Deploy game APIs as Kubernetes workloads. Use Kubernetes services and deployment rules to connect the components and roll out new versions without changing the container images.",
    url: "https://aws.amazon.com/eks/" },
  ecr: { label: "Amazon ECR", category: "Container registry", icon: "./v2/assets/aws/ecr.png",
    description: "Store and distribute container images used to deploy applications.",
    example: "Build a container image for the game API and push it to a private repository. Deployment systems can pull that version using a role with permission to read the repository.",
    url: "https://aws.amazon.com/ecr/" },
  batch: { label: "AWS Batch", category: "Batch compute", icon: "./v2/assets/aws/batch.png",
    description: "Schedule and run batches of computing jobs using managed job queues and compute environments.",
    example: "Queue an overnight job to process thousands of match replays. Batch schedules the work on available compute so the processing does not compete with live player requests.",
    url: "https://aws.amazon.com/batch/" },
  lightsail: { label: "Amazon Lightsail", category: "Application hosting", icon: "./v2/assets/aws/lightsail.png",
    description: "Build applications using bundled cloud resources such as virtual servers and networking.",
    example: "Host a small community website for the game on a virtual server. Choose a suitable bundle, keep the software updated, and restrict administrative access to trusted sources.",
    url: "https://aws.amazon.com/lightsail/" },
  cloudfront: { label: "Amazon CloudFront", category: "Content delivery", icon: "./v2/assets/aws/cloudfront.png",
    description: "Deliver content through a global network of edge locations with caching controls.",
    example: "Serve the game's models and textures through a distribution. Cache versioned assets near players while keeping private origin files accessible only through the intended delivery path.",
    url: "https://aws.amazon.com/cloudfront/" },
  route53: { label: "Amazon Route 53", category: "DNS routing", icon: "./v2/assets/aws/route53.png",
    description: "Manage DNS records that route domain names to application endpoints.",
    example: "Point play.example.com at the game's hosting endpoint. DNS records give players a memorable address instead of requiring them to remember a provider-generated hostname.",
    url: "https://aws.amazon.com/route53/" },
  apigateway: { label: "Amazon API Gateway", category: "Managed APIs", icon: "./v2/assets/aws/apigateway.png",
    description: "Create, publish, and manage APIs that connect clients to backend services.",
    example: "Expose a leaderboard API to the game client. Route requests to backend code and configure authentication and throttling rather than letting browsers call a private database directly.",
    url: "https://aws.amazon.com/api-gateway/" },
  elb: { label: "Elastic Load Balancing", category: "Traffic distribution", icon: "./v2/assets/aws/elb.png",
    description: "Distribute incoming application traffic across healthy targets.",
    example: "Send game website requests across several application servers. Health checks help avoid unhealthy targets while the application adds capacity or replaces an old server.",
    url: "https://aws.amazon.com/elasticloadbalancing/" },
  directconnect: { label: "AWS Direct Connect", category: "Dedicated connectivity", icon: "./v2/assets/aws/directconnect.png",
    description: "Establish dedicated network connectivity between your premises and AWS.",
    example: "Connect a studio's existing network to its AWS environment for asset transfers. Plan routing and resilient connections, and arrange encryption separately where required.",
    url: "https://aws.amazon.com/directconnect/" },
  globalaccelerator: { label: "AWS Global Accelerator", category: "Global traffic routing", icon: "./v2/assets/aws/globalaccelerator.png",
    description: "Route traffic through the AWS global network to configured application endpoints.",
    example: "Provide stable entry addresses for a regional game service. Route traffic to suitable healthy endpoints while keeping the application's regional server setup separate from those addresses.",
    url: "https://aws.amazon.com/global-accelerator/" },
  rds: { label: "Amazon RDS", category: "Relational databases", icon: "./v2/assets/aws/rds.png",
    description: "Operate relational databases with managed provisioning, backups, and maintenance features.",
    example: "Store the game's shop orders in related SQL tables. Configure access from the application, not the public internet, and choose backup and recovery settings for the workload.",
    url: "https://aws.amazon.com/rds/" },
  aurora: { label: "Amazon Aurora", category: "Relational database", icon: "./v2/assets/aws/aurora.png",
    description: "Run a managed relational database compatible with MySQL or PostgreSQL.",
    example: "Keep game transactions in SQL tables and query them through application code. Separate read traffic when appropriate and test recovery rather than assuming a database needs no operations.",
    url: "https://aws.amazon.com/rds/aurora/" },
  efs: { label: "Amazon EFS", category: "Shared file storage", icon: "./v2/assets/aws/efs.png",
    description: "Provide shared elastic file storage that Linux applications can access over NFS.",
    example: "Let several content-processing workers access the same directory of game assets. Configure network access and file permissions so only the intended workers can read or change files.",
    url: "https://aws.amazon.com/efs/" },
  fsx: { label: "Amazon FSx", category: "Managed file systems", icon: "./v2/assets/aws/fsx.png",
    description: "Provide managed file systems built on supported file-system technologies.",
    example: "Give a Windows-based game studio a shared asset folder using FSx for Windows File Server. Choose a file-system option that matches the tools and protocols the studio actually uses.",
    url: "https://aws.amazon.com/fsx/" },
  glacier: { label: "Amazon S3 Glacier", category: "Archive storage", icon: "./v2/assets/aws/glacier.png",
    description: "Use S3 Glacier storage classes to archive data with retrieval options suited to infrequent access.",
    example: "Archive old game builds that are rarely needed instead of serving live textures from archive storage. Choose a class with recovery times and retrieval costs that match the studio's needs.",
    url: "https://aws.amazon.com/s3/storage-classes/glacier/" },
  backup: { label: "AWS Backup", category: "Data protection", icon: "./v2/assets/aws/backup.png",
    description: "Centrally manage backup policies and recovery points for supported AWS resources.",
    example: "Apply a backup plan to supported game infrastructure and set retention rules. Practice a restore to confirm those recovery points can actually recover the data the team needs.",
    url: "https://aws.amazon.com/backup/" },
  secretsmanager: { label: "AWS Secrets Manager", category: "Secret management", icon: "./v2/assets/aws/secretsmanager.png",
    description: "Store and manage secrets with controlled application access and rotation features.",
    example: "Let the game backend retrieve its database password using an authorized role. Keep the password out of the browser bundle and source repository, and configure rotation where supported.",
    url: "https://aws.amazon.com/secrets-manager/" },
  kms: { label: "AWS KMS", category: "Encryption keys", icon: "./v2/assets/aws/kms.png",
    description: "Create and control cryptographic keys used by supported services and applications.",
    example: "Use a managed key to protect supported stored game data. Grant only the required key operations to the backend role and review who can administer the key or decrypt the data.",
    url: "https://aws.amazon.com/kms/" },
  cloudwatch: { label: "Amazon CloudWatch", category: "Monitoring", icon: "./v2/assets/aws/cloudwatch.png",
    description: "Collect and inspect metrics, logs, and alarms to understand application behavior.",
    example: "Watch API error counts and record backend logs while players explore. Create an alarm for sustained failures so the team can investigate before every player reports a broken game.",
    url: "https://aws.amazon.com/cloudwatch/" },
};

export const BUILDING_SERVICES = ["s3", "ec2", "iam", "vpc", "lambda", "dynamodb"];
export const CLOUD_REGIONS = {
  village: { service: "lambda", subtitle: "AWS Learning Hub" },
  mountains: { service: "ec2", subtitle: "Compute Highlands" },
  desert: { service: "vpc", subtitle: "Networking Frontier" },
  dungeon: { service: "s3", subtitle: "Storage Vault" },
};

export const AWS_LANDMARKS = {
  village: [
    { service: "ec2", x: -78, z: -32, label: "Compute trail" },
    { service: "vpc", x: -86, z: 20, label: "Network relay" },
    { service: "s3", x: 28, z: 76, label: "Bucket archive" },
    { service: "iam", x: 65, z: -45, label: "Access beacon" },
    { service: "lambda", x: -22, z: -72, label: "Function spire" },
    { service: "dynamodb", x: 32, z: -112, label: "Data archive" },
  ],
  mountains: [
    { service: "autoscaling", x: 22, z: 158, label: "Scaling outpost" },
    { service: "ecs", x: -28, z: 60, label: "Container camp" },
    { service: "eks", x: 30, z: -10, label: "Cluster forge" },
    { service: "ecr", x: -35, z: -90, label: "Image archive" },
    { service: "batch", x: 30, z: -155, label: "Job summit" },
    { service: "lightsail", x: 145, z: -120, label: "Hosting lookout" },
  ],
  desert: [
    { service: "cloudfront", x: 24, z: 178, label: "Edge outpost" },
    { service: "route53", x: -25, z: 85, label: "DNS beacon" },
    { service: "apigateway", x: 35, z: 15, label: "API relay" },
    { service: "elb", x: -20, z: -85, label: "Traffic crossroads" },
    { service: "directconnect", x: 25, z: -165, label: "Dedicated route" },
    { service: "globalaccelerator", x: -160, z: -105, label: "Global relay" },
  ],
  dungeon: [
    { service: "rds", x: -74, z: 76, label: "Relational archive" },
    { service: "aurora", x: 22, z: 76, label: "Database chamber" },
    { service: "efs", x: 118, z: 76, label: "Shared files" },
    { service: "fsx", x: -74, z: -20, label: "File-system chamber" },
    { service: "glacier", x: 22, z: -20, label: "Frozen archive" },
    { service: "backup", x: 118, z: -20, label: "Recovery chamber" },
    { service: "secretsmanager", x: -74, z: -116, label: "Secret vault" },
    { service: "kms", x: 22, z: -116, label: "Key vault" },
    { service: "cloudwatch", x: 118, z: -116, label: "Watchtower" },
  ],
};

for (const map of Object.values(MAPS)) {
  const landmarks = AWS_LANDMARKS[map.id];
  const random = seededRandom(70281 + map.limit);
  const interactions = [...map.gates, ...map.guides,
    ...(map.id === "village" ? [...CHESTS, BOSS] : [])];
  for (const [service, info] of Object.entries(ADDITIONAL_SERVICES)) {
    if (info.map !== map.id) continue;
    let placed = false;
    for (let attempt = 0; attempt < 20000; attempt++) {
      const x = Math.round((random() * 2 - 1) * (map.limit - 12));
      const z = Math.round((random() * 2 - 1) * (map.limit - 12));
      if (!isMapWalkable(map, x, z, 7) || (map.id === "village" && !isWalkable(x, z, 7)) ||
          Math.hypot(x - map.spawn[0], z - map.spawn[1]) < 18 ||
          interactions.some(target => Math.hypot(x - target.x, z - target.z) <= 14) ||
          map.enemies.some(([ex, ez]) => Math.hypot(x - ex, z - ez) <= 14) ||
          landmarks.some(point => Math.hypot(x - point.x, z - point.z) < 15)) continue;
      landmarks.push({ service, x, z, label: info.category });
      placed = true;
      break;
    }
    if (!placed) throw new Error(`No safe discovery position for ${service} in ${map.id}.`);
  }
}

const servicePatterns = {
  s3: /\bs3\b|\bsimple storage service\b/i,
  ec2: /\bec2\b|\belastic compute cloud\b/i,
  iam: /\biam\b|\bidentity and access management\b/i,
  vpc: /\bvpc\b|\bvirtual private cloud\b/i,
  lambda: /\b(?:aws\s+)?lambda\b/i,
  dynamodb: /\bdynamo\s?db\b/i,
  autoscaling: /\b(?:ec2\s+auto\s+scaling|autoscaling)\b/i,
  ecs: /\becs\b|\belastic container service\b/i,
  eks: /\beks\b|\belastic kubernetes service\b/i,
  ecr: /\becr\b|\belastic container registry\b/i,
  batch: /\baws\s+batch\b/i,
  lightsail: /\blightsail\b/i,
  cloudfront: /\bcloud\s?front\b/i,
  route53: /\broute\s?53\b/i,
  apigateway: /\bapi\s?gateway\b/i,
  elb: /\belb\b|\belastic load balancing\b/i,
  directconnect: /\bdirect\s?connect\b/i,
  globalaccelerator: /\bglobal\s?accelerator\b/i,
  rds: /\brds\b|\brelational database service\b/i,
  aurora: /\baurora\b/i,
  efs: /\befs\b|\belastic file system\b/i,
  fsx: /\bfsx\b|\bfs\s+x\b/i,
  glacier: /\bglacier\b/i,
  backup: /\baws\s+backup\b/i,
  secretsmanager: /\bsecrets\s?manager\b/i,
  kms: /\bkms\b|\bkey management service\b/i,
  cloudwatch: /\bcloud\s?watch\b/i,
};

export function missionServices(quest) {
  if (!quest) return [];
  const raw = [quest.name, quest.instruction].filter(value => typeof value === "string").join(" ");
  const words = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
  return Object.keys(servicePatterns).filter(id => servicePatterns[id].test(raw + " " + words));
}

export function plaqueObscuresPlayer(point, width, camera, player) {
  const dx = player.x - camera.x, dy = player.y + 4 - camera.y, dz = player.z - camera.z;
  const x = point.x - camera.x, y = point.y - camera.y, z = point.z - camera.z;
  const length = dx * dx + dy * dy + dz * dz;
  if (!length) return false;
  const t = (x * dx + y * dy + z * dz) / length;
  return t > 0 && t < 1 && Math.hypot(x - dx * t, y - dy * t, z - dz * t) < width * 0.65;
}
