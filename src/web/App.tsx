import { Suspense, lazy, useCallback, useEffect, useRef, useState, type AnchorHTMLAttributes, type ComponentType, type ReactNode } from "react";
import { api, setCsrf, setUnauthorizedHandler } from "./api";
import { deviceToken, initNative, isNative, watchNetwork } from "./platform";
import { Alert, Modal, Spinner, ToastHost, setTz, toast } from "./components/ui";
import { FEATURE_LABELS, type PlanLimits } from "../shared/plans";
import { enableBio, takeBioOffer } from "./lib/biometric";
import { Icon } from "./components/Icon";
import { AccountAvatar } from "./components/UserAvatar";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { CampaignsPage } from "./pages/Campaigns";

// Every other screen loads on first visit, so sign-in and the dashboard download only what they need.
// A tab left open across a release may ask for a chunk that no longer exists: reload once to get the new files.
const lazyPage = <K extends string>(load: () => Promise<Record<K, ComponentType<any>>>, name: K) =>
  lazy(() =>
    load().then(
      (m) => {
        try { sessionStorage.removeItem("hsn.chunkReload"); } catch { /* storage blocked */ }
        return { default: m[name] };
      },
      (e) => {
        let again = false;
        try { again = !sessionStorage.getItem("hsn.chunkReload"); sessionStorage.setItem("hsn.chunkReload", "1"); } catch { /* storage blocked */ }
        if (again) location.reload();
        throw e;
      },
    ),
  );
const ConnectionPage = lazyPage(() => import("./pages/Connection"), "ConnectionPage");
const MediaPage = lazyPage(() => import("./pages/Media"), "MediaPage");
const CampaignWizard = lazyPage(() => import("./pages/CampaignWizard"), "CampaignWizard");
const CampaignStatsPage = lazyPage(() => import("./pages/CampaignStats"), "CampaignStatsPage");
const InboxPage = lazyPage(() => import("./pages/Inbox"), "InboxPage");
const DrawsHomePage = lazyPage(() => import("./pages/Draws"), "DrawsHomePage");
const DrawPage = lazyPage(() => import("./pages/Draws"), "DrawPage");
const CardDesignsPage = lazyPage(() => import("./pages/CardDesigns"), "CardDesignsPage");
const TemplatesPage = lazyPage(() => import("./pages/Templates"), "TemplatesPage");
const LogsPage = lazyPage(() => import("./pages/Logs"), "LogsPage");
const SimulatorPage = lazyPage(() => import("./pages/Simulator"), "SimulatorPage");
const OwnerPage = lazyPage(() => import("./pages/Owner"), "OwnerPage");
const SubscriptionPage = lazyPage(() => import("./pages/Subscription"), "SubscriptionPage");
const SettingsPage = lazyPage(() => import("./pages/Settings"), "SettingsPage");
const DownloadPage = lazyPage(() => import("./pages/Download"), "DownloadPage");

