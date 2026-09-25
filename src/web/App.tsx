import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, setCsrf, setUnauthorizedHandler } from "./api";
import { deviceToken, initNative, isNative, watchNetwork } from "./platform";
import { Alert, Spinner, ToastHost, setTz } from "./components/ui";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { ConnectionPage } from "./pages/Connection";
import { MediaPage } from "./pages/Media";
import { CampaignsPage } from "./pages/Campaigns";
import { CampaignWizard } from "./pages/CampaignWizard";
import { TemplatesPage } from "./pages/Templates";
import { LogsPage } from "./pages/Logs";
import { SimulatorPage } from "./pages/Simulator";
import { SettingsPage } from "./pages/Settings";
import { DownloadPage } from "./pages/Download";

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
export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a href={`#${to}`} className={className}>
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

const NAV = [
  { to: "/", label: "الرئيسية", icon: "🏠", main: true },
  { to: "/campaigns", label: "الحملات", icon: "🎯", main: true },
  { to: "/logs", label: "السجل", icon: "📜", main: true },
  { to: "/simulator", label: "المحاكاة", icon: "🧪", main: true },
  { to: "/connection", label: "الربط", icon: "🔗" },
  { to: "/media", label: "المنشورات والستوري", icon: "🖼️" },
  { to: "/templates", label: "القوالب", icon: "🧩" },
  { to: "/settings", label: "الإعدادات", icon: "⚙️" },
  { to: "/download", label: "تنزيل التطبيق", icon: "📲" },
];

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useTheme();
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");
  const [username, setUsername] = useState("");
  const [online, setOnline] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(false);
  menuRef.current = menuOpen;
  const [refreshKey, setRefreshKey] = useState(0);

  const checkAuth = useCallback(async () => {
    try {
      if (isNative && !(await deviceToken.get())) return setAuth("out");
      const me = await api<{ username: string; csrf_token?: string }>("/api/auth/me");
      setCsrf(me.csrf_token);
      setUsername(me.username);
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
  if (m) page = <CampaignWizard id={m[1] === "new" ? null : Number(m[1])} />;
  else
    switch (route) {
      case "/": page = <DashboardPage />; break;
      case "/connection": page = <ConnectionPage key={refreshKey} />; break;
      case "/media": page = <MediaPage />; break;
      case "/campaigns": page = <CampaignsPage />; break;
      case "/templates": page = <TemplatesPage />; break;
      case "/logs": page = <LogsPage />; break;
      case "/simulator": page = <SimulatorPage />; break;
      case "/settings": page = <SettingsPage theme={theme} setTheme={setTheme} onLogout={logout} username={username} />; break;
      case "/download": page = <DownloadPage />; break;
      default: page = <Alert tone="warn">الصفحة غير موجودة</Alert>;
    }

  const isActive = (to: string) => (to === "/" ? route === "/" : route.startsWith(to));

  return (
    <div className="min-h-screen lg:flex">
      <aside className="card sticky top-0 hidden h-screen w-64 shrink-0 flex-col rounded-none border-y-0 border-r-0 p-4 lg:flex">
        <div className="mb-6 flex items-center gap-2 text-xl font-bold">
          <img src="./favicon.svg" alt="" className="h-8 w-8" /> HSN AutoReply
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={`rounded-xl px-3 py-2.5 font-semibold ${isActive(n.to) ? "bg-brand-700 text-white" : "hover:bg-[var(--surface-2)]"}`}>
              <span className="ml-2">{n.icon}</span>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="muted mt-auto text-sm">{username}</div>
      </aside>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-4 lg:px-8 lg:pb-10">
        {!online && (
          <div className="mb-3">
            <Alert tone="warn">لا يوجد اتصال بالإنترنت. الأتمتة مستمرة على الخادم؛ ستتحدث البيانات عند عودة الاتصال.</Alert>
          </div>
        )}
        {page}
      </main>

      <nav className="card safe-bottom fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 rounded-none border-x-0 border-b-0 lg:hidden" aria-label="التنقل">
        {NAV.filter((n) => n.main).map((n) => (
          <Link key={n.to} to={n.to} className={`flex flex-col items-center gap-0.5 py-2 text-xs font-semibold ${isActive(n.to) ? "text-brand-700 dark:text-brand-500" : "muted"}`}>
            <span className="text-xl" aria-hidden>{n.icon}</span>
            {n.label}
          </Link>
        ))}
        <button onClick={() => setMenuOpen(true)} className="muted flex flex-col items-center gap-0.5 py-2 text-xs font-semibold" aria-haspopup="menu">
          <span className="text-xl" aria-hidden>☰</span>المزيد
        </button>
      </nav>

      {menuOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 lg:hidden" onClick={() => setMenuOpen(false)}>
          <div className="card safe-bottom absolute inset-x-0 bottom-0 rounded-b-none p-4" onClick={(e) => e.stopPropagation()} role="menu">
            {NAV.filter((n) => !n.main).map((n) => (
              <Link key={n.to} to={n.to} className="flex items-center gap-3 rounded-xl px-3 py-3.5 text-lg font-semibold hover:bg-[var(--surface-2)]">
                <span>{n.icon}</span>
                {n.label}
              </Link>
            ))}
          </div>
        </div>
      )}
      <ToastHost />
    </div>
  );
}
