import { useState } from "react";
import { api } from "../api";
import { TEMPLATE_VARIABLES } from "../../shared/template";
import { Alert, Card, Field, Modal, PageHeader, Spinner, toast, useAsync } from "../components/ui";

const KINDS: Record<string, string> = {
  public: "رد عام",
  opening: "تمهيدي",
  follow_request: "طلب متابعة",
  reminder: "تذكير",
  final: "محتوى نهائي",
  error: "خطأ/تعذر التحقق",
  mention: "شكر المنشن",
};

export function TemplatesPage() {
  const { data, loading, error, reload } = useAsync(() => api<any[]>("/api/templates"), []);
  const [edit, setEdit] = useState<any | null>(null);

  const save = async () => {
    try {
      const body = { kind: edit.kind, name: edit.name, body: edit.body };
      if (edit.id) await api(`/api/templates/${edit.id}`, { method: "PUT", body });
      else await api("/api/templates", { body });
      toast("تم الحفظ");
      setEdit(null);
      reload();
    } catch (e: any) {
      toast(e.message, "bad");
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="القوالب" subtitle="نصوص جاهزة تُدرج في الحملات. تُرسل كنص عادي فقط." actions={<button className="btn btn-primary" onClick={() => setEdit({ kind: "public", name: "", body: "" })}>+ قالب</button>} />
      <Alert tone="info">المتغيرات: {Object.entries(TEMPLATE_VARIABLES).map(([k, v]) => `{{${k}}} (${v})`).join(" · ")} — مع نص بديل: {"{{username|يا غالي}}"}</Alert>
      {loading && !data ? <Spinner /> : error ? <Alert tone="bad">{error}</Alert> : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {data!.map((t) => (
            <Card key={t.id} title={t.name} action={<span className="surface-2 rounded-full px-2 py-0.5 text-xs">{KINDS[t.kind] ?? t.kind}</span>}>
              <p className="whitespace-pre-wrap text-sm">{t.body}</p>
              <div className="mt-3 flex gap-2">
                <button className="btn btn-ghost" onClick={() => setEdit(t)}>تعديل</button>
                <button className="btn btn-ghost text-red-600" onClick={async () => { if (confirm("حذف القالب؟")) { await api(`/api/templates/${t.id}`, { method: "DELETE" }); reload(); } }}>حذف</button>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "تعديل قالب" : "قالب جديد"}>
        {edit && (
          <div className="space-y-3">
            <Field label="النوع">
              <select className="input" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
                {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="الاسم"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="النص"><textarea className="input" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
            <button className="btn btn-primary w-full" onClick={save}>حفظ</button>
          </div>
        )}
      </Modal>
    </div>
  );
}
