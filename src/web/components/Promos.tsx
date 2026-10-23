import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { isNative, openExternal } from "../platform";
import { OFFER_THEMES, type Offer } from "../../shared/promos";
import { Icon } from "./Icon";
import { Modal, Spinner, toast } from "./ui";

/**
 * What the app shows on top of the pages for a customer: the message top-up window, the «out of messages» window
 * (owner's text), and the owner's offers in a side box with a live countdown.
 */

type Pack = { id: number; messages: number; price: number; badge: string | null };
const n = (v: number) => v.toLocaleString("en-US");
const perK = (p: Pack) => Math.round((p.price / p.messages) * 1000 * 100) / 100;

/** Sends the customer to the payment page (the browser in the Android app), then back to «اشتراكي» to check it. */
async function goPay(r: { id: number; url: string }) {
  if (isNative) {
    await openExternal(r.url);
    location.hash = `#/subscription?paid=${r.id}`;
  } else location.href = r.url;
}

/** The packs window (from the out-of-messages window, offers, or a «اشحن» link). */
export function TopupModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="اشحن رسائل إضافية">
      <TopupPicker onCancel={onClose} />
    </Modal>
  );
}

/** The packs to buy, side by side like the plans, with the total and the payment button. */
export function TopupPicker({ onCancel }: { onCancel?: () => void }) {
  const [data, setData] = useState<any>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<any>("/api/topups")
      .then((d) => {
        setData(d);
        const popular = d.packs.find((p: Pack) => p.badge) ?? d.packs[Math.floor((d.packs.length - 1) / 2)];
        setSel(popular?.id ?? null);
      })
      .catch((e) => toast(e.message, "bad"));
  }, []);
  const pack: Pack | undefined = data?.packs.find((p: Pack) => p.id === sel);
  const pay = async () => {
    if (!pack) return;
    setBusy(true);
    try {
      await goPay(await api<{ id: number; url: string }>("/api/topups/pay", { body: { pack_id: pack.id } }));
    } catch (e: any) {
      toast(e.message, "bad");
      setBusy(false);
    }
  };
  const until = data?.resets_at ? new Date(data.resets_at).toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "long" }) : null;
  return (
    <>
      {!data ? (
        <Spinner />
      ) : !data.packs.length ? (
        <p className="muted py-6 text-center text-sm">ما فيه حزم شحن متاحة لباقتك حاليًا — تقدر ترقّي باقتك من «اشتراكي».</p>
      ) : (
        <div className="space-y-4">
          <p className="muted text-sm">تنضاف لرصيدك فورًا وتصلح لين يتجدد العدّاد{until ? ` (${until})` : ""}، وتنصرف بعد رسائل باقتك.</p>
          <div className="grid gap-3 pt-2 sm:grid-cols-3" role="radiogroup" aria-label="الحزم">
            {data.packs.map((p: Pack) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={sel === p.id}
                onClick={() => setSel(p.id)}
                className={`relative flex items-center justify-between gap-3 rounded-2xl border-2 p-4 text-right transition sm:flex-col sm:justify-start sm:text-center ${sel === p.id ? "border-violet-500 bg-violet-500/5 shadow-lg shadow-violet-500/10" : "border-[var(--border)] hover:border-violet-300"}`}
              >
                {p.badge && <span className="grad absolute -top-2.5 right-1/2 translate-x-1/2 whitespace-nowrap rounded-full px-3 py-0.5 text-[11px] font-bold text-white">{p.badge}</span>}
                <span>
                  <b className="font-display block text-2xl font-extrabold tabular-nums sm:text-3xl">{n(p.messages)}</b>
                  <span className="muted text-xs">رسالة</span>
                </span>
                <span>
                  <b className="font-display block text-xl font-extrabold text-violet-700 sm:mt-1 sm:text-2xl dark:text-violet-300">{n(p.price)} ر.س</b>
                  <span className="muted text-xs">{perK(p)} ر.س لكل ألف</span>
                </span>
              </button>
            ))}
          </div>
          {pack && (
            <div className="surface-2 flex flex-wrap items-center justify-between gap-2 rounded-xl px-4 py-3 text-sm">
              <span>{n(pack.messages)} رسالة إضافية{until ? ` · تنتهي ${until}` : ""}</span>
              <b>الإجمالي: {n(pack.price)} ر.س <span className="muted font-normal">(شامل الضريبة)</span></b>
            </div>
          )}
          {data.capped ? (
            <p className="text-center text-sm text-amber-700 dark:text-amber-300">وصلت حد الشحن لهذي الدورة ({data.settings.max_per_cycle} مرات) — تقدر ترقّي باقتك.</p>
          ) : !data.card ? (
            <p className="text-center text-sm text-amber-700 dark:text-amber-300">الدفع بالبطاقة غير متاح حاليًا — تواصل معنا من «الدعم».</p>
          ) : (
            <div className="flex gap-2">
              <button className="btn btn-primary flex-1" disabled={!pack || busy} onClick={pay}>{busy ? "…" : `ادفع ${pack ? n(pack.price) : ""} ر.س عبر بوابة الدفع الآمنة`}</button>
              {onCancel && <button className="btn btn-ghost" onClick={onCancel}>لاحقًا</button>}
            </div>
          )}
          <p className="muted text-center text-xs">بطاقة · مدى · Apple Pay — تنتقل لصفحة الدفع وترجع تلقائيًا</p>
        </div>
      )}
    </>
  );
}

