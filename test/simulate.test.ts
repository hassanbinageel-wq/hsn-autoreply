import { beforeEach, describe, expect, it } from "vitest";
import { DB, TEST_ENV, resetDb, seedCampaign } from "./helpers";
import { simulate } from "../src/worker/services/simulate";
import { simulateSchema } from "../src/shared/schemas";

beforeEach(async () => {
  await resetDb();
});

describe("simulator", () => {
  it("a chosen campaign limited to specific posts is simulated on one of its posts (not ignored as out of scope)", async () => {
    const cid = await seedCampaign({ scope: "selected", media_ids: ["reel_course_1"], status: "draft" } as any);
    const r: any = await simulate(TEST_ENV, simulateSchema.parse({ campaign_id: cid, event: "comment", text: "أبغى الكورس", participant: "sim_user", reset: true }));
    const flat = JSON.stringify(r);
    expect(flat).not.toContain("media_not_in_scope");
    const ev = await DB.prepare("SELECT reason, status FROM webhook_events ORDER BY id DESC LIMIT 1").first<any>();
    expect(ev?.reason ?? "").not.toBe("media_not_in_scope");
    const flows = await DB.prepare("SELECT COUNT(*) AS n FROM conversation_flows WHERE campaign_id = ?").bind(cid).first<any>();
    expect(flows.n).toBe(1);
  });
});
