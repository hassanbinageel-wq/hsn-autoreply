import { beforeEach, describe, expect, it } from "vitest";
import { DB, TEST_ENV, resetDb } from "./helpers";
import { wantsPublishScope, withSchedulingNotice } from "../src/worker/services/publish";

const DAY = 86_400_000;
async function tenant(plan: string): Promise<number> {
  const now = Date.now();
  const r = await DB.prepare("INSERT INTO tenants (name, plan_id, plan_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id").bind(`t-${plan}`, plan, now + 30 * DAY, now, now).first<{ id: number }>();
  return r!.id;
}
const mode = (m: string) => DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('publish_scope', ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(m)).run();

describe("publishing permission requested by plan", () => {
  beforeEach(async () => {
    await resetDb();
    await DB.prepare("UPDATE plans SET limits = json_set(limits, '$.scheduling', json(?)) WHERE id = 'max'").bind("true").run();
    await DB.prepare("UPDATE plans SET limits = json_set(limits, '$.scheduling', json(?)) WHERE id = 'basic'").bind("false").run();
  });

  it("automatic mode asks only customers whose active plan includes scheduling (and the owner)", async () => {
    const withIt = await tenant("max");
    const without = await tenant("basic");
    await mode("all");
    expect(await wantsPublishScope(DB, 1)).toBe(true);
    expect(await wantsPublishScope(DB, withIt)).toBe(true);
    expect(await wantsPublishScope(DB, without)).toBe(false);
    // expired plan: not asked
    await DB.prepare("UPDATE tenants SET plan_expires_at = ? WHERE id = ?").bind(Date.now() - DAY, withIt).run();
    expect(await wantsPublishScope(DB, withIt)).toBe(false);
  });

  it("owner-only and off modes", async () => {
    const withIt = await tenant("max");
    await mode("owner");
    expect(await wantsPublishScope(DB, 1)).toBe(true);
    expect(await wantsPublishScope(DB, withIt)).toBe(false);
    await mode("off");
    expect(await wantsPublishScope(DB, 1)).toBe(false);
    expect(await wantsPublishScope(DB, withIt)).toBe(false);
  });
});

describe("bell message when a plan upgrade adds scheduling", () => {
  const bell = (tid: number) => DB.prepare("SELECT title, body FROM app_notifications WHERE tenant_id = ? AND kind = 'message'").bind(tid).all<any>().then((r) => r.results);
  const account = async (tid: number, scopes: string[]) => {
    const now = Date.now();
    await DB.prepare("INSERT INTO instagram_accounts (tenant_id, ig_user_id, username, status, scopes, token_ciphertext, token_iv, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, 'x', 'y', ?, ?)")
      .bind(tid, `ig_${tid}_${now}`, `u${tid}`, JSON.stringify(scopes), now, now).run();
  };
  const setPlan = (tid: number, plan: string) => () => DB.prepare("UPDATE tenants SET plan_id = ? WHERE id = ?").bind(plan, tid).run();

  beforeEach(async () => {
    await resetDb();
    await DB.prepare("UPDATE plans SET limits = json_set(limits, '$.scheduling', json(?)) WHERE id = 'max'").bind("true").run();
    await DB.prepare("UPDATE plans SET limits = json_set(limits, '$.scheduling', json(?)) WHERE id = 'basic'").bind("false").run();
    await mode("all");
  });

  it("tells a connected customer without the permission how to re-connect; only that customer, only on the upgrade", async () => {
    const a = await tenant("basic");
    const b = await tenant("basic");
    await account(a, ["instagram_business_basic"]);
    await account(b, ["instagram_business_basic"]);
    await withSchedulingNotice(TEST_ENV, a, setPlan(a, "max"));
    const msgs = await bell(a);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toContain("إعادة الاتصال");
    expect(msgs[0].body).toContain("السماح");
    expect(await bell(b)).toHaveLength(0);
    // already on scheduling: renewing does not repeat it
    await withSchedulingNotice(TEST_ENV, a, setPlan(a, "max"));
    expect(await bell(a)).toHaveLength(1);
  });

  it("no message when the permission is already there, no account is connected, or the plan has no scheduling", async () => {
    const granted = await tenant("basic");
    await account(granted, ["instagram_business_basic", "instagram_business_content_publish"]);
    const noAccount = await tenant("basic");
    const stays = await tenant("basic");
    await account(stays, []);
    await withSchedulingNotice(TEST_ENV, granted, setPlan(granted, "max"));
    await withSchedulingNotice(TEST_ENV, noAccount, setPlan(noAccount, "max"));
    await withSchedulingNotice(TEST_ENV, stays, setPlan(stays, "basic"));
    expect(await bell(granted)).toHaveLength(0);
    expect(await bell(noAccount)).toHaveLength(0);
    expect(await bell(stays)).toHaveLength(0);
  });
});
