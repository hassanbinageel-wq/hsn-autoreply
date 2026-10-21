import { useEffect, useRef, useState } from "react";
import { Modal } from "./ui";

/**
 * In-app replacements for window.confirm / window.prompt: same look as the rest of the app (also inside the Android
 * WebView), buttons that say what they do, and a red button for anything that cannot be undone.
 */
type Choice = { label: string; value: string; danger?: boolean };
type Request =
  | { kind: "confirm"; title: string; message?: string; confirmLabel: string; cancelLabel?: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: "choice"; title: string; message?: string; choices: Choice[]; cancelLabel?: string; resolve: (v: string | null) => void }
  | { kind: "text"; title: string; message?: string; label: string; expect?: string; initial?: string; confirmLabel: string; danger?: boolean; resolve: (v: string | null) => void }
  | { kind: "copy"; title: string; message?: string; text: string; resolve: () => void };

let push: ((r: Request) => void) | null = null;
const fallback = <T,>(v: T) => Promise.resolve(v);

export function askConfirm(o: { title: string; message?: string; confirmLabel: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
  if (!push) return fallback(window.confirm([o.title, o.message].filter(Boolean).join("\n\n")));
  return new Promise((resolve) => push!({ kind: "confirm", ...o, resolve }));
}
/** Several labelled actions (e.g. "disconnect only" / "disconnect and delete data"); null = cancelled. */
export function askChoice(o: { title: string; message?: string; choices: Choice[]; cancelLabel?: string }): Promise<string | null> {
  if (!push) return fallback(null);
  return new Promise((resolve) => push!({ kind: "choice", ...o, resolve }));
}
/** Typed confirmation: the action button stays disabled until the person types `expect` exactly. */
export function askText(o: { title: string; message?: string; label: string; expect?: string; initial?: string; confirmLabel: string; danger?: boolean }): Promise<string | null> {
  if (!push) return fallback(window.prompt([o.title, o.message].filter(Boolean).join("\n\n")));
  return new Promise((resolve) => push!({ kind: "text", ...o, resolve }));
}
/** Shows a value once with a copy button (e.g. a new password to hand to a customer). */
export function showCopy(o: { title: string; message?: string; text: string }): Promise<void> {
  if (!push) return fallback(undefined);
  return new Promise((resolve) => push!({ kind: "copy", ...o, resolve }));
}

export function ConfirmHost() {
  const [r, setR] = useState<Request | null>(null);
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    push = (req) => {
      setText(req.kind === "text" ? (req.initial ?? "") : "");
      setCopied(false);
      setR(req);
    };
    return () => {
      push = null;
    };
  }, []);
  useEffect(() => {
    if (r && r.kind !== "text") setTimeout(() => first.current?.focus(), 30);
  }, [r]);
  if (!r) return null;
  const close = (v: any) => {
    setR(null);
    (r.resolve as (x: any) => void)(v);
  };
  const cancelValue = r.kind === "confirm" ? false : r.kind === "copy" ? undefined : null;
  const btn = (danger?: boolean) => `btn ${danger ? "bg-red-600 text-white hover:bg-red-700" : "btn-primary"}`;
  return (
    <Modal open center onClose={() => close(cancelValue)} title={r.title}>
      <div className="space-y-4">
        {r.message && <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--text-2)]">{r.message}</p>}
        {r.kind === "confirm" && (
          <div className="flex flex-wrap-reverse justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => close(false)}>{r.cancelLabel ?? "تراجع"}</button>
            <button type="button" ref={first} className={btn(r.danger)} onClick={() => close(true)}>{r.confirmLabel}</button>
          </div>
        )}
        {r.kind === "choice" && (
          <div className="grid gap-2">
            {r.choices.map((c, i) => (
              <button key={c.value} type="button" ref={i === 0 ? first : undefined} className={c.danger ? `${btn(true)} w-full` : "btn btn-ghost w-full"} onClick={() => close(c.value)}>{c.label}</button>
            ))}
            <button type="button" className="btn btn-ghost w-full" onClick={() => close(null)}>{r.cancelLabel ?? "تراجع"}</button>
          </div>
        )}
        {r.kind === "text" && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!r.expect || text.trim() === r.expect) close(text.trim());
            }}
          >
            <label className="block text-sm font-semibold" htmlFor="confirm-text">{r.label}</label>
            <input id="confirm-text" className="input" autoFocus autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex flex-wrap-reverse justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => close(null)}>تراجع</button>
              <button type="submit" className={btn(r.danger)} disabled={r.expect ? text.trim() !== r.expect : !text.trim()}>{r.confirmLabel}</button>
            </div>
          </form>
        )}
        {r.kind === "copy" && (
          <>
            <div className="surface-2 select-all break-all rounded-xl px-3 py-2.5 font-mono text-sm" dir="ltr">{r.text}</div>
            <div className="flex flex-wrap-reverse justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => close(undefined)}>تم</button>
              <button
                type="button"
                ref={first}
                className="btn btn-primary"
                onClick={() => navigator.clipboard?.writeText(r.text).then(() => setCopied(true), () => setCopied(false))}
              >
                {copied ? "تم النسخ ✅" : "نسخ"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
