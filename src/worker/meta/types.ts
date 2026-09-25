/** Outcome classes for a Meta API call. */
export type MetaErrorKind =
  | "rate_limited" // retry later (respect Retry-After / BUC usage)
  | "retryable" // transient server/network error before the request was delivered
  | "uncertain" // request may have been delivered (timeout / connection lost after send)
  | "auth" // token invalid/expired/revoked → account needs re-auth
  | "permission" // missing permission / feature not available for this app or account
  | "window_closed" // outside the allowed messaging window
  | "no_consent" // User Profile API: user has not interacted yet
  | "permanent"; // anything else that must not be retried

export interface MetaError {
  kind: MetaErrorKind;
  httpStatus?: number;
  code?: number;
  subcode?: number;
  message: string; // sanitized (never contains tokens)
  retryAfterMs?: number;
}

export type MetaResult<T> = { ok: true; data: T; httpStatus: number } | { ok: false; error: MetaError };

export interface QuickReply {
  title: string;
  payload: string;
}

export interface OutgoingMessage {
  text: string;
  quickReplies?: QuickReply[];
}

export interface MeProfile {
  id?: string; // app-scoped id
  user_id?: string; // IG professional account id (matches webhook entry.id)
  username?: string;
  name?: string;
  profile_picture_url?: string;
  account_type?: string;
}

export interface MediaItem {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  thumbnail_url?: string;
  media_url?: string;
  timestamp?: string;
}

export interface Paged<T> {
  data: T[];
  paging?: { cursors?: { after?: string; before?: string }; next?: string };
}

export type FollowResult = "following" | "not_following" | "unknown" | "needs_interaction" | "temporary_error" | "unsupported";

export interface FollowCheckOutcome {
  result: FollowResult;
  fieldPresent: boolean;
  httpStatus?: number;
  errorCode?: string;
  error?: MetaError;
}

export interface TokenExchange {
  access_token: string;
  user_id?: string;
  permissions?: string[];
  expires_in?: number;
}

/** Everything the engine needs from Meta. Implemented by the real HTTP client and by the demo simulator. */
export interface MetaClient {
  sendPrivateReply(token: string, igUserId: string, commentId: string, msg: OutgoingMessage): Promise<MetaResult<{ message_id?: string }>>;
  sendMessage(token: string, igUserId: string, recipientId: string, msg: OutgoingMessage): Promise<MetaResult<{ message_id?: string }>>;
  replyToComment(token: string, commentId: string, text: string): Promise<MetaResult<{ id?: string }>>;
  checkFollow(token: string, igsid: string): Promise<FollowCheckOutcome>;
}
