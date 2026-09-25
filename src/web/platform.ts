import { Capacitor } from "@capacitor/core";

declare const __APP_TARGET__: "web" | "app";
declare const __APP_VERSION__: string;

export const APP_TARGET = __APP_TARGET__;
export const APP_VERSION = __APP_VERSION__;
export const isNative = APP_TARGET === "app" && Capacitor.isNativePlatform();

/** API origin: same origin for the PWA, the production HTTPS Worker for the APK. */
export const API_BASE: string = APP_TARGET === "app" ? (import.meta.env.VITE_API_BASE as string) || "" : "";

const TOKEN_KEY = "hsn_device_session";

/**
 * Device session token storage for the Android app.
 * Uses Android Keystore-backed secure storage; never localStorage.
 * The web build never stores tokens in JS — it relies on an HttpOnly cookie.
 */
export const deviceToken = {
  async get(): Promise<string | null> {
    if (!isNative) return null;
    const { SecureStorage } = await import("@aparajita/capacitor-secure-storage");
    try {
      const v = await SecureStorage.get(TOKEN_KEY);
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  },
  async set(token: string): Promise<void> {
    if (!isNative) return;
    const { SecureStorage } = await import("@aparajita/capacitor-secure-storage");
    await SecureStorage.set(TOKEN_KEY, token);
  },
  async clear(): Promise<void> {
    if (!isNative) return;
    const { SecureStorage } = await import("@aparajita/capacitor-secure-storage");
    await SecureStorage.remove(TOKEN_KEY).catch(() => undefined);
  },
};

/** Opens a URL outside the app: Custom Tabs (system browser) on Android, new tab on the web. */
export async function openExternal(url: string): Promise<void> {
  if (isNative) {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url, presentationStyle: "fullscreen" });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** OAuth must happen in the system browser, never in a WebView that could capture the password. */
export async function openOAuth(url: string): Promise<void> {
  if (isNative) await openExternal(url);
  else window.location.assign(url);
}

export async function initNative(handlers: { onDeepLink: (url: string) => void; onBack: () => boolean }): Promise<void> {
  if (!isNative) return;
  const [{ App }, { SplashScreen }, { Browser }, { StatusBar, Style }] = await Promise.all([
    import("@capacitor/app"),
    import("@capacitor/splash-screen"),
    import("@capacitor/browser"),
    import("@capacitor/status-bar"),
  ]);
  App.addListener("appUrlOpen", async ({ url }) => {
    // Only our own scheme is accepted; the payload is never trusted — the app re-fetches state from the server.
    if (url.startsWith("com.hsn.autoreply://")) {
      await Browser.close().catch(() => undefined);
      handlers.onDeepLink(url);
    }
  });
  App.addListener("backButton", () => {
    if (!handlers.onBack()) App.exitApp();
  });
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => undefined);
  await SplashScreen.hide().catch(() => undefined);
}

export async function watchNetwork(cb: (online: boolean) => void): Promise<void> {
  if (isNative) {
    const { Network } = await import("@capacitor/network");
    cb((await Network.getStatus()).connected);
    Network.addListener("networkStatusChange", (s) => cb(s.connected));
  } else {
    cb(navigator.onLine);
    window.addEventListener("online", () => cb(true));
    window.addEventListener("offline", () => cb(false));
  }
}
