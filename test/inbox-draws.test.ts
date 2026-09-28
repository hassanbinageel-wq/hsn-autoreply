import { beforeEach, describe, expect, it } from "vitest";
import { DB, makeCtx, MockMeta, resetDb, seedAccount, seedCampaign } from "./helpers";
import { refreshAvatars, AVATAR_TTL_MS } from "../src/worker/services/inbox";
import { deleteDraws, fetchBatch, pickNext } from "../src/worker/services/draws";
import { storeCard } from "../src/worker/services/cards";

const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let accountId = 0;
beforeEach(async () => {
  await resetDb();
  accountId = await seedAccount();
});

async function person(igsid: string, lastMessageAt: number | null, picAt: number | null = null) {
  await DB.prepare("INSERT INTO participants (account_id, igsid, last_message_at, profile_pic_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(accountId, igsid, lastMessageAt, picAt, Date.now(), Date.now())
    .run();
}

describe("inbox profile pictures", () => {
  it("fetches missing pictures for inbox people only, keeps only Instagram CDN URLs, and does not retry too often", async () => {
    const now = Date.now();
    await person("A", now - 1000);
    await person("B", now - 2000);
    await person("C", now - 3000);
    await person("NOINBOX", null);
    await person("FRESH", now - 500, now - 3600_000);
    const meta = new MockMeta();
    meta.profiles = {
      A: { username: "aa", profile_pic: "https://scontent-xyz.cdninstagram.com/v/t51/a.jpg?oe=1" },
      B: { profile_pic: "https://evil.example.com/b.jpg" },
      C: "no_consent",
    };
    const r = await refreshAvatars(makeCtx(meta));
    expect(r).toEqual({ checked: 3, updated: 1 });
    const rows = await DB.prepare("SELECT igsid, username, profile_pic_url, profile_pic_at FROM participants ORDER BY igsid").all<any>();
    const by = Object.fromEntries(rows.results.map((x: any) => [x.igsid, x]));
    expect(by.A).toMatchObject({ username: "aa", profile_pic_url: "https://scontent-xyz.cdninstagram.com/v/t51/a.jpg?oe=1" });
    expect(by.B.profile_pic_url).toBeNull();
    expect(by.C.profile_pic_at).toBeGreaterThan(0);
    expect(by.NOINBOX.profile_pic_at).toBeNull();
    // second call within the TTL: nothing to do
    expect(await refreshAvatars(makeCtx(meta))).toEqual({ checked: 0, updated: 0 });
    expect(AVATAR_TTL_MS).toBeGreaterThan(86_400_000);
  });
});

describe("deleting draws", () => {
  it("removes a finished draw with its entries, winners and card images", async () => {
    const cid = await seedCampaign({});
    const now = Date.now();
    const d = await DB.prepare(
      `INSERT INTO draws (campaign_id, name, source_type, media_id, winners_count, exclude_own, excluded_accounts, entry_mode, created_at, updated_at)
       VALUES (?, 'x', 'media', 'm1', 1, 1, '[]', 'per_person', ?, ?) RETURNING id`,
    )
      .bind(cid, now, now)
      .first<{ id: number }>();
    const meta = new MockMeta();
    meta.commentPages["m1"] = [[{ id: "c1", text: "hi", timestamp: new Date().toISOString(), from: { id: "U1", username: "u1" } }]];
    await fetchBatch(makeCtx(meta), d!.id);
    const p = await pickNext(DB, d!.id, "req_del_1");
    await storeCard(DB, d!.id, p.winner_id, PNG_1PX);
    await deleteDraws(DB, [d!.id]);
    for (const t of ["draws", "draw_entries", "draw_winners", "draw_cards"]) {
      expect((await DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<any>()).n).toBe(0);
    }
  });
});
