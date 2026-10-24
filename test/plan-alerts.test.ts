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
  it("tells a customer at 85% and when the messages are used up — once each, only on their bell", async () => {
    const a = await customer("متجر أ"); // basic: 1,000 messages
    const b = await customer("متجر ب");
    await setUsage(a, 840);
    expect(await runPlanAlerts(TEST_ENV, AT)).toBe(0);
    await setUsage(a, 860);
    expect(await runPlanAlerts(TEST_ENV, AT)).toBe(1);
    expect(await runPlanAlerts(TEST_ENV, AT)).toBe(0); // not twice
    await setUsage(a, 1000);
    expect(await runPlanAlerts(TEST_ENV, AT)).toBe(1);
    const n = await notes(a);
    // 85%: a usage note; used up: the owner's ready «خلصت الرسائل» message, sent automatically
    expect(n.map((x: any) => x.kind)).toEqual(["plan", "message"]);
    expect(n[0].title).toContain("85%");
    expect(n[1].title).toContain("خلصت رسائل دورتك");
    expect(n[0].link).toBe("/subscription");
    expect(n[1].link).toBe("/subscription");
    expect(await notes(b)).toEqual([]);
    // the owner has no limits, but hears once that this customer ran out and was messaged
    expect(await notes(1)).toMatchObject([{ kind: "plan", link: "/owner?tab=customers" }]);
    // only on the scheduled minute
    await setUsage(b, 900);
    expect(await runPlanAlerts(TEST_ENV, AT + 60_000)).toBe(0);
  });

  it("messages: one note each at 85%, 90%, 95%, then the ready message at 100% — each once per cycle", async () => {
    const a = await customer("متجر أ"); // 1,000 messages
    const steps: Array<[number, number]> = [[849, 0], [850, 1], [880, 0], [900, 1], [949, 0], [950, 1], [990, 0], [1000, 1], [1000, 0]];
    for (const [used, expected] of steps) {
      await setUsage(a, used);
      expect(await runPlanAlerts(TEST_ENV, AT), `at ${used}`).toBe(expected);
    }
    // the next day changes nothing (no daily repeats)
    expect(await runPlanAlerts(TEST_ENV, AT + 86_400_000)).toBe(0);
    const n = await notes(a);
    expect(n.map((x: any) => x.kind)).toEqual(["plan", "plan", "plan", "message"]);
    expect(n.slice(0, 3).map((x: any) => x.title.match(/\d+%/)?.[0])).toEqual(["85%", "90%", "95%"]);
    expect((await notes(1)).length).toBe(1); // the owner hears once, when it ran out
  });

  it("jumping several steps sends only the highest; taking messages off can bring the notes back", async () => {
    const a = await customer("متجر أ");
    await setUsage(a, 960);
    expect(await runPlanAlerts(TEST_ENV, AT)).toBe(1);
    expect((await notes(a)).map((x: any) => x.title.match(/\d+%/)?.[0])).toEqual(["95%"]);
    // the owner takes 200 messages off: 960 of 800 = used up → the ready message
    const cy = await usageCycle(DB, a, AT);
    await DB.prepare("INSERT INTO message_credits (tenant_id, cycle_key, messages, source, created_at) VALUES (?, ?, -200, 'owner', ?)").bind(a, cy.key, AT).run();
    expect(await runPlanAlerts(TEST_ENV, AT)).toBe(1);
    expect((await notes(a)).at(-1).kind).toBe("message");
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
