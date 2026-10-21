import { Icon } from "./Icon";

export interface BannerTexts {
  title: string;
  subtitle: string;
  points: Array<{ title: string; desc: string }>;
}
export interface Branding {
  login_banner: string | null;
  login_banner_mobile: string | null;
  texts: BannerTexts | null;
  logo: string | null;
  app_icon?: string | null;
  app_download_url?: string | null;
}

export const DEFAULT_TEXTS: BannerTexts = {
  title: "حوّل تعليقات إنستقرام\nإلى عملاء ومبيعات",
  subtitle: "ردود تلقائية ورسائل خاصة بالرابط، سحوبات عادلة، جدولة نشر، وتحليلات تربط كل منشور بمبيعات متجرك — عبر واجهة Meta الرسمية.",
  points: [
    { title: "رد فوري + الرابط في الخاص", desc: "كل تعليق أو رد على ستوري يوصله رد خلال ثوانٍ، والرابط يوصل رسائله الخاصة مباشرة" },
    { title: "اعرف أي منشور جاب لك فلوس", desc: "تتبّع الضغطات وربط متجرك في سلة، مع سحوبات عادلة وجدولة نشر في نفس المكان" },
    { title: "آمن ورسمي 100%", desc: "عبر واجهة Meta الرسمية، بدون كلمة مرور حسابك، وبالتزام كامل بقواعد الإرسال" },
  ],
};
const ICONS = ["target", "chart", "shield"];
export const BANNER_GRADIENT =
  "radial-gradient(circle at 80% 15%,rgba(249,115,22,.55),transparent 45%),radial-gradient(circle at 15% 85%,rgba(219,39,119,.5),transparent 50%),linear-gradient(160deg,#1e0b4b,#4c1d95 50%,#86198f)";

/** Recommended sizes (pixels; cm at 72 px/inch as in Photoshop for screens). */
export const BANNER_SIZES = {
  desktop: { w: 1280, h: 1800, label: "الكمبيوتر", ratio: "عمودية 5:7" },
  mobile: { w: 1200, h: 600, label: "الجوال", ratio: "أفقية 2:1" },
} as const;
export const toCm = (px: number) => ((px / 72) * 2.54).toFixed(1);

/** The owner's image with a dark veil (text stays readable), or the default grid pattern on the gradient. */
function Backdrop({ src }: { src: string | null }) {
  return src ? (
    <>
      <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/25 to-black/55" />
    </>
  ) : (
    <div className="absolute inset-0" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px)", backgroundSize: "48px 48px" }} />
  );
}

const lines = (t: string) => t.split("\n").map((l, i, a) => (
  <span key={i}>
    {l}
    {i < a.length - 1 && <br />}
  </span>
));

/** "تنزيل التطبيق للأندرويد": downloads the APK straight away; the owner's icon (transparent PNG) sits beside the text. */
export function AppDownloadBox({ url, icon, tone = "dark", className = "" }: { url: string; icon: string | null; tone?: "dark" | "light"; className?: string }) {
  const dark = tone === "dark";
  return (
    <a
      href={url}
      download
      rel="noopener"
      className={`flex items-center gap-3 rounded-2xl px-4 py-3 transition ${dark ? "border border-white/20 bg-black/35 text-white backdrop-blur-md hover:bg-black/45" : "border border-[var(--border)] bg-[var(--surface)] hover:border-violet-400"} ${className}`}
    >
      {icon ? (
        <img src={icon} alt="" className="h-10 w-10 shrink-0 object-contain" />
      ) : (
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${dark ? "bg-white/15" : "bg-emerald-500/10 text-emerald-600"}`}><Icon name="smartphone" size={20} /></span>
      )}
      <span className="flex-1 leading-tight">
        <b className="block text-sm">تنزيل التطبيق للأندرويد</b>
        <span className={`text-xs ${dark ? "text-white/75" : "muted"}`}>ملف APK — يبدأ التحميل مباشرة</span>
      </span>
      <Icon name="download" size={20} className={dark ? "text-white/80" : "text-emerald-600"} />
    </a>
  );
}

/** Computer: the side panel of the login page. */
export function DesktopBanner({ image, texts, logo, download, className = "" }: { image: string | null; texts: BannerTexts | null; logo: string | null; download?: { url: string; icon: string | null } | null; className?: string }) {
  const t = texts ?? DEFAULT_TEXTS;
  return (
    <div className={`relative flex-col overflow-hidden p-12 text-white ${className}`} style={{ background: BANNER_GRADIENT }}>
      <Backdrop src={image} />
      <div className="relative">
        {logo && <img src={logo} alt="" className="mb-6 h-14 w-auto max-w-[200px] object-contain drop-shadow" />}
        {t.title && <h2 className="text-[36px] font-extrabold leading-snug drop-shadow">{lines(t.title)}</h2>}
        {t.subtitle && <p className="mt-3 max-w-md leading-loose text-violet-50 drop-shadow">{t.subtitle}</p>}
      </div>
      <div className="relative mt-8 grid gap-3">
        {t.points.map((p, i) =>
          p.title ? (
            <div key={i} className="flex items-center gap-3 rounded-2xl border border-white/15 bg-black/20 p-4 backdrop-blur-md">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15"><Icon name={ICONS[i]} size={20} /></span>
              <span><b className="block text-sm">{p.title}</b>{p.desc && <span className="text-xs text-violet-50/90">{p.desc}</span>}</span>
            </div>
          ) : null,
        )}
      </div>
      {download && <AppDownloadBox className="relative mt-auto" url={download.url} icon={download.icon} />}
    </div>
  );
}

/** Phone: the banner on top of the login page (medium height). */
export function MobileBanner({ image, texts, logo, className = "" }: { image: string | null; texts: BannerTexts | null; logo: string | null; className?: string }) {
  const t = texts ?? DEFAULT_TEXTS;
  return (
    <div className={`relative flex h-48 shrink-0 flex-col justify-end overflow-hidden rounded-b-[28px] px-5 pb-5 text-white ${className}`} style={{ background: BANNER_GRADIENT }}>
      <Backdrop src={image} />
      {logo && <img src={logo} alt="" className="absolute right-5 top-5 h-9 w-auto max-w-[140px] object-contain drop-shadow" />}
      <div className="relative">
        {t.title && <h2 className="text-[22px] font-extrabold leading-snug drop-shadow">{t.title.replace(/\n/g, " ")}</h2>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {t.points.map((p, i) =>
            p.title ? (
              <span key={i} className="flex items-center gap-1 rounded-full bg-black/25 px-2.5 py-1 text-[11px] font-bold backdrop-blur"><Icon name={ICONS[i]} size={12} />{p.title}</span>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}
