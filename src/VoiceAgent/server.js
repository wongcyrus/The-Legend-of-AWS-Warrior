import { createServer } from "node:http";
import { createAgent } from "./agent.mjs";

export function createAgentServer(agent = createAgent()) {
  return createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && request.url === "/ping") {
      response.end(JSON.stringify({ status: "Healthy" }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/invocations") {
      response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    try {
      request.setEncoding("utf8");
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 180000) throw new Error("Request too large");
      }
      const result = await agent(JSON.parse(raw));
      response.end(JSON.stringify(result));
    } catch {
      // Do not log transcripts, lesson payloads or model responses.
      response.writeHead(422).end(JSON.stringify({ error: "Unable to evaluate this request. Please retry." }));
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const server = createAgentServer();
  server.listen(8080, "0.0.0.0");
  process.on("SIGTERM", () => server.close());
}
