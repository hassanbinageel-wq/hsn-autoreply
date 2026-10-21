import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, seedAccount, seedCampaign } from "./helpers";
import { countMessage, cycleOf, drawsThisMonth, extendPlan, monthlyMessages, usageCycle } from "../src/worker/services/plans";

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 25, 10); // 25 October
async function tenant(started: number, expires: number): Promise<number> {
  const r = await DB.prepare("INSERT INTO tenants (name, plan_id, plan_started_at, plan_expires_at, created_at, updated_at) VALUES ('t', 'basic', ?, ?, ?, ?) RETURNING id").bind(started, expires, started, started).first<{ id: number }>();
  return r!.id;
}

describe("usage counters follow the subscription, not the calendar month", () => {
  beforeEach(resetDb);

  it("the counter does not reset on the 1st of the month; it renews 30 days after the subscription started", async () => {
    const t = await tenant(START, START + 90 * DAY);
    await countMessage(DB, t, START + DAY);
    await countMessage(DB, t, START + 2 * DAY);
    // 1 November: same cycle
    expect(await monthlyMessages(DB, t, Date.UTC(2026, 10, 1, 12))).toBe(2);
    expect((await usageCycle(DB, t, START + DAY)).resets_at).toBe(START + 30 * DAY);
    // day 30 → a new cycle
    expect(await monthlyMessages(DB, t, START + 30 * DAY + 1)).toBe(0);
  });

  it("no renewal without a subscription: when the plan ends first, the reset waits for the renewal", () => {
    const c = cycleOf(START, START + 30 * DAY, START + 5 * DAY);
    expect(c.resets_at).toBeNull();
    expect(cycleOf(START, START + 365 * DAY, START + 5 * DAY).resets_at).toBe(START + 30 * DAY);
  });

  it("renewing early keeps the cycle (no early reset); a new subscription after expiry starts a fresh counter", async () => {
    const t = await tenant(START, START + 30 * DAY);
    await countMessage(DB, t, START + 10 * DAY);
    await extendPlan(DB, t, "basic", 30, START + 20 * DAY);
    expect(await monthlyMessages(DB, t, START + 21 * DAY)).toBe(1);
    // expired, then subscribes again later: new cycle from that day
    const u = await tenant(START, START + 30 * DAY);
    await countMessage(DB, u, START + 10 * DAY);
    await extendPlan(DB, u, "basic", 30, START + 45 * DAY);
    expect(await monthlyMessages(DB, u, START + 46 * DAY)).toBe(0);
    expect((await usageCycle(DB, u, START + 46 * DAY)).start).toBe(START + 45 * DAY);
  });

  it("draws are counted per cycle too", async () => {
    const t = await tenant(START, START + 90 * DAY);
    await seedAccount();
    const camp = await seedCampaign();
    const draw = (at: number) =>
      DB.prepare("INSERT INTO draws (tenant_id, campaign_id, name, source_type, media_id, winners_count, created_at, updated_at) VALUES (?, ?, 'سحب', 'media', 'm1', 1, ?, ?)").bind(t, camp, at, at).run();
    await draw(START + 2 * DAY);
    await draw(START + 31 * DAY);
    expect(await drawsThisMonth(DB, t, START + 10 * DAY)).toBe(1);
    expect(await drawsThisMonth(DB, t, Date.UTC(2026, 10, 2))).toBe(1); // still the first cycle on 2 Nov
    expect(await drawsThisMonth(DB, t, START + 32 * DAY)).toBe(1);
  });
});
