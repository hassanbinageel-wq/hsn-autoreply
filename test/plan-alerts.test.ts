import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, seedAccount, TEST_ENV } from "./helpers";
import { broadcastNotice, runPlanAlerts } from "../src/worker/services/notify";
import { usageCycle } from "../src/worker/services/plans";

// a cron minute on which the plan check runs (minute % 10 === 3)
const AT = Date.UTC(2026, 9, 18, 12, 3);

async function customer(name: string, plan = "basic") {
  const t = await DB.prepare("INSERT INTO tenants (name, is_owner, status, plan_id, plan_started_at, plan_expires_at, created_at, updated_at) VALUES (?, 0, 'active', ?, ?, ?, ?, ?) RETURNING id")
    .bind(name, plan, AT - 86_400_000, AT + 30 * 86_400_000, AT, AT)
    .first<any>();
  return t.id as number;
}
const notes = async (t: number) => (await DB.prepare("SELECT kind, title, link FROM app_notifications WHERE tenant_id = ? ORDER BY id").bind(t).all<any>()).results;
const setUsage = async (t: number, n: number) =>
  DB.prepare("INSERT INTO usage_counters (tenant_id, month, messages) VALUES (?, ?, ?) ON CONFLICT(tenant_id, month) DO UPDATE SET messages = excluded.messages").bind(t, (await usageCycle(DB, t, AT)).key, n).run();

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

describe("customer notifications: own plan usage, owner notices", () => {
  it("tells a customer at 80% and when the monthly messages are used up — once each, only on their bell", async () => {
    const a = await customer("متجر أ"); // basic: 1,000 messages
    const b = await customer("متجر ب");
    await setUsage(a, 700);
    expect(await runPlanAlerts(TEST_ENV, AT)).toBe(0);
    await setUsage(a, 820);
    expect(await runPlanAlerts(TEST_ENV, AT)).toBe(1);
    expect(await runPlanAlerts(TEST_ENV, AT)).toBe(0); // not twice
    await setUsage(a, 1000);
    expect(await runPlanAlerts(TEST_ENV, AT)).toBe(1);
    const n = await notes(a);
    expect(n.map((x: any) => x.kind)).toEqual(["plan", "plan"]);
    expect(n[0].title).toContain("82%");
    expect(n[1].title).toContain("خلصت");
    expect(n[0].link).toBe("/subscription");
    expect(await notes(b)).toEqual([]);
    expect(await notes(1)).toEqual([]); // the owner has no limits
    // only on the scheduled minute
    await setUsage(b, 900);
    expect(await runPlanAlerts(TEST_ENV, AT + 60_000)).toBe(0);
  });

  it("an owner notice reaches every active customer, not the owner or suspended customers", async () => {
    const a = await customer("أ");
    const s = await customer("موقوف");
    await DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(s).run();
    expect(await broadcastNotice(DB, "🛠️ صيانة مجدولة", "من 2 إلى 3")).toBe(1);
    expect(await notes(a)).toMatchObject([{ kind: "service", title: "🛠️ صيانة مجدولة" }]);
    expect(await notes(s)).toEqual([]);
    expect(await notes(1)).toEqual([]);
  });
});