type Promos = { topup: { out: boolean; cycle_key: string; used: number; limit: number | null } | null; popup: { title: string; body: string; cta: string; cancel: string; icon: string | null; buy: boolean } | null; offers: Offer[] };

/** The icon on top of the out-of-messages window: the owner's image, else 📭. */
export function PopupIcon({ src }: { src?: string | null }) {
  return src ? (
    <img src={src} alt="" className="mx-auto h-16 w-16 rounded-3xl object-contain" />
  ) : (
    <div className="grad mx-auto flex h-16 w-16 items-center justify-center rounded-3xl text-3xl text-white shadow-lg shadow-violet-500/30">📭</div>
  );
}

const POPUP_KEY = "hsn.outPopup";
const CLOSED_OFFERS = "hsn.closedOffers";
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked: shown again next time */ } };

/** The customer's top layer: the out-of-messages window (once a day while out) and the offers box. */
export function PromoLayer({ route }: { route: string }) {
  const [p, setP] = useState<Promos | null>(null);
  const [popup, setPopup] = useState(false);
  const [topup, setTopup] = useState(false);
  const reloadRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => api<Promos>("/api/promos").then((d) => {
      if (stop) return;
      setP(d);
      const key = `${d.topup?.cycle_key}:${new Date().toDateString()}`;
      if (d.popup && read(POPUP_KEY) !== key) setPopup(true);
    }).catch(() => undefined);
    load();
    const t = setInterval(load, 10 * 60_000);
    const onShow = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onShow);
    reloadRef.current = load;
    return () => { stop = true; clearInterval(t); document.removeEventListener("visibilitychange", onShow); };
  }, []);
  // A new offer shows on the next page change (at most once a minute), without reopening the app.
  const lastRoute = useRef(0);
  useEffect(() => {
    if (Date.now() - lastRoute.current < 60_000) return;
    lastRoute.current = Date.now();
    if (lastRoute.current && p) reloadRef.current?.();
  }, [route]);
  // «اشحن رسائل» links (#/subscription?topup=1) open the window wherever they come from.
  useEffect(() => {
    const h = () => { if (/[?&]topup=1/.test(location.hash)) { setTopup(true); history.replaceState(null, "", location.hash.replace(/[?&]topup=1/, "")); } };
    h();
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  const closePopup = () => {
    setPopup(false);
    write(POPUP_KEY, `${p?.topup?.cycle_key}:${new Date().toDateString()}`);
  };
  return (
    <>
      {popup && p?.popup && (
        <Modal open onClose={closePopup} title="" center>
          <div className="-mt-6 space-y-3 text-center">
            <PopupIcon src={p.popup.icon} />
            <h2 className="font-display text-xl font-extrabold">{p.popup.title}</h2>
            <p className="muted whitespace-pre-line text-sm leading-relaxed">{p.popup.body}</p>
            <div className="flex gap-2 pt-2">
              <button className="btn btn-primary flex-1" onClick={() => { closePopup(); if (p.popup!.buy) setTopup(true); else location.hash = "#/subscription"; }}><Icon name="zap" size={18} />{p.popup.cta}</button>
              <button className="btn btn-ghost" onClick={closePopup}>{p.popup.cancel}</button>
            </div>
          </div>
        </Modal>
      )}
      {topup && <TopupModal onClose={() => setTopup(false)} />}
      {p?.offers.length ? <OfferBox offers={p.offers} hidden={popup || topup || route.startsWith("/campaigns/")} /> : null}
    </>
  );
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** One digit group of the countdown; the number pops when it changes. */
function Unit({ v, label }: { v: number; label: string }) {
  const s = String(v).padStart(2, "0");
  return (
    <span className="flex flex-col items-center">
      <span key={s} className="offer-tick font-display min-w-[2.3rem] rounded-lg bg-black/20 px-1.5 py-1 text-center text-lg font-extrabold tabular-nums leading-none">{s}</span>
      <span className="mt-0.5 text-[10px] font-semibold opacity-80">{label}</span>
    </span>
  );
}

export function Countdown({ to, now }: { to: number; now: number }) {
  const left = Math.max(0, to - now);
  const d = Math.floor(left / 86_400_000), h = Math.floor(left / 3_600_000) % 24, m = Math.floor(left / 60_000) % 60, s = Math.floor(left / 1000) % 60;
  return (
    <div className="flex items-start gap-1.5" dir="rtl" aria-label="الوقت المتبقي">
      {d > 0 && <Unit v={d} label="يوم" />}
      <Unit v={h} label="ساعة" />
      <Unit v={m} label="دقيقة" />
      <Unit v={s} label="ثانية" />
    </div>
  );
}

/** The offer card itself (also the owner's live preview). */
export function OfferCard({ o, now, onOpen, onClose }: { o: Pick<Offer, "title" | "body" | "cta" | "theme" | "icon" | "ends_at">; now: number; onOpen?: () => void; onClose?: () => void }) {
  const th = OFFER_THEMES[o.theme] ?? OFFER_THEMES.violet;
  return (
    <div className="offer-card relative w-full overflow-hidden rounded-3xl p-4 shadow-2xl" style={{ background: th.bg, color: th.fg }}>
      <span aria-hidden className="offer-shine pointer-events-none absolute inset-0" />
      {onClose && (
        <button type="button" onClick={onClose} aria-label="إخفاء العرض" className="absolute left-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/15 hover:bg-black/25">
          <Icon name="x" size={16} />
        </button>
      )}
      <div className="flex items-start gap-3">
        {o.icon && <span className="offer-float flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/20 text-2xl">{o.icon}</span>}
        <div className="min-w-0 flex-1 pl-6">
          <b className="font-display block text-lg font-extrabold leading-snug">{o.title}</b>
          {o.body && <p className="mt-0.5 text-sm leading-relaxed opacity-90">{o.body}</p>}
        </div>
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        <div>
          <span className="mb-1 block text-[11px] font-bold" style={{ color: th.accent }}>ينتهي العرض بعد</span>
          <Countdown to={o.ends_at} now={now} />
        </div>
        {o.cta && (
          <button type="button" onClick={onOpen} className="shrink-0 rounded-xl bg-white px-4 py-2.5 text-sm font-extrabold text-slate-900 shadow-md transition hover:scale-[1.03]">
            {o.cta}
          </button>
        )}
      </div>
    </div>
  );
}

/** Side box: slides in, one offer at a time; closing it leaves a small «عرض» tab to bring it back. */
function OfferBox({ offers, hidden }: { offers: Offer[]; hidden: boolean }) {
  const now = useNow();
  const [closed, setClosed] = useState<number[]>(() => { try { return JSON.parse(read(CLOSED_OFFERS) ?? "[]"); } catch { return []; } });
  const live = offers.filter((o) => o.ends_at > now);
  const shown = live.find((o) => !closed.includes(o.id));
  if (hidden || !live.length) return null;
  const open = (o: Offer) => {
    api(`/api/offers/${o.id}/click`, { method: "POST" }).catch(() => undefined);
    if (/^https:\/\//.test(o.link)) openExternal(o.link);
    else location.hash = `#${o.link}`;
  };
  const close = (id: number) => {
    const next = [...closed.filter((x) => live.some((o) => o.id === x)), id];
    setClosed(next);
    write(CLOSED_OFFERS, JSON.stringify(next));
  };
  if (!shown)
    return (
      <button type="button" onClick={() => { setClosed([]); write(CLOSED_OFFERS, "[]"); }} className="grad offer-tab fixed left-0 top-1/3 z-30 rounded-r-2xl px-2 py-3 text-xs font-extrabold text-white shadow-lg [writing-mode:vertical-rl]">
        🎁 عرض
      </button>
    );
  return (
    <div className="offer-in fixed inset-x-3 bottom-[calc(9.5rem+env(safe-area-inset-bottom))] z-30 sm:inset-x-auto sm:left-6 sm:w-[340px] lg:bottom-24">
      <OfferCard key={shown.id} o={shown} now={now} onOpen={() => open(shown)} onClose={() => close(shown.id)} />
    </div>
  );
}