// ---------------- tiny hash router ----------------
export function useRoute(): string {
  const [route, setRoute] = useState(() => location.hash.replace(/^#/, "").split("?")[0] || "/");
  useEffect(() => {
    const h = () => setRoute(location.hash.replace(/^#/, "").split("?")[0] || "/");
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return route;
}
export function navigate(to: string) {
  location.hash = to;
}
export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <a href={`#${to}`} {...rest}>
      {children}
    </a>
  );
}

// ---------------- theme ----------------
type Theme = "system" | "light" | "dark";
function applyTheme(t: Theme) {
  const dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("hsn_theme") as Theme) || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = () => applyTheme(theme);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [theme]);
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem("hsn_theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, setTheme];
}

const NAV_GROUPS: Array<{ title: string; items: Array<{ to: string; label: string; icon: string }> }> = [
  { title: "عام", items: [
    { to: "/", label: "الرئيسية", icon: "home" },
    { to: "/campaigns", label: "الحملات", icon: "target" },
    { to: "/inbox", label: "الرسائل", icon: "inbox" },
    { to: "/draws", label: "السحوبات", icon: "gift" },
  ] },
  { title: "الأدوات", items: [
    { to: "/media", label: "المنشورات والستوري", icon: "image" },
    { to: "/templates", label: "القوالب", icon: "puzzle" },
    { to: "/simulator", label: "المحاكاة", icon: "flask" },
    { to: "/logs", label: "السجل", icon: "list" },
  ] },
  { title: "الحساب", items: [
    { to: "/connection", label: "الربط", icon: "link" },
    { to: "/settings", label: "الإعدادات", icon: "settings" },
    { to: "/download", label: "تنزيل التطبيق", icon: "smartphone" },
  ] },
];
/** Customers only: their subscription page. */
const SUBSCRIPTION_ITEM = { to: "/subscription", label: "اشتراكي", icon: "zap" };
/** Owner-only section (customers management). */
const OWNER_GROUP = { title: "الإدارة", items: [{ to: "/owner", label: "العملاء", icon: "users" }] };
const NAV = [...NAV_GROUPS, OWNER_GROUP].flatMap((g) => g.items).concat(SUBSCRIPTION_ITEM);
const MOBILE_TABS = ["/", "/campaigns", "/inbox"];

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useTheme();
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");
  const [username, setUsername] = useState("");
  const [isOwner, setIsOwner] = useState(false);
  const [sub, setSub] = useState<{ active: boolean; expires_at: number | null; reason?: string } | null>(null);
  // Customers: "تنزيل التطبيق" goes straight to the stable download link the owner controls.
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [limits, setLimits] = useState<PlanLimits | null>(null);
  // "Your plan does not include …" box (from a locked menu item or any 403 plan error from the API).
  const [blocked, setBlocked] = useState<string | null>(null);
  // Android app: "turn on fingerprint sign-in?" right after a password sign-in.
  const [bioOffer, setBioOffer] = useState<{ username: string; password: string } | null>(null);
  const [bioBusy, setBioBusy] = useState(false);
  useEffect(() => {
    const on = () => {
      const offer = takeBioOffer();
      if (offer) setBioOffer(offer);
    };
    window.addEventListener("hsn:bio-offer", on);
    return () => window.removeEventListener("hsn:bio-offer", on);
  }, []);
  useEffect(() => {
    const on = (e: Event) => setBlocked((e as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener("hsn:plan-blocked", on);
    return () => window.removeEventListener("hsn:plan-blocked", on);
  }, []);
  const [online, setOnline] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(false);
  menuRef.current = menuOpen;
  const [refreshKey, setRefreshKey] = useState(0);

  const checkAuth = useCallback(async () => {
    try {
      if (isNative && !(await deviceToken.get())) return setAuth("out");
      const me = await api<{ username: string; csrf_token?: string; is_owner?: boolean }>("/api/auth/me");
      setCsrf(me.csrf_token);
      setUsername(me.username);
      setIsOwner(!!me.is_owner);
      if (!me.is_owner)
        api<any>("/api/subscription")
          .then((x) => {
            setSub({ active: x.active, expires_at: x.expires_at, reason: x.reason });
            setDownloadUrl(x.app_download_url ?? null);
            setLimits(x.active ? x.limits : null);
          })
          .catch(() => undefined);
      else {
        setSub(null);
        setLimits(null);
        // The owner's "تنزيل التطبيق" downloads the APK directly too.
        api<{ app_download_url?: string | null }>("/api/public/branding").then((b) => setDownloadUrl(b.app_download_url ?? null), () => setDownloadUrl(null));
      }
      setAuth("in");

      api<{ settings: { timezone?: string } }>("/api/settings")
        .then((s) => setTz(s.settings.timezone ?? "Asia/Aden"))
        .catch(() => undefined);
    } catch (e: any) {
      setAuth(e?.status === 0 ? "in" : "out");
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth("out"));
    checkAuth();
    watchNetwork(setOnline);
    initNative({
      onDeepLink: () => {
        // OAuth finished in the system browser — re-read the real state from the server.
        navigate("/connection");
        setRefreshKey((k) => k + 1);
      },
      onBack: () => {
        if (menuRef.current) {
          setMenuOpen(false);
          return true;
        }
        if ((location.hash || "#/") !== "#/") {
          history.back();
          return true;
        }
        return false;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => setMenuOpen(false), [route]);
  const [shell, setShell] = useState<{ account?: any; unread: number; usagePct?: number; usageUsed?: number }>({ unread: 0 });
  useEffect(() => {
    if (auth !== "in") return;
    let alive = true;
    const load = () => {
      Promise.all([
        api<any>("/api/account").then((r) => r.account).catch(() => null),
        api<any[]>("/api/inbox").then((l) => l.reduce((a, c) => a + (c.unread || 0), 0)).catch(() => 0),
        api<any>("/api/usage").then((r) => r.usage?.requests).catch(() => null),
      ]).then(([account, unread, req]) => alive && setShell({ account, unread, usagePct: req?.pct, usageUsed: req?.used }));
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [auth, route === "/inbox"]);

  if (auth === "loading") return <div className="p-6"><Spinner /></div>;
  if (auth === "out") return <LoginPage onDone={checkAuth} />;

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    await deviceToken.clear();
    setCsrf(null);
    setAuth("out");
  };

  let page: ReactNode;
  const m = route.match(/^\/campaigns\/(new|\d+)$/);
  const ms = route.match(/^\/campaigns\/(\d+)\/stats$/);
  const md = route.match(/^\/campaigns\/(\d+)\/draws$/);
  const mdr = route.match(/^\/draws\/(\d+)$/);
  if (m) page = <CampaignWizard id={m[1] === "new" ? null : Number(m[1])} />;
  else if (ms) page = <CampaignStatsPage id={Number(ms[1])} />;
  else if (md) page = <DrawsHomePage />;
  else if (mdr) page = <DrawPage key={mdr[1]} id={Number(mdr[1])} />;
  else
    switch (route) {
      case "/": page = <DashboardPage />; break;
      case "/connection": page = <ConnectionPage key={refreshKey} />; break;
      case "/media": page = <MediaPage />; break;
      case "/campaigns": page = <CampaignsPage />; break;
      case "/templates": page = <TemplatesPage />; break;
      case "/logs": page = <LogsPage />; break;
      case "/draws": page = <DrawsHomePage />; break;
      case "/draws/designs": page = <CardDesignsPage />; break;
      case "/inbox": page = <InboxPage />; break;
      case "/simulator": page = <SimulatorPage />; break;
      case "/settings": page = <SettingsPage theme={theme} setTheme={setTheme} onLogout={logout} username={username} />; break;
      case "/download": page = <DownloadPage />; break;
      case "/owner": page = isOwner ? <OwnerPage /> : <DashboardPage />; break;
      case "/subscription": page = <SubscriptionPage />; break;
      default:
        page = (
          <div className="card mx-auto mt-6 max-w-md p-8 text-center">
            <span className="surface-2 mx-auto flex h-14 w-14 items-center justify-center rounded-2xl"><Icon name="search" size={26} /></span>
            <h1 className="mt-4 text-xl font-extrabold">الصفحة غير موجودة</h1>
            <p className="muted mt-2 text-sm">ربما تغيّر الرابط أو انحذفت الصفحة.</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Link to="/" className="btn btn-primary">الرجوع للرئيسية</Link>
              <Link to="/campaigns" className="btn btn-ghost">الحملات</Link>
            </div>
          </div>
        );
    }

  const isActive = (to: string) => (to === "/" ? route === "/" : route.startsWith(to));

  const current = NAV.find((n) => isActive(n.to));
  // A distinct tab title per screen (browser tabs, history, screen-reader page announcements).
  const pageTitle = m ? (m[1] === "new" ? "حملة جديدة" : "تعديل الحملة") : ms ? "إحصائيات الحملة" : mdr ? "السحب" : route === "/draws/designs" ? "تصاميم البطاقات" : current?.label ?? "الصفحة غير موجودة";
  if (document.title !== `${pageTitle} · HSN AutoReply`) document.title = `${pageTitle} · HSN AutoReply`;
  // Sections a customer's plan does not include: the menu item shows a lock and opens the upgrade box.
  const lockedFeature = (to: string): string | null => {
    if (isOwner || !limits) return null;
    if (to === "/draws" && limits.draws_per_month === 0) return "السحوبات";
    if (to === "/simulator" && !limits.simulator) return FEATURE_LABELS.simulator;
    return null;
  };
  const NavLink = ({ to, className, children }: { to: string; className?: string; children: ReactNode }) => {
    const locked = lockedFeature(to);
    if (locked)
      return (
        <button type="button" className={`${className ?? ""} w-full text-right`} onClick={() => { setMenuOpen(false); setBlocked(`باقتك لا تشمل: ${locked} — رقِّ باقتك من صفحة «اشتراكي»`); }}>
          {children}
          <Icon name="lock" size={14} className="mr-auto opacity-60" />
        </button>
      );
    return to === "/download" && downloadUrl ? (
      <a href={downloadUrl} download rel="noopener" className={className}>{children}</a>
    ) : (
      <Link to={to} className={className} aria-current={isActive(to) ? "page" : undefined}>{children}</Link>
    );
  };
  const nextTheme = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const themeIcon = theme === "light" ? "sun" : theme === "dark" ? "moon" : "grid";
  const acc = shell.account;
  return (
    <div className="min-h-screen lg:flex">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-l border-[var(--border)] bg-[var(--surface)] px-4 py-5 lg:flex">
        <Link to="/" className="mb-5 flex items-center gap-3 px-2">
          <span className="grad flex h-10 w-10 items-center justify-center rounded-xl text-white shadow-lg shadow-violet-500/30"><Icon name="zap" size={22} /></span>
          <span className="leading-tight">
            <b className="font-display block text-[17px] font-extrabold">HSN AutoReply</b>
            <span className="muted text-xs">أتمتة إنستقرام الرسمية</span>
          </span>
        </Link>
        <Link to="/connection" className="mb-3 flex items-center gap-2.5 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
          <span className="rounded-full p-[2px]" style={{ background: "conic-gradient(from 200deg,#f97316,#db2777,#7c3aed,#f97316)" }}>
            <span className="block rounded-full border-2 border-[var(--surface)]"><AccountAvatar url={acc?.profile_picture_url} name={acc?.username} size={32} /></span>
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <b className="block truncate text-sm" dir="ltr" style={{ textAlign: "right" }}>{acc?.username ? `@${acc.username}` : "لا يوجد حساب"}</b>
            <span className={`flex items-center gap-1 text-[11px] ${acc?.status === "active" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${acc?.status === "active" ? "bg-emerald-500" : "bg-amber-500"}`} />
              {acc?.status === "active" ? "متصل" : "غير مربوط"}
            </span>
          </span>
        </Link>
        <nav className="flex-1 overflow-y-auto">
          {(isOwner
            ? [NAV_GROUPS[0], OWNER_GROUP, ...NAV_GROUPS.slice(1)]
            : [...NAV_GROUPS.slice(0, 2), { ...NAV_GROUPS[2], items: [SUBSCRIPTION_ITEM, ...NAV_GROUPS[2].items] }]
          ).map((g) => (
            <div key={g.title}>
              <div className="muted px-2.5 pb-1.5 pt-3 text-[11px] font-semibold">{g.title}</div>
              {g.items.map((n) => (
                <NavLink key={n.to} to={n.to} className={`nav-link mb-0.5 ${isActive(n.to) ? "on" : ""}`}>
                  <Icon name={n.icon} size={19} />
                  <span>{n.label}</span>
                  {n.to === "/inbox" && shell.unread > 0 && <span className="mr-auto rounded-full bg-pink-600 px-1.5 text-[11px] leading-[18px] text-white">{shell.unread}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        {shell.usagePct != null && (
          <Link to="/" className="mt-3 block rounded-2xl border border-[var(--border)] p-3" >
            <b className="block text-xs">استهلاك اليوم</b>
            <span className="muted text-[11px]">{(shell.usageUsed ?? 0).toLocaleString("en-US")} من 100,000 طلب · مجاني</span>
            <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]"><span className="grad block h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, shell.usagePct))}%` }} /></span>
          </Link>
        )}
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)]/90 px-4 backdrop-blur lg:h-[68px] lg:px-8">
          <Link to="/" className="flex items-center gap-2 lg:hidden" aria-label="الرئيسية">
            <span className="grad flex h-9 w-9 items-center justify-center rounded-xl text-white"><Icon name="zap" size={19} /></span>
          </Link>
          <div className="min-w-0">
            <div className="font-display truncate text-[15px] font-bold lg:text-base">{current?.label ?? "HSN AutoReply"}</div>
          </div>
          <div className="mr-auto flex items-center gap-2">
            <button className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)]" title="المظهر" aria-label="تبديل المظهر" onClick={() => setTheme(nextTheme)}>
              <Icon name={themeIcon} size={18} />
            </button>
            <Link to="/inbox" className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)]" aria-label="الرسائل">
              <Icon name="bell" size={18} />
              {shell.unread > 0 && <span className="absolute left-2 top-2 h-2 w-2 rounded-full border-2 border-[var(--surface)] bg-pink-600" />}
            </Link>
            <button className="hidden items-center gap-2 rounded-xl px-1.5 py-1 hover:bg-[var(--surface-2)] sm:flex" onClick={logout} title="تسجيل الخروج">
              <span className="grad font-display flex h-9 w-9 items-center justify-center rounded-xl font-extrabold text-white">{(username || "?")[0]?.toUpperCase()}</span>
              <span className="text-right leading-tight"><b className="block text-[13px]">{username}</b><span className="muted flex items-center gap-1 text-[11px]"><Icon name="logout" size={12} />خروج</span></span>
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-5 lg:px-8 lg:pb-10">
          {sub && route !== "/subscription" && (!sub.active || (sub.expires_at && sub.expires_at - Date.now() < 3 * 86_400_000)) && (
            <div className="mb-4">
              <Alert tone={sub.active ? "warn" : "bad"}>
                {sub.active
                  ? `اشتراكك ينتهي خلال ${Math.max(1, Math.ceil(((sub.expires_at ?? 0) - Date.now()) / 86_400_000))} يوم — جدّده حتى لا تتوقف الردود.`
                  : sub.reason === "expired" ? "انتهى اشتراكك — الردود التلقائية متوقفة." : "لا يوجد اشتراك فعّال — الردود التلقائية لن تعمل قبل التفعيل."}{" "}
                <Link to="/subscription" className="font-bold underline">أدخل كود التفعيل</Link>
              </Alert>
            </div>
          )}
          {!online && (
            <div className="mb-3">
              <Alert tone="warn">لا يوجد اتصال بالإنترنت. الأتمتة مستمرة على الخادم؛ ستتحدث البيانات عند عودة الاتصال.</Alert>
            </div>
          )}
          <Suspense fallback={<Spinner />}>{page}</Suspense>
        </main>
      </div>

      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 items-start border-t border-[var(--border)] bg-[var(--surface)] lg:hidden" aria-label="التنقل">
        {MOBILE_TABS.slice(0, 2).map((to) => {
          const n = NAV.find((x) => x.to === to)!;
          return (
            <NavLink key={to} to={to} className={`font-display flex flex-col items-center gap-0.5 pb-2 pt-2.5 text-[11px] font-bold ${isActive(to) ? "text-violet-600 dark:text-violet-400" : "muted"}`}>
              <Icon name={n.icon} size={22} />
              {n.label}
            </NavLink>
          );
        })}
        <div className="flex justify-center">
          {!route.startsWith("/campaigns/") && <Link to="/campaigns/new" className="grad -mt-5 flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-lg shadow-violet-500/40" aria-label="حملة جديدة">
            <Icon name="plus" size={26} />
          </Link>}
        </div>
        {(() => {
          const n = NAV.find((x) => x.to === "/inbox")!;
          return (
            <Link to="/inbox" className={`font-display relative flex flex-col items-center gap-0.5 pb-2 pt-2.5 text-[11px] font-bold ${isActive("/inbox") ? "text-violet-600 dark:text-violet-400" : "muted"}`}>
              <Icon name={n.icon} size={22} />
              {n.label}
              {shell.unread > 0 && <span className="absolute right-[calc(50%-20px)] top-1.5 rounded-full bg-pink-600 px-1 text-[10px] leading-4 text-white">{shell.unread}</span>}
            </Link>
          );
        })()}
        <button onClick={() => setMenuOpen(true)} className="font-display muted flex flex-col items-center gap-0.5 pb-2 pt-2.5 text-[11px] font-bold" aria-haspopup="menu">
          <Icon name="menu" size={22} />المزيد
        </button>
      </nav>

      {menuOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 lg:hidden" onClick={() => setMenuOpen(false)}>
          <div className="card safe-bottom absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-b-none p-4" onClick={(e) => e.stopPropagation()} role="menu">
            <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-[var(--border)]" />
            <div className="grid grid-cols-3 gap-2">
              {NAV.filter((n) => !MOBILE_TABS.includes(n.to) && (isOwner ? n.to !== "/subscription" : n.to !== "/owner")).map((n) => (
                <NavLink key={n.to} to={n.to} className={`flex flex-col items-center gap-1.5 rounded-2xl border border-[var(--border)] px-2 py-3.5 text-center text-xs font-bold ${isActive(n.to) ? "border-violet-400 bg-violet-500/10 text-violet-700 dark:text-violet-300" : ""}`}>
                  <Icon name={n.icon} size={22} />
                  {n.label}
                </NavLink>
              ))}
            </div>
            <button onClick={logout} className="btn btn-ghost mt-3 w-full text-red-600"><Icon name="logout" size={18} />تسجيل الخروج ({username})</button>
          </div>
        </div>
      )}
      <ToastHost />
      {bioOffer && (
        <Modal open center onClose={() => setBioOffer(null)} title="الدخول بالبصمة">
          <div className="space-y-4 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-600 dark:text-violet-300"><Icon name="fingerprint" size={28} /></span>
            <p className="text-sm leading-relaxed">تبي تدخل المرة الجاية ببصمتك بدون كلمة مرور؟ بيانات الدخول تنحفظ مشفّرة في خزنة الجوال الآمنة، وما تنفتح إلا ببصمتك.</p>
            <div className="flex gap-2">
              <button
                className="btn btn-primary flex-1"
                disabled={bioBusy}
                onClick={async () => {
                  setBioBusy(true);
                  try {
                    await enableBio(bioOffer.username, bioOffer.password);
                    toast("تم تفعيل الدخول بالبصمة ✅");
                  } catch {
                    toast("ما تم التفعيل — تقدر تجرّب مرة ثانية بعد تسجيل الدخول", "bad");
                  } finally {
                    setBioBusy(false);
                    setBioOffer(null);
                  }
                }}
              >
                <Icon name="fingerprint" size={18} />{bioBusy ? "…" : "تفعيل البصمة"}
              </button>
              <button className="btn btn-ghost" disabled={bioBusy} onClick={() => setBioOffer(null)}>لاحقًا</button>
            </div>
          </div>
        </Modal>
      )}
      {blocked && !isOwner && (
        <Modal open onClose={() => setBlocked(null)} title="ميزة غير متاحة في باقتك">
          <div className="space-y-4 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400"><Icon name="lock" size={26} /></span>
            <p className="font-display text-base font-bold leading-relaxed">{blocked}</p>
            <div className="flex gap-2">
              <button
                className="btn btn-primary flex-1"
                onClick={() => {
                  setBlocked(null);
                  location.hash = "#/subscription";
                  setTimeout(() => document.getElementById("plans")?.scrollIntoView({ behavior: "smooth", block: "start" }), 700);
                }}
              >
                <Icon name="zap" size={17} />رقِّ اشتراكي
              </button>
              <button className="btn btn-ghost" onClick={() => setBlocked(null)}>لاحقًا</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
