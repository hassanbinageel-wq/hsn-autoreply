import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ConfirmHost, askConfirm } from "./components/Confirm";
import { APP_TARGET } from "./platform";

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
        askConfirm({ title: "يتوفر إصدار أحدث", message: "فيه تحديث جديد للواجهة. التحديث يعيد تحميل الصفحة.", confirmLabel: "حدّث الآن", cancelLabel: "لاحقًا" }).then((ok) => { if (ok) void update(true); });
      },
    });
  });
}
