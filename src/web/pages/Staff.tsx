import { useState } from "react";
import { api } from "../api";
import { askConfirm, showCopy } from "../components/Confirm";
import { Icon } from "../components/Icon";
import { Alert, Card, Empty, Field, Modal, PageHeader, Spinner, Toggle, fmtTime, toast, useAsync } from "../components/ui";

/**
 * The account holder's staff: logins limited to the sections they choose (the server enforces it on every
 * request). Each staff member signs in with their own name and password; their actions show in the audit log.
 */
type Perm = { key: string; label: string; hint: string; ownerOnly?: boolean };
type StaffRow = { id: number; username: string; display_name: string | null; perms: string[]; disabled_at: number | null; created_at: number; last_seen: number | null; totp: number };

function genPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => chars[b % chars.length]).join("");
}

export function StaffPage() {
  const { data, reload } = useAsync(() => api<{ staff: StaffRow[]; available: Perm[]; max: number }>("/api/staff"), []);
  const [editing, setEditing] = useState<StaffRow | "new" | null>(null);
  if (!data) return <Spinner />;
  const label = (k: string) => data.available.find((p) => p.key === k)?.label ?? k;
  return (
    <div className="space-y-5">
      <PageHeader
        title="الموظفين"
        subtitle="أضف موظف يدخل بحسابه الخاص، وحدد له الأقسام اللي يشتغل عليها بس — ما يشوف الإعدادات ولا الربط ولا الاشتراك."
        actions={<button className="btn btn-primary" disabled={data.staff.length >= data.max} onClick={() => setEditing("new")}><Icon name="plus" size={17} />موظف جديد</button>}
      />
      {data.max === 0 && (
        <Alert tone="info">إضافة الموظفين متاحة في الباقات الأعلى — <a href="#/subscription" className="font-bold underline">شوف الباقات من «اشتراكي»</a>.</Alert>
      )}
      {!data.staff.length ? (
        <Empty title="ما فيه موظفين بعد">مثلًا: موظف يرد على الرسائل بس، أو مسوّق يجهّز الحملات والجدولة.</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.staff.map((s) => (
            <Card
              key={s.id}
              title={<span className="flex items-center gap-2">{s.display_name ?? s.username}{s.disabled_at ? <span className="chip surface-2 muted !py-0 text-[10.5px]">موقوف</span> : null}</span>}
              action={<button className="btn btn-ghost min-h-9 text-xs" onClick={() => setEditing(s)}>تعديل</button>}
            >
              <div className="muted space-y-1 text-xs">
                <div>اسم الدخول: <b className="text-[var(--text)]" dir="ltr">{s.username}</b>{s.totp ? " · 🔐 تحقق بخطوتين" : ""}</div>
                <div>آخر دخول: <b className="text-[var(--text)]">{s.last_seen ? fmtTime(s.last_seen) : "ما دخل بعد"}</b></div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {s.perms.map((p) => <span key={p} className="chip bg-violet-500/10 text-[11px] text-violet-700 dark:text-violet-300">{label(p)}</span>)}
              </div>
            </Card>
          ))}
        </div>
      )}
      <p className="muted text-xs">{data.max ? `باقتك تسمح بـ ${data.max} ${data.max === 1 ? "موظف" : "موظفين"} (عندك ${data.staff.length}).` : ""} كل اللي يسويه الموظف يتسجل باسمه في «السجل».</p>
      {editing && <StaffModal row={editing === "new" ? null : editing} available={data.available} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function StaffModal({ row, available, onClose, onDone }: { row: StaffRow | null; available: Perm[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(row?.display_name ?? "");
  const [username, setUsername] = useState("");
  const [perms, setPerms] = useState<string[]>(row?.perms ?? []);
  const [busy, setBusy] = useState(false);
  const toggle = (k: string) => setPerms(perms.includes(k) ? perms.filter((x) => x !== k) : [...perms, k]);
  const save = async () => {
    setBusy(true);
    try {
      if (row) {
        await api(`/api/staff/${row.id}`, { method: "PUT", body: { display_name: name, perms } });
        toast("تم الحفظ — الصلاحيات تتطبق فورًا");
        onDone();
      } else {
        const password = genPassword();
        await api("/api/staff", { body: { username, display_name: name, password, perms } });
        await showCopy({ title: "تم إضافة الموظف ✅", message: `أرسل له بيانات الدخول. كلمة المرور ما راح تظهر مرة ثانية، ويقدر يغيّرها بعدين من «نسيت كلمة المرور» بعد ما يضيف إيميله.`, text: `اسم الدخول: ${username}\nكلمة المرور: ${password}\nالرابط: ${location.origin}` });
        onDone();
      }
    } catch (e: any) {
      toast(e.message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      onDone();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };
  const ownerPerms = available.filter((p) => p.ownerOnly);
  const appPerms = available.filter((p) => !p.ownerOnly);
  const box = (p: Perm) => (
    <label key={p.key} className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${perms.includes(p.key) ? "border-violet-400 bg-violet-500/10" : "border-[var(--border)]"}`}>
      <input type="checkbox" className="mt-1" checked={perms.includes(p.key)} onChange={() => toggle(p.key)} />
      <span><b className="block">{p.label}</b><span className="muted text-xs">{p.hint}</span></span>
    </label>
  );
  return (
    <Modal open onClose={onClose} title={row ? `تعديل «${row.display_name ?? row.username}»` : "موظف جديد"} center>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pe-1">
        <Field label="اسم الموظف" hint="يظهر في التطبيق وفي السجل"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>
        {!row && (
          <Field label="اسم الدخول" hint="بالإنجليزي بدون مسافات، مثل: sara.support — يدخل فيه من نفس صفحة الدخول">
            <input className="input" dir="ltr" value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))} maxLength={64} placeholder="sara.support" />
          </Field>
        )}
        <div>
          <div className="mb-1.5 text-sm font-bold">الأقسام المسموحة</div>
          <div className="grid gap-2 sm:grid-cols-2">{appPerms.map(box)}</div>
          {ownerPerms.length > 0 && (
            <>
              <div className="mb-1.5 mt-3 text-sm font-bold">لوحة إدارة الخدمة</div>
              <div className="grid gap-2 sm:grid-cols-2">{ownerPerms.map(box)}</div>
            </>
          )}
        </div>
        <Alert tone="info">ما يقدر أي موظف يدخل الإعدادات أو الربط أو الاشتراك أو يضيف موظفين — هذي لك بس.</Alert>
        {row && (
          <div className="space-y-2 border-t border-[var(--border)] pt-3">
            <Toggle checked={!row.disabled_at} onChange={(v) => act(() => api(`/api/staff/${row.id}`, { method: "PUT", body: { disabled: !v } }), v ? "تم تفعيل الموظف" : "تم إيقاف الموظف وتسجيل خروجه")} label={row.disabled_at ? "موقوف" : "فعّال"} description="الإيقاف يسجّل خروجه فورًا ويمنعه من الدخول" />
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-ghost text-xs" onClick={async () => {
                if (!(await askConfirm({ title: "كلمة مرور جديدة؟", message: "يُسجَّل خروجه من كل الأجهزة.", confirmLabel: "تعيين" }))) return;
                const pw = genPassword();
                act(() => api(`/api/staff/${row.id}/password`, { body: { password: pw } }).then(() => showCopy({ title: "كلمة المرور الجديدة", message: "أرسلها للموظف — ما راح تظهر مرة ثانية.", text: pw })), "تم تعيين كلمة مرور جديدة");
              }}><Icon name="lock" size={15} />كلمة مرور جديدة</button>
              <button className="btn btn-ghost text-xs text-red-600" onClick={async () => {
                if (await askConfirm({ title: `حذف «${row.display_name ?? row.username}»؟`, message: "ينحذف حسابه ويطلع من كل الأجهزة. سجل عملياته يبقى.", confirmLabel: "حذف", danger: true }))
                  act(() => api(`/api/staff/${row.id}`, { method: "DELETE" }), "تم حذف الموظف");
              }}>حذف الموظف</button>
            </div>
          </div>
        )}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button className="btn btn-ghost" onClick={onClose}>إلغاء</button>
        <button className="btn btn-primary" disabled={busy || name.trim().length < 2 || !perms.length || (!row && username.length < 3)} onClick={save}>{busy ? "…" : row ? "حفظ" : "إضافة"}</button>
      </div>
    </Modal>
  );
}
