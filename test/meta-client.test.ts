import { describe, expect, it } from "vitest";
import { HttpMetaClient } from "../src/worker/meta/client";

function fakeFetch(responses: Array<{ status: number; body: unknown } | "network">) {
  const calls: Array<{ url: string; body: any }> = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const r = responses.shift()!;
    if (r === "network") throw new TypeError("network down");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  };
  return { f, calls };
}
const client = (f: any) => new HttpMetaClient({ apiVersion: "v26.0", appId: "1", appSecret: "s", fetch: f });
const msg = { text: "رد بكلمة ابدأ", quickReplies: [{ title: "ابدأ", payload: "hsn:v1:start:abcdefghijklmnopqrstuv" }] };

describe("private reply with a button", () => {
  it("sends a button template with a postback button to the comment", async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { message_id: "m1" } }]);
    const r = await client(f).sendPrivateReply("t", "ig1", "c1", msg);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://graph.instagram.com/v26.0/ig1/messages");
    expect(calls[0].body.recipient).toEqual({ comment_id: "c1" });
    const p = calls[0].body.message.attachment.payload;
    expect(p.template_type).toBe("button");
    expect(p.buttons[0]).toEqual({ type: "postback", title: "ابدأ", payload: "hsn:v1:start:abcdefghijklmnopqrstuv" });
  });

  it("falls back to plain text once when Meta rejects the template", async () => {
    const { f, calls } = fakeFetch([
      { status: 400, body: { error: { code: 100, message: "Invalid parameter" } } },
      { status: 200, body: { message_id: "m2" } },
    ]);
    const r = await client(f).sendPrivateReply("t", "ig1", "c1", msg);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.message).toEqual({ text: "رد بكلمة ابدأ" });
  });

  it("never resends after an uncertain (network) outcome", async () => {
    const { f, calls } = fakeFetch(["network"]);
    const r = await client(f).sendPrivateReply("t", "ig1", "c1", msg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("uncertain");
    expect(calls).toHaveLength(1);
  });

  it("does not fall back on rate limits (they are retried later by the queue)", async () => {
    const { f, calls } = fakeFetch([{ status: 429, body: { error: { code: 4, message: "rate" } } }]);
    const r = await client(f).sendPrivateReply("t", "ig1", "c1", msg);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("DMs use quick replies", async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { message_id: "m3" } }]);
    await client(f).sendMessage("t", "ig1", "u1", msg);
    expect(calls[0].body.recipient).toEqual({ id: "u1" });
    expect(calls[0].body.message.quick_replies[0]).toMatchObject({ content_type: "text", title: "ابدأ" });
  });
});
