export interface FakeServer {
  url: string;
  calls: Array<{ tool: string; action: string; body: Record<string, unknown>; sessionId: string | null }>;
  setHandler(tool: string, action: string, fn: (body: Record<string, unknown>) => object): void;
  failNextWith(error: { code: string; message: string; retry_after?: number }): void;
  /** Return a raw non-JSON HTTP error (e.g. 503) on the next call — models a
   * bodyless gateway error that would crash a client that assumes JSON. */
  failNextWithStatus(status: number): void;
  stop(): void;
}

export function startFakeServer(): FakeServer {
  const calls: FakeServer["calls"] = [];
  const handlers = new Map<string, (body: Record<string, unknown>) => object>();
  const sessions = new Set<string>();
  let pendingError: { code: string; message: string; retry_after?: number } | null = null;
  let pendingStatus: number | null = null;
  let sessionCounter = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const json = (o: object) => Response.json(o);

      if (url.pathname === "/api/v2/session" && req.method === "POST") {
        const id = `sess-${++sessionCounter}`;
        sessions.add(id);
        return json({ session: { id } });
      }

      // The action segment is OPTIONAL: `spacemolt_catalog` is published by the
      // game as a bare tool path with no action (issue #219), so the fake must
      // route it the same way the real API does -- otherwise the one transport
      // shape we cannot test offline is the one we just introduced.
      const m = url.pathname.match(/^\/api\/v2\/([^/]+)(?:\/([^/]+))?$/);
      if (!m || req.method !== "POST") return json({ error: { code: "unknown_command", message: "no route" } });
      const tool = m[1]!;
      const action = m[2] ?? "";

      const sessionId = req.headers.get("X-Session-Id");
      const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      calls.push({ tool, action, body, sessionId });

      if (pendingStatus !== null) {
        const s = pendingStatus;
        pendingStatus = null;
        return new Response("Service Unavailable", { status: s });
      }
      if (pendingError) {
        const e = pendingError;
        pendingError = null;
        return json({ error: e });
      }
      // auth tool works sessionless in the real API only for register; keep
      // the fake strict: everything needs a session except register.
      if (!sessionId || !sessions.has(sessionId)) {
        if (!(tool === "spacemolt_auth" && action === "register")) {
          return json({ error: { code: "session_required", message: "no session" } });
        }
      }
      const handler = handlers.get(`${tool}/${action}`);
      return json(handler ? handler(body) : { result: "ok" });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    calls,
    setHandler: (tool, action, fn) => void handlers.set(`${tool}/${action}`, fn),
    failNextWith: (error) => void (pendingError = error),
    failNextWithStatus: (status) => void (pendingStatus = status),
    stop: () => void server.stop(true),
  };
}
