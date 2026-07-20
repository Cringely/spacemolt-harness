// Downloads the live OpenAPI spec and stores a slim fixture: just
// path -> required request params. Run manually when the game updates:
//   bun run scripts/refresh-openapi.ts
const SPEC_URL = "https://www.spacemolt.com/api/v2/openapi.json";

const spec = (await (await fetch(SPEC_URL)).json()) as {
  paths: Record<string, Record<string, {
    requestBody?: { content?: { "application/json"?: { schema?: {
      required?: string[]; properties?: Record<string, unknown>;
    } } } };
  }>>;
};

const slim: Record<string, { required: string[]; properties: string[] } | string> = {
  // freshness marker for test/registry-conformance.test.ts; not a path entry
  __generated__: new Date().toISOString(),
};
for (const [path, methods] of Object.entries(spec.paths)) {
  const post = methods["post"];
  const schema = post?.requestBody?.content?.["application/json"]?.schema;
  if (!schema) continue;
  slim[path] = {
    required: schema.required ?? [],
    properties: Object.keys(schema.properties ?? {}),
  };
}
await Bun.write("test/fixtures/openapi-slim.json", JSON.stringify(slim, null, 2));
console.log(`wrote ${Object.keys(slim).length} paths`);
