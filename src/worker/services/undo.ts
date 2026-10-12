import { all, first, run, setSetting, settingKey } from "../lib/db";
import { cancelJobsWhere } from "../engine/jobs";
import { deleteDraws } from "./draws";

/**
 * Undo of the latest admin operations (create / edit / delete of campaigns, templates, card designs, draws, settings).
 * Only the last UNDO_KEEP operations are kept so the table stays tiny. Messages already sent to Instagram can never be
 * "unsent", so sending operations are not recorded here.
 */
export const UNDO_KEEP = 10;
/** D1 rows are limited to 2 MB; larger snapshots are not kept (the operation is listed as not revertible). */
const MAX_PAYLOAD = 1_900_000;

export type UndoKind =
  | "campaign.create" | "campaign.update" | "campaign.status" | "campaign.duplicate" | "campaign.delete"
  | "template.create" | "template.update" | "template.delete"
  | "design.create" | "design.update" | "design.delete"
  | "draw.create" | "draw.update" | "draw.delete" | "draw.clear"
  | "settings.update";

export class UndoError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function recordUndo(db: D1Database, tenantId: number, actor: string, kind: UndoKind, target: string, label: string, payload: unknown): Promise<void> {
  let json: string | null = JSON.stringify(payload);
  if (json.length > MAX_PAYLOAD) json = null;
  await db.batch([
    db.prepare("INSERT INTO undo_ops (tenant_id, at, actor, kind, target, label, payload) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(tenantId, Date.now(), actor, kind, target, label, json),
    db
      .prepare(`DELETE FROM undo_ops WHERE tenant_id = ? AND id NOT IN (SELECT id FROM undo_ops WHERE tenant_id = ? ORDER BY id DESC LIMIT ${UNDO_KEEP})`)
      .bind(tenantId, tenantId),
  ]);
}

export interface UndoRow {
  id: number;
  at: number;
  actor: string;
  kind: string;
  target: string;
  label: string;
  undone_at: number | null;
  undone_by: string | null;
  revertible: boolean;
  blocked_by: number | null;
}

export async function listUndo(db: D1Database, tenantId: number): Promise<UndoRow[]> {
  const rows = await all<any>(
    db,
    `SELECT id, at, actor, kind, target, label, undone_at, undone_by, payload IS NOT NULL AS has_payload FROM undo_ops WHERE tenant_id = ? ORDER BY id DESC LIMIT ${UNDO_KEEP}`,
    tenantId,
  );
  return rows.map((r) => {
    const newer = rows.find((o) => o.id > r.id && !o.undone_at && sameTarget(o.target, r.target));
    return {
      id: r.id, at: r.at, actor: r.actor, kind: r.kind, target: r.target, label: r.label, undone_at: r.undone_at, undone_by: r.undone_by,
      revertible: !r.undone_at && !!r.has_payload && !newer,
      blocked_by: !r.undone_at && newer ? newer.id : null,
    };
  });
}

/** A whole-log clear of draws touches every draw, so it conflicts with any operation on a single draw. */
function sameTarget(a: string, b: string) {
  if (a === b) return true;
  const drawish = (t: string) => t === "draws:all" || t.startsWith("draw:");
  return (a === "draws:all" && drawish(b)) || (b === "draws:all" && drawish(a));
}

export async function stopCampaignWork(db: D1Database, campaignId: number, now: number, reason: string): Promise<number> {
  const cancelled = await cancelJobsWhere(db, "campaign_id = ? AND is_demo = 0", now, campaignId);
  await run(
    db,
    `UPDATE conversation_flows SET state = 'cancelled', state_reason = ?, updated_at = ?
     WHERE campaign_id = ? AND is_demo = 0 AND state NOT IN ('content_sent','verification_unavailable','expired','failed','cancelled')`,
    reason,
    now,
    campaignId,
  );
  return cancelled;
}

// ---- Snapshots

export interface CampaignSnapshot {
  row: Record<string, unknown>;
  keywords: Array<{ keyword: string; kind: string; match_type: string }>;
  media: string[];
}

export async function campaignSnapshot(db: D1Database, id: number): Promise<CampaignSnapshot | null> {
  const row = await first<Record<string, unknown>>(db, "SELECT * FROM campaigns WHERE id = ?", id);
  if (!row) return null;
  const keywords = await all<any>(db, "SELECT keyword, kind, match_type FROM campaign_keywords WHERE campaign_id = ? ORDER BY id", id);
  const media = (await all<{ media_id: string }>(db, "SELECT media_id FROM campaign_media WHERE campaign_id = ?", id)).map((m) => m.media_id);
  return { row, keywords, media };
}

export interface DrawSnapshot {
  draw: Record<string, unknown>;
  entries: Record<string, unknown>[];
  winners: Record<string, unknown>[];
}

export async function drawSnapshots(db: D1Database, ids: number[]): Promise<DrawSnapshot[]> {
  const out: DrawSnapshot[] = [];
  for (const id of ids) {
    const draw = await first<Record<string, unknown>>(db, "SELECT * FROM draws WHERE id = ?", id);
    if (!draw) continue;
    // Card images are not kept: they are regenerated from the design on demand.
    const entries = await all<Record<string, unknown>>(db, "SELECT * FROM draw_entries WHERE draw_id = ? ORDER BY id", id);
    const winners = await all<Record<string, unknown>>(db, "SELECT * FROM draw_winners WHERE draw_id = ? ORDER BY id", id);
    out.push({ draw, entries, winners });
  }
  return out;
}

// ---- Revert

const TABLES = new Set(["campaigns", "templates", "card_designs", "draws", "draw_entries", "draw_winners"]);
const COL = /^[a-z_][a-z0-9_]*$/;

function insertStmts(db: D1Database, table: string, rows: Record<string, unknown>[]): D1PreparedStatement[] {
  if (!TABLES.has(table) || !rows.length) return [];
  const cols = Object.keys(rows[0]).filter((k) => COL.test(k));
  // D1 allows at most 100 bound parameters per statement.
  const per = Math.max(1, Math.floor(100 / cols.length));
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    stmts.push(
      db
        // An upsert (not INSERT OR REPLACE): replacing would delete the row first and cascade to its children.
        .prepare(
          `INSERT INTO ${table} (${cols.join(",")}) VALUES ${chunk.map(() => `(${cols.map(() => "?").join(",")})`).join(",")}
           ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")}`,
        )
        .bind(...chunk.flatMap((r) => cols.map((c) => r[c] ?? null))),
    );
  }
  return stmts;
}

