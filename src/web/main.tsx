import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { APP_TARGET } from "./platform";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service worker only for the web/PWA build (the APK already bundles its files).
if (APP_TARGET === "web" && "serviceWorker" in navigator && import.meta.env.PROD) {
  import("virtual:pwa-register").then(({ registerSW }) => {
    const update = registerSW({
      onNeedRefresh() {
        if (confirm("يتوفر إصدار أحدث من الواجهة. تحديث الآن؟")) update(true);
      },
    });
  });
}
