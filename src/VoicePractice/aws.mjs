import { randomUUID } from "node:crypto";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, paginateQuery, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { digest, HttpError } from "./domain.mjs";
import { validateGrade } from "./activities.mjs";

const config = { region: process.env.AWS_REGION, maxAttempts: 3 };
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient(config), { marshallOptions: { removeUndefinedValues: true } });
const lambda = new LambdaClient(config);
const runtime = new BedrockAgentCoreClient({ ...config, maxAttempts: 1 });

export async function readBounded(stream, limit = 65536) {
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of stream) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw new Error("Response too large");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (e) { stream.destroy?.(); await stream.cancel?.(); throw e; }
}
export async function parseAgentResponse(output) {
  if (output.statusCode && output.statusCode !== 200) throw new Error("Agent runtime failed");
  const text = await readBounded(output.response);
  if (output.contentType?.startsWith("text/event-stream")) {
    const data = text.replace(/\r\n/g, "\n").split("\n\n")
      .map(frame => frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"))
      .filter(value => value && value !== "[DONE]");
    if (data.length !== 1) throw new Error("Expected one structured JSON response");
    return JSON.parse(data[0]);
  }
  return JSON.parse(text);
}
export async function resolveOwner(event, lookup) {
  const identity = event.requestContext?.identity;
  const header = Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === "x-api-key")?.[1];
  const key = identity?.apiKey ?? header;
  if (!identity?.apiKeyId || typeof key !== "string" || !key || key.length > 256)
    throw new HttpError(401, "API key authentication required");
  const mapping = await lookup(key);
  if (typeof mapping?.Email !== "string" || !mapping.Email.trim())
    throw new HttpError(403, "Player identity unavailable; sign in to a quest first");
  return digest(mapping.Email);
}
export function awsDependencies(env = process.env, clients = {}) {
  const TableName = env.VOICE_TABLE;
  const agentClient = clients.runtime ?? runtime;
  const database = clients.dynamo ?? dynamo;
  const store = {
    async get(Key) { return (await database.send(new GetCommand({ TableName, Key, ConsistentRead: true }))).Item; },
    async listActivities(owner) {
      const rows = [];
      for await (const page of paginateQuery({ client: database }, {
        TableName, KeyConditionExpression: "PK = :owner AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":owner": `PLAYER#${owner}`, ":prefix": "ACTIVITY#" },
        ConsistentRead: true,
      })) rows.push(...(page.Items ?? []));
      return rows;
    },
    async listQuestions(serviceId) {
      const rows = [];
      for await (const page of paginateQuery({ client: database }, {
        TableName, KeyConditionExpression: "PK = :bank AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":bank": "QUESTION_BANK",
          ":prefix": serviceId ? `SERVICE#${serviceId}#QUESTION#` : "SERVICE#" },
        ConsistentRead: true,
      })) rows.push(...(page.Items ?? []));
      return rows;
    },
    isConflict(e) {
      return ["ConditionalCheckFailedException", "TransactionInProgressException"].includes(e.name) ||
        (e.name === "TransactionCanceledException" &&
          e.CancellationReasons?.some(r => ["ConditionalCheckFailed", "TransactionConflict"].includes(r.Code)));
    },
    async atomic(writes) {
      await database.send(new TransactWriteCommand({
        TransactItems: writes.map(({ item, previous }) => ({ Put: {
          TableName, Item: item,
          ConditionExpression: previous === undefined ? "attribute_not_exists(PK)" : "revision = :revision",
          ...(previous === undefined ? {} : { ExpressionAttributeValues: { ":revision": previous } }),
        } })),
      }));
    },
  };
  return {
    store,
    async passedTestsFor(event) {
      let email;
      await resolveOwner(event, async key => {
        const mapping = (await database.send(new GetCommand({
          TableName: env.API_KEY_LOOKUP_TABLE, Key: { ApiKey: key }, ConsistentRead: true,
        }))).Item;
        email = mapping?.Email;
        return mapping;
      });
      const tests = [];
      for await (const page of paginateQuery({ client: database }, {
        TableName: env.PASSED_TEST_TABLE, KeyConditionExpression: "#user = :user",
        ProjectionExpression: "#test, #marks", ExpressionAttributeNames: { "#user": "User", "#test": "Test", "#marks": "Marks" },
        ExpressionAttributeValues: { ":user": email }, ConsistentRead: true,
      })) for (const row of page.Items ?? []) if (Number(row.Marks) > 0 && typeof row.Test === "string") tests.push(row.Test);
      return tests;
    },
    async ownerFor(event) {
      return resolveOwner(event, async key => (await dynamo.send(new GetCommand({
        TableName: env.API_KEY_LOOKUP_TABLE, Key: { ApiKey: key }, ConsistentRead: true,
      }))).Item);
    },
    async enqueue(payload) {
      const result = await lambda.send(new InvokeCommand({
        FunctionName: env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(payload)),
      }));
      if (result.StatusCode !== 202) throw new Error("Worker not accepted");
    },
    async agent(operation, input) {
      const question = operation === "evaluate" ? input.selectedQuestion ?? {
        id: "voice-question", prompt: input.question, ...input.rubric,
        acceptableParaphrases: [], feedbackGuidance: "Evaluate conceptual understanding, not exact phrasing.",
      } : undefined;
      const response = await agentClient.send(new InvokeAgentRuntimeCommand({
        agentRuntimeArn: env.VOICE_AGENT_RUNTIME_ARN, runtimeSessionId: randomUUID(),
        ...(env.VOICE_AGENT_QUALIFIER ? { qualifier: env.VOICE_AGENT_QUALIFIER } : {}),
        contentType: "application/json", accept: "application/json",
        payload: Buffer.from(JSON.stringify({ operation, ...(operation === "grade_reading" ? {
          activityId: input.activityId, serviceId: input.serviceId,
          readingTexts: Object.fromEntries(Object.entries(input.readingTexts ?? {}).sort(([a], [b]) => a.localeCompare(b))),
          transcript: input.transcript, language: input.language ?? "en-US",
          ...(input.feedbackLanguage ? { feedbackLanguage: input.feedbackLanguage } : {}),
        } : operation === "grade_answer" ? {
          question: input.question, transcript: input.transcript, language: input.language ?? "en-US",
          ...(input.feedbackLanguage ? { feedbackLanguage: input.feedbackLanguage } : {}),
        } : operation === "generate" ? input : {
          question, transcript: input.transcript, history: input.history ?? [], language: input.language ?? "en-US",
          ...(input.feedbackLanguage ? { feedbackLanguage: input.feedbackLanguage } : {}),
        }) })),
      }), { abortSignal: AbortSignal.timeout(90000) });
      const value = await parseAgentResponse(response);
      if (operation === "generate") return value;
      if (operation === "grade_reading") return validateGrade(value);
      if (operation === "grade_answer") return value;
      if (!["pass", "retry", "review"].includes(value.verdict)) throw new Error("Invalid verdict");
      return { passed: value.verdict === "pass", feedback: value.feedback };
    },
  };
}
