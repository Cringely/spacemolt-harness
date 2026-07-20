export interface FakeOpenAiCompat {
  url: string;
  requests: Array<{ body: Record<string, unknown>; authorization: string | null }>;
  respondWith(fn: (body: Record<string, unknown>) => object): void;
  respondStatus(status: number): void;
  stop(): void;
}

// Same in-process HTTP stub pattern as test/fake-ollama.ts, speaking the
// OpenAI chat-completions wire shape at /v1/chat/completions. Captures the
// Authorization header per request so tests can prove the no-key default
// (LAN LM Studio) sends none and a configured key arrives as a Bearer token.
export function startFakeOpenAiCompat(): FakeOpenAiCompat {
  const requests: FakeOpenAiCompat["requests"] = [];
  let handler: ((body: Record<string, unknown>) => object) | null = null;
  let forcedStatus: number | null = null;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions" || req.method !== "POST") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      requests.push({ body, authorization: req.headers.get("authorization") });
      if (forcedStatus !== null) return Response.json({ error: "forced" }, { status: forcedStatus });
      return Response.json(
        handler ? handler(body) : { choices: [{ message: { content: "{}" } }] },
      );
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    requests,
    respondWith: (fn) => void (handler = fn),
    respondStatus: (status) => void (forcedStatus = status),
    stop: () => void server.stop(true),
  };
}
