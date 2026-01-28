/**
 * Error codes for Avatar SDK errors.
 */
export enum AvatarSDKErrorCode {
  /** Session token has expired (HTTP 401) */
  SessionTokenExpired = "sessionTokenExpired",
  /** Session token is invalid (HTTP 400) */
  SessionTokenInvalid = "sessionTokenInvalid",
  /** App ID is not recognized (HTTP 404) */
  AppIDUnrecognized = "appIDUnrecognized",
  /** Unknown error */
  Unknown = "unknown",
}

/**
 * Error class for Avatar SDK specific errors.
 */
export class AvatarSDKError extends Error {
  readonly code: AvatarSDKErrorCode;

  constructor(code: AvatarSDKErrorCode, message: string) {
    super(message);
    this.name = "AvatarSDKError";
    this.code = code;
  }
}

/**
 * Error thrown when session token request fails.
 */
export class SessionTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionTokenError";
  }
}
