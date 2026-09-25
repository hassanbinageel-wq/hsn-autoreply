import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        main: "./src/worker/index.ts",
        miniflare: {
          compatibilityDate: "2026-08-20",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            INSTAGRAM_APP_ID: "1234567890",
            INSTAGRAM_APP_SECRET: "test_app_secret",
            META_WEBHOOK_VERIFY_TOKEN: "test_verify_token",
            TOKEN_ENC_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY", // 32 bytes, test only
            PASSWORD_PEPPER: "test_pepper",
            SETUP_TOKEN: "test_setup_token_123456",
            PBKDF2_ITERATIONS: "1000",
            META_API_VERSION: "v26.0",
            PUBLIC_BASE_URL: "https://hsn.example.workers.dev",
            ALLOWED_APP_ORIGINS: "https://localhost,capacitor://localhost",
            APP_VERSION: "1.0.0-test",
            APP_DEEP_LINK: "com.hsn.autoreply://oauth-done",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
