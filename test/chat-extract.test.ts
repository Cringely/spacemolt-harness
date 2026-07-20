import { describe, expect, test } from "bun:test";
import { extractChatMessages } from "../src/agent/chat";
import type { EnvelopeNotification } from "../src/client/http";

function notif(msg_type: string, data?: unknown): EnvelopeNotification {
  return { id: "n1", type: "chat", msg_type, timestamp: "2026-07-11T00:00:00Z", data };
}

describe("extractChatMessages", () => {
  test("extracts sender+text from a chat_message notification", () => {
    const msgs = extractChatMessages([notif("chat_message", { sender: "traderJoe", content: "hi there" })]);
    expect(msgs).toEqual([{ sender: "traderJoe", text: "hi there" }]);
  });

  test("falls back through candidate field names for sender and text", () => {
    const msgs = extractChatMessages([notif("chat_message", { username: "bob", message: "yo" })]);
    expect(msgs).toEqual([{ sender: "bob", text: "yo" }]);
  });

  test("defaults sender to 'unknown' when no sender-like field is present", () => {
    const msgs = extractChatMessages([notif("chat_message", { text: "anonymous tip" })]);
    expect(msgs).toEqual([{ sender: "unknown", text: "anonymous tip" }]);
  });

  test("drops a chat_message notification with no readable text (fails safe, never throws)", () => {
    expect(extractChatMessages([notif("chat_message", { sender: "bob" })])).toEqual([]);
    expect(extractChatMessages([notif("chat_message", undefined)])).toEqual([]);
    expect(extractChatMessages([notif("chat_message", "not an object")])).toEqual([]);
    expect(extractChatMessages([notif("chat_message", null)])).toEqual([]);
  });

  test("ignores non-chat_message notifications entirely", () => {
    const msgs = extractChatMessages([
      notif("player_died", { content: "should not appear" }),
      notif("trade", { content: "also not chat" }),
    ]);
    expect(msgs).toEqual([]);
  });

  test("returns an empty array for an empty notification batch", () => {
    expect(extractChatMessages([])).toEqual([]);
  });
});
