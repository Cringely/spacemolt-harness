import { z } from "zod";

export interface FieldShape {
  name: string;
  type: "string" | "number" | "boolean" | "string[]" | "object[]";
  optional: boolean;
}

/**
 * Introspects the fixed vocabulary of zod primitives the registry actually
 * uses today (string, number, boolean, array-of-string, array-of-loosely-
 * typed-object, enum, optional-wrapped). Throws on anything else so registry
 * drift fails loudly at schema-build time instead of silently mis-describing
 * an action to an LLM or a JSON-schema validator. A generic Zod-to-JSON-Schema
 * walker would need to cover Zod's full type system; the registry only ever
 * uses these constructs, so a small closed-world switch covers 100% of real
 * cases and stays honest about its limits. Two consumers share this: digest.ts's human-readable action
 * vocabulary (this task) and ollama.ts's structured-output JSON schema
 * (Task 3) -- one walker, not two, per the project's DRY convention.
 * "object[]" added for spacemolt_intel submit_intel/submit_trade_intel
 * (issue #229): both take an array of loosely-typed report objects (the
 * OpenAPI spec itself declares only `items: {type: "object"}`, no nested
 * schema), so this maps that shape rather than inventing structure the API
 * doesn't assert.
 */
export function describeParamsShape(schema: z.ZodTypeAny): FieldShape[] {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(`describeParamsShape: expected a ZodObject, got ${schema.constructor.name}`);
  }
  return Object.entries(schema.shape).map(([name, field]) => {
    const zf = field as z.ZodTypeAny;
    const optional = zf instanceof z.ZodOptional;
    const inner = optional ? zf.unwrap() : zf;
    return { name, type: primitiveType(inner), optional };
  });
}

function primitiveType(field: z.ZodTypeAny): FieldShape["type"] {
  if (field instanceof z.ZodString) return "string";
  if (field instanceof z.ZodNumber) return "number";
  if (field instanceof z.ZodBoolean) return "boolean";
  if (field instanceof z.ZodArray && field.element instanceof z.ZodString) return "string[]";
  if (field instanceof z.ZodArray && field.element instanceof z.ZodRecord) return "object[]";
  // A ZodEnum is a constrained string (chat's `target` channel). Both consumers
  // -- the digest's human vocabulary and ollama's JSON schema -- are correct to
  // describe it as a string: the enum's real enforcement is the zod parse at
  // the registry boundary, and the digest spells the allowed channels out in
  // prose (see the chat-channel briefing in digest.ts). Enum is a construct the
  // registry now actually uses, so this stays in the closed-world switch rather
  // than becoming a silent catch-all.
  if (field instanceof z.ZodEnum) return "string";
  throw new Error(`describeParamsShape: unsupported zod field type ${field.constructor.name}`);
}
