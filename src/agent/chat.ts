import type { EnvelopeNotification } from "../client/http";
import type { ChatMessage } from "../planner/types";

// Social capabilities task. UNVERIFIED (ASSUMED, not VERIFIED -- see
// docs/wiki/spacemolt-api.md's convention): the shape of a chat_message
// notification's `data` field has never been captured live (no live-game
// calls authorized for this task). This extractor is defensive by
// construction rather than trusting a guessed shape: it tries a small set of
// plausible field-name candidates and drops (never throws on, never
// fabricates) a message it can't confidently read a sender+text pair out of.
// Revisit once a real chat_message notification is captured and this can be
// marked VERIFIED with the confirmed field names.
const SENDER_KEYS = ["sender", "from", "username", "player_name", "name"];
const TEXT_KEYS = ["content", "text", "message"];

function firstString(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function toChatMessage(n: EnvelopeNotification): ChatMessage | null {
  if (typeof n.data !== "object" || n.data === null) return null;
  const rec = n.data as Record<string, unknown>;
  const text = firstString(rec, TEXT_KEYS);
  if (!text) return null; // no readable message body: drop rather than guess
  return { sender: firstString(rec, SENDER_KEYS) ?? "unknown", text };
}

/** Pulls chat_message notifications out of a notification batch, defensively. */
export function extractChatMessages(notifications: EnvelopeNotification[]): ChatMessage[] {
  return notifications
    .filter((n) => n.msg_type === "chat_message")
    .map(toChatMessage)
    .filter((m): m is ChatMessage => m !== null);
}
