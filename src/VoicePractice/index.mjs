import { awsDependencies } from "./aws.mjs";
import { createService, HttpError } from "./domain.mjs";

export function createHandler(dependencies, env = process.env) {
  const service = createService(dependencies);
  return async event => {
    const origin = Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === "origin")?.[1];
    const headers = {
      "Content-Type": "application/json", "Cache-Control": "no-store",
      "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", "Vary": "Origin",
      ...(origin && origin === env.VOICE_WEB_ORIGIN ? {
        "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "content-type,authorization,x-api-key",
      } : {}),
    };
    try {
      if (origin && origin !== env.VOICE_WEB_ORIGIN) throw new HttpError(403, "Origin not allowed");
      if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
      const result = await service.route(event);
      if (event.job && !event.requestContext) return;
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    } catch (e) {
      // Deliberately do not log events, capabilities, transcripts or SDK error messages.
      if (event.job && !event.requestContext) throw new Error("Voice worker failed");
      const status = e instanceof HttpError ? e.status : dependencies.store.isConflict(e) ? 409 : 503;
      return { statusCode: status, headers, body: JSON.stringify({
        error: e instanceof HttpError ? e.message : status === 409 ? "Session changed; retry request" : "Voice practice temporarily unavailable",
      }) };
    }
  };
}
export const handler = createHandler(awsDependencies());
