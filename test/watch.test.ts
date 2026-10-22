import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, seedAccount, seedCampaign, TEST_ENV } from "./helpers";
import { checkSilence, runSystemWatch, systemAlerts } from "../src/worker/services/watch";

const TICK = 600_000;
const at = (base: number, plusMin = 0) => Math.floor(base / TICK) * TICK + 5 * 60_000 + plusMin * 60_000;

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

async function failedJobs(n: number, when: number) {
  const acc = await DB.prepare("SELECT id FROM instagram_accounts").first<any>();
  for (let i = 0; i < n; i++)
    await DB.prepare("INSERT INTO action_jobs (account_id, kind, dedup_key, status, run_at, last_error, created_at, updated_at) VALUES (?, 'send_dm', ?, 'failed', ?, ?, ?, ?)")
      .bind(acc.id, `j${when}-${i}`, when, `(#2) Service temporarily unavailable ${"Z".repeat(40)}`, when, when)
      .run();
}

describe("system-wide alerts to the owner", () => {
  it("alerts once when sends fail across the service, stays quiet while it lasts, says when it is back", async () => {
    const t0 = at(Date.now());
    expect(await runSystemWatch(TEST_ENV, t0)).toBeNull();
    expect(await runSystemWatch(TEST_ENV, t0 + 60_000)).toBeNull(); // not a check minute

    await failedJobs(16, t0 - 60_000);
    expect(await runSystemWatch(TEST_ENV, t0)).toBe("alert");
    const [a] = await systemAlerts(DB);
    expect(a.title).toContain("مشكلة عامة");
    expect(a.body).toContain("16 فشل");
    expect(a.body).toContain("Service temporarily unavailable");
    expect(a.body).not.toContain("Z".repeat(40));

    await failedJobs(16, t0 + 9 * 60_000);
    expect(await runSystemWatch(TEST_ENV, t0 + 10 * 60_000)).toBeNull(); // same problem, already told
    expect(await runSystemWatch(TEST_ENV, t0 + 60 * 60_000)).toBe("recovered");
    const notes = await systemAlerts(DB);
    expect(notes).toHaveLength(2);
    expect(notes[1].title).toContain("رجعت الخدمة طبيعية");
  });

  it("a few failures at one customer are not a service problem", async () => {
    const t0 = at(Date.now());
    await failedJobs(9, t0 - 60_000);
    expect(await runSystemWatch(TEST_ENV, t0)).toBeNull();
  });

  it("a quiet spell is not a service problem: a calm note only when the same hours are usually busy, once a day, and it can be turned off", async () => {
    const t0 = at(Date.now());
    const ev = (key: string, when: number) =>
      DB.prepare("INSERT INTO webhook_events (dedup_key, account_ig_id, event_type, payload, event_time, received_at, status) VALUES (?, 'x', 'comment', '{}', ?, ?, 'processed')").bind(key, when, when).run();
    const notes = () => DB.prepare("SELECT kind, title FROM app_notifications WHERE tenant_id = 1 ORDER BY id").all<any>().then((r) => r.results);
    // busy only yesterday (the old rule fired here): no note, no «مشكلة عامة»
    for (let i = 0; i < 30; i++) await ev(`y${i}`, t0 - 10 * 3_600_000 + i * 60_000);
    await seedCampaign();
    expect(await checkSilence(TEST_ENV, t0)).toBe(false);
    expect(await runSystemWatch(TEST_ENV, t0)).toBeNull();
    expect(await notes()).toHaveLength(0);
    // the same hours were busy on 5 of the last 7 days, nothing for 6 hours → one calm note
    for (let d = 1; d <= 5; d++) for (let i = 0; i < 4; i++) await ev(`d${d}-${i}`, t0 - d * 86_400_000 - 2 * 3_600_000 + i * 60_000);
    expect(await checkSilence(TEST_ENV, t0)).toBe(true);
    expect(await checkSilence(TEST_ENV, t0 + 3_600_000)).toBe(false); // once a day
    const n = await notes();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ kind: "usage" });
    expect(n[0].title).toContain("هدوء غير معتاد");
    expect(n[0].title).not.toContain("مشكلة عامة");
    // the owner turns it off
    await DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('silence_alert', 'false', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    expect(await checkSilence(TEST_ENV, t0 + 2 * 86_400_000)).toBe(false);
  });
});
