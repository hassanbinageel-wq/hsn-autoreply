export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;

  // ---- vars (wrangler.jsonc) ----
  INSTAGRAM_APP_ID: string;
  META_API_VERSION: string; // e.g. "v26.0"
  META_API_VERIFIED_AT?: string; // date the version was last checked against Meta docs
  PUBLIC_BASE_URL: string; // https://<worker>.workers.dev  (used for OAuth redirect + webhooks)
  ALLOWED_APP_ORIGINS: string; // comma separated, e.g. "https://localhost,capacitor://localhost"
  APP_VERSION: string;
  APP_DEEP_LINK: string; // e.g. "com.hsn.autoreply://oauth-done"
  RELEASES_URL?: string; // GitHub releases page
  APK_DOWNLOAD_URL?: string; // optional authorized public download location
  PBKDF2_ITERATIONS?: string;

  // ---- secrets (wrangler secret put) ----
  INSTAGRAM_APP_SECRET: string;
  META_WEBHOOK_VERIFY_TOKEN: string;
  TOKEN_ENC_KEY: string; // base64, 32 bytes
  PASSWORD_PEPPER: string;
  SETUP_TOKEN?: string; // one-time initial admin setup; remove after use
}

export const REQUIRED_SECRETS = [
  "INSTAGRAM_APP_SECRET",
  "META_WEBHOOK_VERIFY_TOKEN",
  "TOKEN_ENC_KEY",
  "PASSWORD_PEPPER",
] as const;

export function missingSecrets(env: Env): string[] {
  return REQUIRED_SECRETS.filter((k) => !env[k]);
}
