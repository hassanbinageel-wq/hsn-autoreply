import { beforeEach, describe, expect, it } from "vitest";
import { DB, TEST_ENV, resetDb } from "./helpers";
import { runWelcomeMessages } from "../src/worker/services/welcome";

const MIN = 60_000;
async function tenant(name: string, createdAt: number, plan: string | null): Promise<number> {
  const r = await DB.prepare("INSERT INTO tenants (name, plan_id, plan_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id").bind(name, plan, plan ? createdAt + 30 * 86_400_000 : null, createdAt, createdAt).first<{ id: number }>();
  return r!.id;
}
const bell = (tid: number) => DB.prepare("SELECT title, body FROM app_notifications WHERE tenant_id = ? AND kind = 'message'").bind(tid).all<any>().then((r) => r.results);

describe("welcome message after sign-up", () => {
  beforeEach(resetDb);

  it("arrives ~5 minutes after sign-up, once, with the name and plan filled in; not before, not without a plan", async () => {
    const now = Date.now();
    const fresh = await tenant("متجر نورة", now - 2 * MIN, "basic");
    const due = await tenant("متجر سارة", now - 6 * MIN, "basic");
    const noPlan = await tenant("متجر بدون باقة", now - 10 * MIN, null);
    expect(await runWelcomeMessages(TEST_ENV, now)).toBe(1);
    const msgs = await bell(due);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].title).toContain("شكرًا لك");
    expect(msgs[0].body).toContain("متجر سارة");
    expect(msgs[0].body).not.toContain("{الاسم}");
    expect(await bell(fresh)).toHaveLength(0);
    expect(await bell(noPlan)).toHaveLength(0);
    // once only
    expect(await runWelcomeMessages(TEST_ENV, now + MIN)).toBe(0);
    // the card customer gets it once the plan is active; the fresh one 5 minutes in
    await DB.prepare("UPDATE tenants SET plan_id = 'pro' WHERE id = ?").bind(noPlan).run();
    expect(await runWelcomeMessages(TEST_ENV, now + 4 * MIN)).toBe(2);
    expect(await bell(noPlan)).toHaveLength(1);
    expect(await bell(fresh)).toHaveLength(1);
  });
});
