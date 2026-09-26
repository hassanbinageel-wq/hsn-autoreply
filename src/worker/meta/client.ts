import type {
  FollowCheckOutcome,
  MeProfile,
  MediaItem,
  MetaClient,
  MetaError,
  MetaResult,
  OutgoingMessage,
  Paged,
  TokenExchange,
} from "./types";

/**
 * Official Instagram API with Instagram Login (graph.instagram.com).
 * Endpoints used (see docs/META_SETUP.md for the verification notes):
 *  - OAuth authorize:  https://www.instagram.com/oauth/authorize
 *  - Code exchange:    POST https://api.instagram.com/oauth/access_token
 *  - Long-lived token: GET  https://graph.instagram.com/access_token?grant_type=ig_exchange_token
 *  - Refresh:          GET  https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
 *  - Profile:          GET  /{v}/me
 *  - Media / stories:  GET  /{v}/me/media , /{v}/me/stories
 *  - Webhook subscribe POST /{v}/me/subscribed_apps
 *  - Send API:         POST /{v}/{ig-user-id}/messages   (recipient.id or recipient.comment_id for private replies)
 *  - Comment reply:    POST /{v}/{comment-id}/replies
 *  - User Profile API: GET  /{v}/{igsid}?fields=...,is_user_follow_business
 */

export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
] as const;

export const WEBHOOK_FIELDS = ["comments", "messages", "messaging_postbacks", "message_reactions"] as const;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpMetaClientOptions {
  apiVersion: string;
  appId: string;
  appSecret: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Called once per outgoing HTTP request so callers can enforce subrequest budgets. */
  onRequest?: () => void;
}

