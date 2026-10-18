import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ConfirmHost, askConfirm } from "./components/Confirm";
import { APP_TARGET } from "./platform";

// A customer's invitation link (…#/register?ref=CODE): kept until sign-up.
try {
  const ref = new URLSearchParams(location.hash.split("?")[1] ?? "").get("ref");
  if (ref && /^[A-Z0-9]{4,20}$/i.test(ref)) localStorage.setItem("hsn_ref", ref.toUpperCase());
} catch {
  /* private mode */
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
      <ConfirmHost />
    </ErrorBoundary>
  </StrictMode>,
);

// Service worker only for the web/PWA build (the APK already bundles its files).
if (APP_TARGET === "web" && "serviceWorker" in navigator && import.meta.env.PROD) {
  import("virtual:pwa-register").then(({ registerSW }) => {
    const update = registerSW({
      onNeedRefresh() {
        askConfirm({ title: "يتوفر إصدار أحدث", message: "فيه تحديث جديد للواجهة. التحديث يعيد تحميل الصفحة.", confirmLabel: "حدّث الآن", cancelLabel: "لاحقًا" }).then((ok) => {
          if (ok) return void update(true);
          // "Later": switch to the new version the next time the page is in the background, so nobody stays on an old one.
          const onHide = () => {
            if (document.visibilityState !== "hidden") return;
            document.removeEventListener("visibilitychange", onHide);
            void update(true);
          };
          document.addEventListener("visibilitychange", onHide);
        });
      },
    });
  });
}
