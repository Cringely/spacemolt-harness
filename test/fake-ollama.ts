export interface FakeOllama {
  url: string;
  requests: Array<{ body: Record<string, unknown> }>;
  respondWith(fn: (body: Record<string, unknown>) => object): void;
  stop(): void;
}

// Same shape as test/fake-server.ts's fake game server: an in-process HTTP
// stub, canned responses, zero network beyond localhost. Not the game fake --
// Ollama's wire protocol is unrelated -- but the same reusable pattern.
export function startFakeOllama(): FakeOllama {
  const requests: FakeOllama["requests"] = [];
  let handler: ((body: Record<string, unknown>) => object) | null = null;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/api/chat" || req.method !== "POST") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      requests.push({ body });
      return Response.json(handler ? handler(body) : { message: { content: "{}" } });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    requests,
    respondWith: (fn) => void (handler = fn),
    stop: () => void server.stop(true),
  };
}
