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

export interface LinkButton {
  title: string;
  url: string;
  /** Message text shown above the button (the link itself is usually dropped from it). */
  text: string;
}

export interface OutgoingMessage {
  /** Full plain-text version (used as-is when no template is sent, or as the fallback). */
  text: string;
  quickReplies?: QuickReply[];
  /**
   * Instagram does not make links tappable in a business message the person has not replied to yet,
   * so the content link is sent as a web_url button, which always opens.
   */
  linkButton?: LinkButton;
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
  comments_count?: number;
}

export interface CommentItem {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: { id?: string; username?: string };
  parent_id?: string;
  /** Present when requested as a field expansion (first page of replies). */
  replies?: Paged<CommentItem>;
}

export interface Paged<T> {
  data: T[];
  paging?: { cursors?: { after?: string; before?: string }; next?: string };
}

export type FollowResult = "following" | "not_following" | "unknown" | "needs_interaction" | "temporary_error" | "unsupported";

export interface FollowCheckOutcome {
  result: FollowResult;
  /** Returned by the same User Profile API call; fills in names for people who only messaged (story replies). */
  username?: string;
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
  /** DM with one image attachment (public URL fetched by Meta). Only inside the 24h messaging window. */
  sendImage?(token: string, igUserId: string, recipientId: string, imageUrl: string): Promise<MetaResult<{ message_id?: string }>>;
  replyToComment(token: string, commentId: string, text: string): Promise<MetaResult<{ id?: string }>>;
  checkFollow(token: string, igsid: string): Promise<FollowCheckOutcome>;
  /** One post/reel (used to auto-attach newly published media to a campaign). */
  getMedia?(token: string, mediaId: string): Promise<MetaResult<MediaItem>>;
  /** Latest top-level comments of a post/reel (used to recover comments whose webhook never arrived). */
  listComments?(token: string, mediaId: string): Promise<MetaResult<Paged<CommentItem>>>;
  /** One page of top-level comments (with the first page of replies expanded), for the random picker. */
  listCommentsPage?(token: string, mediaId: string, after?: string): Promise<MetaResult<Paged<CommentItem>>>;
  /** One page of replies to a comment. */
  listReplies?(token: string, commentId: string, after?: string): Promise<MetaResult<Paged<CommentItem>>>;
}
