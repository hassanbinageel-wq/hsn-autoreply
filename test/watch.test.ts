import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, seedAccount, TEST_ENV } from "./helpers";
import { runSystemWatch, systemAlerts } from "../src/worker/services/watch";

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

  it("notices Meta going silent after a busy day", async () => {
    const t0 = at(Date.now());
    for (let i = 0; i < 30; i++)
      await DB.prepare("INSERT INTO webhook_events (dedup_key, account_ig_id, event_type, payload, event_time, received_at, status) VALUES (?, 'x', 'comment', '{}', ?, ?, 'processed')")
        .bind(`e${i}`, t0 - 10 * 3_600_000, t0 - 10 * 3_600_000 + i * 60_000)
        .run();
    expect(await runSystemWatch(TEST_ENV, t0)).toBe("alert");
    expect((await systemAlerts(DB))[0].body).toContain("ما وصل أي تعليق");
  });
});
