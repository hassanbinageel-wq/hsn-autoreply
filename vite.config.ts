import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Two builds share the same UI:
//  - default (web/PWA): served by the Worker (same origin), service worker enabled
//  - --mode capacitor: bundled inside the APK, talks to VITE_API_BASE over HTTPS, no service worker
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const isApp = mode === "capacitor";
  const apiOrigin = isApp ? new URL(env.VITE_API_BASE || "https://hsn-autoreply.invalid").origin : "";
  return {
    base: isApp ? "./" : "/",
    define: {
      __APP_TARGET__: JSON.stringify(isApp ? "app" : "web"),
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0"),
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "csp-connect-src",
        transformIndexHtml: (html: string) => html.replace("__API_ORIGIN__", apiOrigin),
      },
      VitePWA({
          disable: isApp, // no service worker inside the APK (files are bundled)
          registerType: "prompt",
          injectRegister: false,
          includeAssets: ["icons/*.png", "favicon.svg"],
          manifest: {
            name: "HSN AutoReply",
            short_name: "HSN AutoReply",
            description: "أتمتة الردود على تعليقات وستوري إنستقرام",
            lang: "ar",
            dir: "rtl",
            start_url: "/",
            scope: "/",
            display: "standalone",
            background_color: "#0b0f14",
            theme_color: "#6d28d9",
            icons: [
              { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
              { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
              { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
            ],
          },
          workbox: {
            // Only the public UI shell is cached — never API responses or auth pages.
            globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
            navigateFallback: "/index.html",
            navigateFallbackDenylist: [/^\/api\//, /^\/webhooks\//, /^\/oauth\//, /^\/meta\//, /^\/privacy/, /^\/terms/, /^\/data-deletion/, /^\/healthz/],
            runtimeCaching: [],
            cleanupOutdatedCaches: true,
          },
        }),
    ].filter(Boolean),
    build: {
      outDir: isApp ? "dist/app" : "dist/web",
      emptyOutDir: true,
      sourcemap: false,
    },
    server: {
      proxy: {
        "/api": "http://127.0.0.1:8787",
        "/oauth": "http://127.0.0.1:8787",
      },
    },
  };
});
