import { first, run } from "../lib/db";
import type { FollowCheckOutcome, FollowResult, MetaClient, MetaError, MetaResult, OutgoingMessage } from "./types";

/**
 * Demo-mode Meta client. Never performs network requests.
 * Behaviour is scripted per demo participant (participants.demo_follow_script):
 * {
 *   "follow": ["needs_interaction", "not_following", "following"],  // consumed in order, last value repeats
 *   "privateReply": "ok" | "fail" | "uncertain",
 *   "dm": "ok" | "window_closed" | "fail" | "uncertain",
 *   "publicReply": "ok" | "fail"
 * }
 */
export interface DemoScript {
  follow?: FollowResult[];
  idx?: number;
  privateReply?: "ok" | "fail" | "uncertain";
  dm?: "ok" | "window_closed" | "fail" | "uncertain";
  publicReply?: "ok" | "fail";
}

export class DemoMetaClient implements MetaClient {
  constructor(private readonly db: D1Database) {}

  private async script(igsid: string): Promise<{ id: number; s: DemoScript } | null> {
    const p = await first<{ id: number; demo_follow_script: string | null }>(
      this.db,
      "SELECT p.id, p.demo_follow_script FROM participants p JOIN instagram_accounts a ON a.id = p.account_id WHERE a.is_demo = 1 AND p.igsid = ?",
      igsid,
    );
    if (!p) return null;
    try {
      return { id: p.id, s: JSON.parse(p.demo_follow_script ?? "{}") };
    } catch {
      return { id: p.id, s: {} };
    }
  }

  private async scriptByComment(commentId: string): Promise<DemoScript> {
    const r = await first<{ demo_follow_script: string | null }>(
      this.db,
      "SELECT p.demo_follow_script FROM conversation_flows f JOIN participants p ON p.id = f.participant_id WHERE f.source_comment_id = ? AND f.is_demo = 1 ORDER BY f.id DESC LIMIT 1",
      commentId,
    );
    try {
      return JSON.parse(r?.demo_follow_script ?? "{}");
    } catch {
      return {};
    }
  }

  private result(mode: string | undefined): MetaResult<{ message_id?: string; id?: string }> {
    const err = (e: MetaError): MetaResult<never> => ({ ok: false, error: e });
    switch (mode) {
      case "fail":
        return err({ kind: "permanent", httpStatus: 400, code: 100, message: "[demo] simulated failure" });
      case "uncertain":
        return err({ kind: "uncertain", message: "[demo] simulated connection loss after send" });
      case "window_closed":
        return err({ kind: "window_closed", httpStatus: 400, code: 10, subcode: 2534022, message: "[demo] outside of allowed window" });
      default:
        return { ok: true, httpStatus: 200, data: { message_id: `demo_mid_${crypto.randomUUID().slice(0, 8)}`, id: `demo_${crypto.randomUUID().slice(0, 8)}` } };
    }
  }

  async sendPrivateReply(_t: string, _ig: string, commentId: string, _m: OutgoingMessage) {
    return this.result((await this.scriptByComment(commentId)).privateReply);
  }

  async sendMessage(_t: string, _ig: string, recipientId: string, _m: OutgoingMessage) {
    return this.result((await this.script(recipientId))?.s.dm);
  }

  async replyToComment(_t: string, commentId: string, _text: string) {
    return this.result((await this.scriptByComment(commentId)).publicReply);
  }

  async checkFollow(_t: string, igsid: string): Promise<FollowCheckOutcome> {
    const sc = await this.script(igsid);
    const list = sc?.s.follow?.length ? sc.s.follow : (["following"] as FollowResult[]);
    const idx = sc?.s.idx ?? 0;
    const result = list[Math.min(idx, list.length - 1)];
    if (sc) {
      await run(this.db, "UPDATE participants SET demo_follow_script = ? WHERE id = ?", JSON.stringify({ ...sc.s, idx: idx + 1 }), sc.id);
    }
    const fieldPresent = result === "following" || result === "not_following";
    const errorCode =
      result === "needs_interaction" ? "230" : result === "unsupported" ? "10" : result === "temporary_error" ? "2" : undefined;
    return { result, fieldPresent, httpStatus: fieldPresent || result === "unknown" ? 200 : 400, errorCode };
  }
}