const TOKEN_LIKE = /(access_token=)[^&\s"]+|EAA[A-Za-z0-9]+|IG[A-Za-z0-9]{20,}/g;
export function sanitize(msg: string): string {
  return String(msg ?? "").replace(TOKEN_LIKE, "$1***").slice(0, 500);
}

function parseRetryAfter(res: Response): number | undefined {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return secs * 1000;
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  // Business Use Case rate limiting header — estimated_time_to_regain_access is in minutes.
  const buc = res.headers.get("x-business-use-case-usage") ?? res.headers.get("x-app-usage");
  if (buc) {
    try {
      const parsed = JSON.parse(buc) as Record<string, Array<{ estimated_time_to_regain_access?: number }>>;
      let max = 0;
      for (const arr of Object.values(parsed)) {
        if (Array.isArray(arr)) for (const u of arr) max = Math.max(max, u?.estimated_time_to_regain_access ?? 0);
      }
      if (max > 0) return max * 60_000;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/** Best-effort mapping of Graph error codes. Unknown errors are treated as permanent (never blindly retried). */
export function classifyError(httpStatus: number, body: any, retryAfterMs?: number): MetaError {
  const e = body?.error ?? {};
  const code: number | undefined = typeof e.code === "number" ? e.code : undefined;
  const subcode: number | undefined = typeof e.error_subcode === "number" ? e.error_subcode : undefined;
  const message = sanitize(e.message ?? `HTTP ${httpStatus}`);
  const base = { httpStatus, code, subcode, message, retryAfterMs };
  if (httpStatus === 429 || [4, 17, 32, 613].includes(code ?? -1) || (code !== undefined && code >= 80001 && code <= 80014)) {
    return { kind: "rate_limited", ...base };
  }
  if (code === 190 || code === 102 || httpStatus === 401) return { kind: "auth", ...base };
  if (subcode === 2534022 || /outside of allowed window/i.test(message)) return { kind: "window_closed", ...base };
  if (code === 230 || /consent/i.test(message)) return { kind: "no_consent", ...base };
  if (code === 10 || code === 200 || code === 3 || (code !== undefined && code >= 200 && code < 300)) {
    return { kind: "permission", ...base };
  }
  if (code === 1 || code === 2 || httpStatus >= 500) return { kind: "retryable", ...base };
  return { kind: "permanent", ...base };
}

export class HttpMetaClient implements MetaClient {
  private readonly f: FetchLike;
  constructor(private readonly opts: HttpMetaClientOptions) {
    this.f = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  get graphBase(): string {
    return `https://graph.instagram.com/${this.opts.apiVersion}`;
  }

  /**
   * @param isSend true for requests with side effects: a lost connection means the outcome is uncertain.
   */
  private async request<T>(url: string, init: RequestInit, isSend: boolean): Promise<MetaResult<T>> {
    this.opts.onRequest?.();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await this.f(url, { ...init, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      return {
        ok: false,
        error: {
          kind: isSend ? "uncertain" : "retryable",
          message: sanitize(`network: ${(err as Error)?.name ?? "error"}`),
        },
      };
    }
    clearTimeout(timer);
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      if (res.ok && isSend) {
        return { ok: false, error: { kind: "uncertain", httpStatus: res.status, message: "unparseable success body" } };
      }
    }
    if (!res.ok || body?.error) return { ok: false, error: classifyError(res.status, body, parseRetryAfter(res)) };
    return { ok: true, data: body as T, httpStatus: res.status };
  }

  private authJson(token: string, body: unknown): RequestInit {
    return {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  private authGet(token: string): RequestInit {
    return { method: "GET", headers: { Authorization: `Bearer ${token}` } };
  }

  // ---------- OAuth ----------
  authorizeUrl(redirectUri: string, state: string): string {
    const u = new URL("https://www.instagram.com/oauth/authorize");
    u.searchParams.set("client_id", this.opts.appId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
    u.searchParams.set("state", state);
    u.searchParams.set("enable_fb_login", "0");
    u.searchParams.set("force_authentication", "1");
    return u.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<MetaResult<TokenExchange>> {
    const form = new URLSearchParams({
      client_id: this.opts.appId,
      client_secret: this.opts.appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    });
    const r = await this.request<any>("https://api.instagram.com/oauth/access_token", { method: "POST", body: form }, false);
    if (!r.ok) return r;
    // Response may be flat or wrapped in data[] depending on version.
    const d = Array.isArray(r.data?.data) ? r.data.data[0] : r.data;
    const permissions = typeof d.permissions === "string" ? d.permissions.split(",") : d.permissions;
    return { ok: true, httpStatus: r.httpStatus, data: { access_token: d.access_token, user_id: String(d.user_id ?? ""), permissions } };
  }

  async exchangeLongLived(shortToken: string): Promise<MetaResult<TokenExchange>> {
    const u = new URL("https://graph.instagram.com/access_token");
    u.searchParams.set("grant_type", "ig_exchange_token");
    u.searchParams.set("client_secret", this.opts.appSecret);
    u.searchParams.set("access_token", shortToken); // documented form for this endpoint
    return this.request<TokenExchange>(u.toString(), { method: "GET" }, false);
  }

  async refreshLongLived(token: string): Promise<MetaResult<TokenExchange>> {
    const u = new URL("https://graph.instagram.com/refresh_access_token");
    u.searchParams.set("grant_type", "ig_refresh_token");
    u.searchParams.set("access_token", token);
    return this.request<TokenExchange>(u.toString(), { method: "GET" }, false);
  }

  async getMe(token: string): Promise<MetaResult<MeProfile>> {
    return this.request<MeProfile>(
      `${this.graphBase}/me?fields=id,user_id,username,name,profile_picture_url,account_type`,
      this.authGet(token),
      false,
    );
  }

  async subscribeWebhooks(token: string, fields: readonly string[]): Promise<MetaResult<{ success?: boolean }>> {
    const u = `${this.graphBase}/me/subscribed_apps?subscribed_fields=${encodeURIComponent(fields.join(","))}`;
    return this.request(u, { method: "POST", headers: { Authorization: `Bearer ${token}` } }, false);
  }

  async getSubscriptions(token: string): Promise<MetaResult<{ data?: Array<{ subscribed_fields?: string[] }> }>> {
    return this.request(`${this.graphBase}/me/subscribed_apps`, this.authGet(token), false);
  }

  async unsubscribeWebhooks(token: string): Promise<MetaResult<{ success?: boolean }>> {
    return this.request(`${this.graphBase}/me/subscribed_apps`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }, false);
  }

  async listMedia(token: string, after?: string): Promise<MetaResult<Paged<MediaItem>>> {
    const u = new URL(`${this.graphBase}/me/media`);
    u.searchParams.set("fields", "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp");
    u.searchParams.set("limit", "50");
    if (after) u.searchParams.set("after", after);
    return this.request(u.toString(), this.authGet(token), false);
  }

  async listStories(token: string): Promise<MetaResult<Paged<MediaItem>>> {
    const u = new URL(`${this.graphBase}/me/stories`);
    u.searchParams.set("fields", "id,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp");
    return this.request(u.toString(), this.authGet(token), false);
  }

  // ---------- Messaging ----------
  private messageBody(msg: OutgoingMessage) {
    const m: Record<string, unknown> = { text: msg.text };
    if (msg.quickReplies?.length) {
      m.quick_replies = msg.quickReplies.map((q) => ({ content_type: "text", title: q.title, payload: q.payload }));
    }
    return m;
  }

  /**
   * Private reply (one per comment). If buttons are given, it is sent as a button template with postback
   * buttons (tapping one is a user interaction that opens the conversation). If Meta rejects the template
   * with a definitive error, it is re-sent once as plain text — never after an uncertain outcome.
   */
  async sendPrivateReply(token: string, igUserId: string, commentId: string, msg: OutgoingMessage) {
    const url = `${this.graphBase}/${encodeURIComponent(igUserId)}/messages`;
    const textOnly = () =>
      this.request<{ message_id?: string }>(url, this.authJson(token, { recipient: { comment_id: commentId }, message: { text: msg.text } }), true);
    if (!msg.quickReplies?.length) return textOnly();
    const r = await this.request<{ message_id?: string }>(
      url,
      this.authJson(token, {
        recipient: { comment_id: commentId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: msg.text.slice(0, 640),
              buttons: msg.quickReplies.slice(0, 3).map((b) => ({ type: "postback", title: b.title.slice(0, 20), payload: b.payload })),
            },
          },
        },
      }),
      true,
    );
    if (!r.ok && (r.error.kind === "permanent" || r.error.kind === "permission")) return textOnly();
    return r;
  }

  sendMessage(token: string, igUserId: string, recipientId: string, msg: OutgoingMessage) {
    return this.request<{ message_id?: string }>(
      `${this.graphBase}/${encodeURIComponent(igUserId)}/messages`,
      this.authJson(token, { recipient: { id: recipientId }, message: this.messageBody(msg) }),
      true,
    );
  }

  replyToComment(token: string, commentId: string, text: string) {
    return this.request<{ id?: string }>(
      `${this.graphBase}/${encodeURIComponent(commentId)}/replies`,
      this.authJson(token, { message: text }),
      true,
    );
  }

  async checkFollow(token: string, igsid: string): Promise<FollowCheckOutcome> {
    const r = await this.request<Record<string, unknown>>(
      `${this.graphBase}/${encodeURIComponent(igsid)}?fields=username,is_user_follow_business`,
      this.authGet(token),
      false,
    );
    return interpretFollowResponse(r);
  }
}

/** Never maps missing fields or errors to "not_following". */
export function interpretFollowResponse(r: MetaResult<Record<string, unknown>>): FollowCheckOutcome {
  if (r.ok) {
    const v = r.data?.is_user_follow_business;
    if (v === true) return { result: "following", fieldPresent: true, httpStatus: r.httpStatus };
    if (v === false) return { result: "not_following", fieldPresent: true, httpStatus: r.httpStatus };
    return { result: "unknown", fieldPresent: false, httpStatus: r.httpStatus };
  }
  const err = r.error;
  const base = { fieldPresent: false, httpStatus: err.httpStatus, errorCode: err.code !== undefined ? String(err.code) : err.kind, error: err };
  switch (err.kind) {
    case "no_consent":
      return { result: "needs_interaction", ...base };
    case "permission":
      return { result: "unsupported", ...base };
    case "rate_limited":
    case "retryable":
    case "uncertain":
      return { result: "temporary_error", ...base };
    case "auth":
      return { result: "temporary_error", ...base };
    default:
      return { result: "unknown", ...base };
  }
}
