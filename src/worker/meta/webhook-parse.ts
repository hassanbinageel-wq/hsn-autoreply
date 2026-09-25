/**
 * Parses Instagram webhook payloads (object = "instagram") into normalized events.
 * Only fields documented for the Instagram API with Instagram Login are read:
 *   entry[].changes[] (field = comments)               → comment
 *   entry[].messaging[].message.reply_to.story        → story_reply
 *   entry[].messaging[].message.attachments[type=story_mention] → story_mention
 *   entry[].messaging[].message.quick_reply.payload    → quick_reply
 *   entry[].messaging[].postback                       → postback
 *   entry[].messaging[].message.is_echo                → echo (ignored)
 *   entry[].messaging[].reaction                       → reaction (logged, not a trigger)
 * Anything else is kept as "other" and ignored.
 */

export type NormalizedKind =
  | "comment"
  | "story_reply"
  | "story_mention"
  | "message"
  | "quick_reply"
  | "postback"
  | "echo"
  | "reaction"
  | "other";

export interface NormalizedEvent {
  kind: NormalizedKind;
  dedupKey: string;
  accountIgId: string;
  senderId?: string;
  senderUsername?: string;
  recipientId?: string;
  text?: string;
  mediaId?: string;
  mediaProductType?: string;
  commentId?: string;
  parentId?: string;
  mid?: string;
  storyId?: string;
  buttonPayload?: string;
  time: number; // ms
}

function toMs(t: unknown, fallback: number): number {
  const n = typeof t === "number" ? t : Number(t);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n < 1e12 ? n * 1000 : n;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function parseWebhook(body: any, now = Date.now()): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  if (!body || body.object !== "instagram" || !Array.isArray(body.entry)) return out;

  for (const entry of body.entry) {
    const accountIgId = String(entry?.id ?? "");
    if (!accountIgId) continue;
    const entryTime = toMs(entry?.time, now);

    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = change?.value ?? {};
      if (change?.field === "comments" && v?.id) {
        out.push({
          kind: "comment",
          dedupKey: `comment:${v.id}`,
          accountIgId,
          senderId: v.from?.id ? String(v.from.id) : undefined,
          senderUsername: v.from?.username,
          text: typeof v.text === "string" ? v.text : "",
          mediaId: v.media?.id ? String(v.media.id) : undefined,
          mediaProductType: v.media?.media_product_type,
          commentId: String(v.id),
          parentId: v.parent_id ? String(v.parent_id) : undefined,
          time: entryTime,
        });
      } else {
        out.push({
          kind: "other",
          dedupKey: `change:${await sha256Hex(JSON.stringify(change))}`,
          accountIgId,
          time: entryTime,
        });
      }
    }

    for (const m of Array.isArray(entry?.messaging) ? entry.messaging : []) {
      const time = toMs(m?.timestamp, entryTime);
      const senderId = m?.sender?.id ? String(m.sender.id) : undefined;
      const recipientId = m?.recipient?.id ? String(m.recipient.id) : undefined;
      const base = { accountIgId, senderId, recipientId, time };

      if (m?.postback) {
        const mid = m.postback.mid ? String(m.postback.mid) : undefined;
        out.push({
          ...base,
          kind: "postback",
          mid,
          dedupKey: mid ? `postback:${mid}` : `postback:${await sha256Hex(JSON.stringify(m))}`,
          text: m.postback.title,
          buttonPayload: typeof m.postback.payload === "string" ? m.postback.payload : undefined,
        });
        continue;
      }
      if (m?.reaction) {
        out.push({
          ...base,
          kind: "reaction",
          mid: m.reaction.mid,
          dedupKey: `reaction:${await sha256Hex(JSON.stringify(m))}`,
        });
        continue;
      }
      const msg = m?.message;
      if (!msg) {
        out.push({ ...base, kind: "other", dedupKey: `messaging:${await sha256Hex(JSON.stringify(m))}` });
        continue;
      }
      const mid = msg.mid ? String(msg.mid) : undefined;
      const dedupKey = mid ? `msg:${mid}` : `msg:${await sha256Hex(JSON.stringify(m))}`;
      const text = typeof msg.text === "string" ? msg.text : undefined;

      if (msg.is_echo) {
        out.push({ ...base, kind: "echo", mid, dedupKey, text });
        continue;
      }
      if (msg.is_deleted) {
        out.push({ ...base, kind: "other", mid, dedupKey: `${dedupKey}:deleted` });
        continue;
      }
      const attachments: any[] = Array.isArray(msg.attachments) ? msg.attachments : [];
      if (attachments.some((a) => a?.type === "story_mention")) {
        out.push({ ...base, kind: "story_mention", mid, dedupKey, text });
        continue;
      }
      if (msg.reply_to?.story) {
        out.push({
          ...base,
          kind: "story_reply",
          mid,
          dedupKey,
          text: text ?? "",
          storyId: msg.reply_to.story.id ? String(msg.reply_to.story.id) : undefined,
        });
        continue;
      }
      if (msg.quick_reply?.payload) {
        out.push({ ...base, kind: "quick_reply", mid, dedupKey, text, buttonPayload: String(msg.quick_reply.payload) });
        continue;
      }
      out.push({ ...base, kind: "message", mid, dedupKey, text });
    }
  }
  return out;
}
