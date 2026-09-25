import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.hsn.autoreply",
  appName: "HSN AutoReply",
  webDir: "dist/app",
  server: {
    // UI files are bundled inside the APK and served from https://localhost
    androidScheme: "https",
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: "#0b0f14",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
    },
    CapacitorHttp: { enabled: false },
  },
};

export default config;