async function runBatches(db: D1Database, stmts: D1PreparedStatement[]) {
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}

/** Fields of a campaign that an edit changes (status / activation / deletion are separate operations). */
const CAMPAIGN_KEEP = new Set(["id", "status", "activated_at", "created_at", "deleted_at"]);

async function restoreCampaignContent(db: D1Database, snap: CampaignSnapshot, now: number) {
  const id = Number(snap.row.id);
  const exists = await first(db, "SELECT id FROM campaigns WHERE id = ?", id);
  if (!exists) throw new UndoError("gone", "الحملة لم تعد موجودة");
  const cols = Object.keys(snap.row).filter((k) => COL.test(k) && !CAMPAIGN_KEEP.has(k) && k !== "updated_at");
  await db.batch([
    db.prepare(`UPDATE campaigns SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).bind(...cols.map((k) => snap.row[k] ?? null), now, id),
    db.prepare("DELETE FROM campaign_keywords WHERE campaign_id = ?").bind(id),
    db.prepare("DELETE FROM campaign_media WHERE campaign_id = ?").bind(id),
    ...snap.keywords.map((k) => db.prepare("INSERT INTO campaign_keywords (campaign_id, keyword, kind, match_type) VALUES (?, ?, ?, ?)").bind(id, k.keyword, k.kind, k.match_type)),
    ...snap.media.map((m) => db.prepare("INSERT OR IGNORE INTO campaign_media (campaign_id, media_id) VALUES (?, ?)").bind(id, m)),
  ]);
}

/** Sets a campaign's status. Re-activation starts from now so events received meanwhile are never replayed. */
async function setCampaignStatus(db: D1Database, id: number, status: string, now: number) {
  await run(
    db,
    "UPDATE campaigns SET status = ?, activated_at = CASE WHEN ? = 'active' AND status != 'active' THEN ? ELSE activated_at END, updated_at = ? WHERE id = ?",
    status, status, now, now, id,
  );
  if (status !== "active") await stopCampaignWork(db, id, now, "campaign_undo");
}

async function softDeleteCampaign(db: D1Database, id: number, now: number) {
  await run(db, "UPDATE campaigns SET deleted_at = ?, status = 'archived', updated_at = ? WHERE id = ?", now, now, id);
  await stopCampaignWork(db, id, now, "campaign_undo");
}

export async function undoOperation(db: D1Database, tenantId: number, opId: number, actor: string): Promise<{ label: string }> {
  const list = await listUndo(db, tenantId);
  const op = list.find((o) => o.id === opId);
  if (!op) throw new UndoError("not_found", "العملية غير موجودة (يُحتفظ بآخر 10 عمليات فقط)");
  if (op.undone_at) throw new UndoError("already", "تم استرجاع هذه العملية مسبقًا");
  if (op.blocked_by) throw new UndoError("blocked", "توجد عملية أحدث على نفس العنصر — استرجعها أولًا");
  if (!op.revertible) throw new UndoError("too_large", "هذه العملية كبيرة الحجم ولم تُحفظ نسختها، لا يمكن استرجاعها");
  const row = await first<{ payload: string }>(db, "SELECT payload FROM undo_ops WHERE id = ? AND tenant_id = ?", opId, tenantId);
  const p = JSON.parse(row!.payload);
  const now = Date.now();

  switch (op.kind as UndoKind) {
    case "campaign.create":
    case "campaign.duplicate":
      await softDeleteCampaign(db, p.id, now);
      break;
    case "campaign.update":
      await restoreCampaignContent(db, p as CampaignSnapshot, now);
      break;
    case "campaign.status":
      await setCampaignStatus(db, p.id, p.status, now);
      break;
    case "campaign.delete":
      await run(db, "UPDATE campaigns SET deleted_at = NULL, status = 'paused', updated_at = ? WHERE id = ?", now, p.id);
      if (p.status === "active") await setCampaignStatus(db, p.id, "active", now);
      else await run(db, "UPDATE campaigns SET status = ? WHERE id = ?", p.status, p.id);
      break;
    case "template.create":
      await run(db, "DELETE FROM templates WHERE id = ?", p.id);
      break;
    case "template.update":
    case "template.delete":
      await runBatches(db, insertStmts(db, "templates", [p.row]));
      break;
    case "design.create":
      await run(db, "UPDATE draws SET card_design_id = NULL WHERE card_design_id = ?", p.id);
      await run(db, "DELETE FROM card_designs WHERE id = ?", p.id);
      break;
    case "design.update":
      await runBatches(db, insertStmts(db, "card_designs", [p.row]));
      break;
    case "design.delete": {
      await runBatches(db, insertStmts(db, "card_designs", [p.row]));
      const ids: number[] = p.draw_ids ?? [];
      if (ids.length) await run(db, `UPDATE draws SET card_design_id = ? WHERE id IN (${ids.map(() => "?").join(",")}) AND card_design_id IS NULL`, p.row.id, ...ids);
      break;
    }
    case "draw.create":
      await deleteDraws(db, [p.id]);
      break;
    case "draw.update": {
      const d = await first<{ status: string }>(db, "SELECT status FROM draws WHERE id = ?", p.row.id);
      if (!d) throw new UndoError("gone", "السحب لم يعد موجودًا");
      if (d.status !== "draft") throw new UndoError("locked", "تم تنفيذ السحب بعد التعديل — لا يمكن تغيير إعداداته");
      await runBatches(db, insertStmts(db, "draws", [p.row]));
      break;
    }
    case "draw.delete":
    case "draw.clear": {
      const snaps = p.draws as DrawSnapshot[];
      const stmts: D1PreparedStatement[] = [];
      for (const s of snaps) {
        const camp = await first(db, "SELECT id FROM campaigns WHERE id = ?", s.draw.campaign_id);
        if (!camp) continue;
        stmts.push(...insertStmts(db, "draws", [s.draw]), ...insertStmts(db, "draw_entries", s.entries), ...insertStmts(db, "draw_winners", s.winners));
      }
      await runBatches(db, stmts);
      break;
    }
    case "settings.update":
      for (const [k, v] of Object.entries(p.prev as Record<string, unknown>)) {
        if (v === null) await run(db, "DELETE FROM app_settings WHERE key = ?", settingKey(tenantId, k));
        else await setSetting(db, tenantId, k, v, now);
      }
      break;
    default:
      throw new UndoError("unsupported", "نوع عملية غير مدعوم");
  }
  await run(db, "UPDATE undo_ops SET undone_at = ?, undone_by = ? WHERE id = ?", now, actor, opId);
  return { label: op.label };
}
