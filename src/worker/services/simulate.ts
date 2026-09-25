import type { z } from "zod";
import type { simulateSchema } from "../../shared/schemas";
import { TERMINAL_FLOW_STATES } from "../../shared/states";
import type { Env } from "../env";
import { all, first, run } from "../lib/db";
import type { NormalizedEvent } from "../meta/webhook-parse";
import { runQueue } from "../engine/executor";
import { engineContext } from "./account";
import { storeEvents } from "./webhook";
import type { FlowRow } from "../engine/context";

export const DEMO_IG_ID = "demo_business";
const TERMINAL_SQL = TERMINAL_FLOW_STATES.map((s) => `'${s}'`).join(",");

async function ensureDemoAccount(db: D1Database): Promise<number> {
  const now = Date.now();
  await run(
    db,
    `INSERT OR IGNORE INTO instagram_accounts (ig_user_id, username, name, is_demo, status, webhook_status, follow_check_support, created_at, updated_at)
     VALUES (?, 'hsn_demo', 'حساب تجريبي', 1, 'active', 'subscribed', 'supported', ?, ?)`,
    DEMO_IG_ID,
    now,
    now,
  );
  return (await first<{ id: number }>(db, "SELECT id FROM instagram_accounts WHERE ig_user_id = ?", DEMO_IG_ID))!.id;
}

/**
 * Runs a scenario through the REAL pipeline (event store → queue → engine) using demo rows
 * (is_demo = 1) and the DemoMetaClient, so nothing is ever sent to Instagram.
 */
export async function simulate(env: Env, input: z.infer<typeof simulateSchema>) {
  const db = env.DB;
  const now = Date.now();
  const accountId = await ensureDemoAccount(db);
  const igsid = `demo_${input.participant}`;

  if (input.reset) {
    await db.batch([
      db.prepare("DELETE FROM conversation_flows WHERE account_id = ? AND participant_id IN (SELECT id FROM participants WHERE account_id = ? AND igsid = ?)").bind(accountId, accountId, igsid),
      db.prepare("DELETE FROM participants WHERE account_id = ? AND igsid = ?").bind(accountId, igsid),
    ]);
  }
  await run(
    db,
    `INSERT INTO participants (account_id, igsid, username, is_demo, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(account_id, igsid) DO NOTHING`,
    accountId,
    igsid,
    input.participant,
    now,
    now,
  );
  if (input.script) {
    await run(db, "UPDATE participants SET demo_follow_script = ? WHERE account_id = ? AND igsid = ?", JSON.stringify({ ...input.script, idx: 0 }), accountId, igsid);
  }
  if (input.script?.dm === "window_closed") {
    // Simulate an expired messaging window: last user message 25h ago.
    await run(db, "UPDATE participants SET last_user_message_at = ? WHERE account_id = ? AND igsid = ?", now - 25 * 3_600_000, accountId, igsid);
  }

  const uid = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const base = { accountIgId: DEMO_IG_ID, senderId: igsid, senderUsername: input.participant, time: now };
  let ev: NormalizedEvent;
  let forced: number | undefined;
  switch (input.event) {
    case "comment":
      ev = { ...base, kind: "comment", dedupKey: `comment:${uid}`, text: input.text, mediaId: input.media_id || "demo_media_1", commentId: `demo_c_${uid}`, parentId: input.is_reply ? "demo_parent" : undefined };
      forced = input.campaign_id;
      break;
    case "story_reply":
      ev = { ...base, kind: "story_reply", dedupKey: `msg:${uid}`, mid: uid, text: input.text, storyId: input.media_id || "demo_story_1" };
      forced = input.campaign_id;
      break;
    case "story_mention":
      ev = { ...base, kind: "story_mention", dedupKey: `msg:${uid}`, mid: uid };
      forced = input.campaign_id;
      break;
    case "message":
      ev = { ...base, kind: "message", dedupKey: `msg:${uid}`, mid: uid, text: input.text };
      break;
    case "verify_button":
    case "start_button": {
      const flow = await first<FlowRow>(
        db,
        `SELECT f.* FROM conversation_flows f JOIN participants p ON p.id = f.participant_id
          WHERE p.account_id = ? AND p.igsid = ? AND f.state NOT IN (${TERMINAL_SQL}) ORDER BY f.updated_at DESC LIMIT 1`,
        accountId,
        igsid,
      );
      if (!flow) return { ok: false, error: "لا يوجد مسار مفتوح لهذا المستخدم التجريبي" };
      const action = input.event === "verify_button" ? "verify" : "start";
      const token = action === "verify" ? flow.verify_token : flow.start_token;
      ev = { ...base, kind: "quick_reply", dedupKey: `msg:${uid}`, mid: uid, text: action === "verify" ? "تحقّق من المتابعة" : "ابدأ", buttonPayload: `hsn:v1:${action}:${token}` };
      break;
    }
  }
  await storeEvents(db, [ev], { isDemo: true, now, forcedCampaignId: forced });
  await runQueue(engineContext(env), { demoOnly: true, maxJobs: 25 });

  const event = await first(db, "SELECT id, event_type, status, reason, campaign_id, flow_id FROM webhook_events WHERE dedup_key = ?", `demo:${ev.dedupKey}`);
  const flows = await all(
    db,
    `SELECT f.id, f.campaign_id, f.state, f.state_reason, f.private_reply_status, f.public_reply_status, f.content_status, f.verify_attempts, f.last_follow_result, f.updated_at
       FROM conversation_flows f JOIN participants p ON p.id = f.participant_id
      WHERE p.account_id = ? AND p.igsid = ? ORDER BY f.id DESC LIMIT 5`,
    accountId,
    igsid,
  );
  const flowIds = flows.map((f: any) => f.id);
  const jobs = flowIds.length
    ? await all(
        db,
        `SELECT id, flow_id, kind, purpose, status, attempts, result, last_error, created_at FROM action_jobs WHERE flow_id IN (${flowIds.map(() => "?").join(",")}) ORDER BY id`,
        ...flowIds,
      )
    : [];
  return { ok: true, event, flows, jobs: jobs.map((j: any) => ({ ...j, result: j.result ? JSON.parse(j.result) : null })) };
}
