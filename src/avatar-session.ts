import { SessionConfig, SessionConfigBuilder, LiveKitEgressConfig } from "./session-config.js";
import { AvatarSDKError, AvatarSDKErrorCode, SessionTokenError } from "./errors.js";
import { generateLogId } from "./logid.js";
import { WebSocketLike, WebSocketFactory, defaultWebSocketFactory } from "./websocket.js";
import {
  Message,
  MessageSchema,
  MessageType,
  AudioFormat,
  TransportCompression,
  EgressType,
} from "./proto/generated/message_pb.js";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";

const SESSION_TOKEN_PATH = "/session-tokens";
const INGRESS_WEBSOCKET_PATH = "/websocket";

export interface AvatarSessionOptions {
  /** Custom WebSocket factory for different runtimes */
  webSocketFactory?: WebSocketFactory;
  /** Custom fetch implementation (for environments without global fetch) */
  fetch?: typeof fetch;
}

/**
 * Manages an active avatar session with WebSocket communication.
 */
export class AvatarSession {
  private readonly config: SessionConfig;
  private readonly options: AvatarSessionOptions;
  private sessionToken: string | null = null;
  private connection: WebSocketLike | null = null;
  private currentReqId: string | null = null;
  private lastReqId: string | null = null;
  private _connectionId: string | null = null;
  private readLoopActive = false;

  constructor(config: SessionConfig, options: AvatarSessionOptions = {}) {
    this.config = config;
    this.options = options;
  }

  /**
   * Get the session configuration.
   */
  getConfig(): SessionConfig {
    return this.config;
  }

  /**
   * Get the connection ID (available after start() completes).
   */
  getConnectionId(): string | null {
    return this._connectionId;
  }

  /**
   * Exchange configuration credentials for a session token from the console API.
   */
  async init(): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error("Missing API key");
    }
    if (!this.config.consoleEndpointUrl) {
      throw new Error("Missing console endpoint URL");
    }
    if (!this.config.expireAt) {
      throw new Error("Missing expireAt");
    }

    const endpoint = this.config.consoleEndpointUrl.replace(/\/$/, "") + SESSION_TOKEN_PATH;

    const payload = {
      expireAt: Math.floor(this.config.expireAt.getTime() / 1000),
    };

    const fetchFn = this.options.fetch ?? globalThis.fetch;

    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "X-Api-Key": this.config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      let errorMsg: string;
      try {
        const errorData = JSON.parse(responseText);
        errorMsg = this.formatSessionTokenError(response.status, errorData);
      } catch {
        errorMsg = `Request failed with status ${response.status}`;
      }
      throw new SessionTokenError(errorMsg);
    }

    let responseData: {
      sessionToken?: string;
      errors?: Array<{ status?: number; code?: string; title?: string; detail?: string }>;
    };
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      throw new SessionTokenError(`Failed to decode response: ${e}`);
    }

    if (responseData.errors && responseData.errors.length > 0) {
      const errorMsg = this.formatSessionTokenError(response.status, responseData);
      throw new SessionTokenError(errorMsg);
    }

    if (!responseData.sessionToken) {
      throw new SessionTokenError("Empty session token in response");
    }

    this.sessionToken = responseData.sessionToken;
  }

  /**
   * Establish WebSocket connection to the ingress endpoint.
   * @returns Connection ID for tracking this session.
   */
  async start(): Promise<string> {
    if (this.connection !== null) {
      throw new Error("Session already started");
    }
    if (!this.sessionToken) {
      throw new Error("Session not initialized");
    }
    if (!this.config.ingressEndpointUrl) {
      throw new Error("Missing ingress endpoint URL");
    }
    if (!this.config.avatarId) {
      throw new Error("Missing avatar ID");
    }
    if (!this.config.appId) {
      throw new Error("Missing app ID");
    }

    const endpoint = this.config.ingressEndpointUrl.replace(/\/$/, "") + INGRESS_WEBSOCKET_PATH;

    // Parse URL and convert to WebSocket scheme
    const url = new URL(endpoint);
    const scheme = url.protocol.toLowerCase();

    if (scheme === "http:") {
      url.protocol = "ws:";
    } else if (scheme === "https:") {
      url.protocol = "wss:";
    } else if (scheme !== "ws:" && scheme !== "wss:") {
      throw new Error(`Unsupported scheme: ${scheme}`);
    }

    // Add avatar ID to query parameters
    url.searchParams.set("id", this.config.avatarId);

    // v2 auth: mobile uses headers; web uses query params
    const headers: Record<string, string> = {};
    if (this.config.useQueryAuth) {
      url.searchParams.set("appId", this.config.appId);
      url.searchParams.set("sessionKey", this.sessionToken);
    } else {
      headers["X-App-ID"] = this.config.appId;
      headers["X-Session-Key"] = this.sessionToken;
    }

    const wsFactory = this.options.webSocketFactory ?? defaultWebSocketFactory;

    try {
      this.connection = await wsFactory(url.toString(), headers);
    } catch (e) {
      const code = this.mapWsConnectErrorToCode(e);
      if (code !== null) {
        throw new AvatarSDKError(code, `WebSocket auth failed: ${e}`);
      }
      throw new Error(`Failed to connect to websocket: ${e}`);
    }

    // v2 handshake
    await this.sendClientConfigureSession();
    const serverConnectionId = await this.awaitServerConfirmSession();
    this._connectionId = serverConnectionId;

    // Start read loop
    this.startReadLoop();

    return serverConnectionId;
  }

  private async sendClientConfigureSession(): Promise<void> {
    if (!this.connection) {
      throw new Error("WebSocket connection is not established");
    }

    const msg = create(MessageSchema, {
      type: MessageType.MESSAGE_CLIENT_CONFIGURE_SESSION,
      data: {
        case: "clientConfigureSession",
        value: {
          sampleRate: this.config.sampleRate,
          bitrate: this.config.bitrate,
          audioFormat: AudioFormat.PCM_S16LE,
          transportCompression: TransportCompression.NONE,
          egressType: this.config.livekitEgress ? EgressType.LIVEKIT : EgressType.UNSPECIFIED,
          livekitEgress: this.config.livekitEgress
            ? {
                url: this.config.livekitEgress.url,
                apiKey: this.config.livekitEgress.apiKey,
                apiSecret: this.config.livekitEgress.apiSecret,
                roomName: this.config.livekitEgress.roomName,
                publisherId: this.config.livekitEgress.publisherId,
                extraAttributes: this.config.livekitEgress.extraAttributes,
                idleTimeout: this.config.livekitEgress.idleTimeout,
              }
            : undefined,
        },
      },
    });

    const data = toBinary(MessageSchema, msg);
    this.connection.send(data);
  }

  private async awaitServerConfirmSession(): Promise<string> {
    if (!this.connection) {
      throw new Error("WebSocket connection is not established");
    }

    return new Promise((resolve, reject) => {
      const onMessage = (event: { data: ArrayBuffer | Uint8Array | Blob }) => {
        try {
          let data: Uint8Array;
          if (event.data instanceof ArrayBuffer) {
            data = new Uint8Array(event.data);
          } else if (event.data instanceof Uint8Array) {
            data = event.data;
          } else {
            reject(new Error("Failed during websocket handshake: expected binary message"));
            return;
          }

          const envelope = fromBinary(MessageSchema, data);

          if (envelope.type === MessageType.MESSAGE_SERVER_CONFIRM_SESSION) {
            if (envelope.data.case === "serverConfirmSession") {
              const cid = envelope.data.value.connectionId;
              if (!cid) {
                reject(new Error("Handshake succeeded but connection_id is empty"));
                return;
              }
              this.connection?.removeEventListener("message", onMessage as never);
              resolve(cid);
            }
          } else if (envelope.type === MessageType.MESSAGE_SERVER_ERROR) {
            if (envelope.data.case === "serverError") {
              const err = envelope.data.value;
              reject(
                new Error(
                  `ServerError during handshake (connection_id=${err.connectionId}, req_id=${err.reqId}, code=${err.code}): ${err.message}`
                )
              );
            }
          } else {
            reject(new Error(`Unexpected message during handshake: type=${envelope.type}`));
          }
        } catch (e) {
          reject(new Error(`Failed during websocket handshake: ${e}`));
        }
      };

      const onError = (e: unknown) => {
        reject(new Error(`WebSocket error during handshake: ${e}`));
      };

      this.connection!.addEventListener("message", onMessage as never);
      this.connection!.addEventListener("error", onError);
    });
  }

  /**
   * Send audio data to the server.
   * @param audio - Raw audio bytes to send
   * @param end - Whether this is the last audio chunk for the current request
   * @returns Request ID for tracking this audio request
   */
  async sendAudio(audio: Uint8Array, end = false): Promise<string> {
    if (!this.connection) {
      throw new Error("WebSocket connection is not established");
    }

    // Generate or reuse request ID
    if (!this.currentReqId) {
      this.currentReqId = generateLogId();
      this.lastReqId = this.currentReqId;
    }

    const reqId = this.currentReqId;

    const msg = create(MessageSchema, {
      type: MessageType.MESSAGE_CLIENT_AUDIO_INPUT,
      data: {
        case: "clientAudioInput",
        value: {
          reqId,
          audio,
          end,
        },
      },
    });

    const data = toBinary(MessageSchema, msg);
    this.connection.send(data);

    if (end) {
      this.currentReqId = null;
    }

    return reqId;
  }

  /**
   * Send an interrupt signal to stop the current audio processing.
   * Only works with LiveKit egress mode.
   * @returns The request ID that was interrupted
   */
  async interrupt(): Promise<string> {
    if (!this.connection) {
      throw new Error("interrupt: websocket connection is not established");
    }

    const reqId = this.lastReqId;
    if (!reqId) {
      throw new Error("interrupt: no request to interrupt");
    }

    const msg = create(MessageSchema, {
      type: MessageType.MESSAGE_CLIENT_INTERRUPT,
      data: {
        case: "clientInterrupt",
        value: {
          reqId,
        },
      },
    });

    const data = toBinary(MessageSchema, msg);
    this.connection.send(data);

    // Clear current request ID so next sendAudio creates a new one
    this.currentReqId = null;

    return reqId;
  }

  /**
   * Close the WebSocket connection and clean up resources.
   */
  async close(): Promise<void> {
    this.readLoopActive = false;

    if (this.connection) {
      try {
        this.connection.close();
      } catch {
        // Ignore close errors
      }
      this.connection = null;
    }

    if (this.config.onClose) {
      try {
        this.config.onClose();
      } catch {
        // Don't let callback errors propagate
      }
    }
  }

  private startReadLoop(): void {
    if (!this.connection) return;

    this.readLoopActive = true;

    this.connection.addEventListener("message", (event) => {
      if (!this.readLoopActive) return;

      try {
        let data: Uint8Array;
        if (event.data instanceof ArrayBuffer) {
          data = new Uint8Array(event.data);
        } else if (event.data instanceof Uint8Array) {
          data = event.data;
        } else {
          return;
        }

        this.handleBinaryMessage(data);
      } catch (e) {
        if (this.config.onError) {
          try {
            this.config.onError(new Error(`Read loop error: ${e}`));
          } catch {
            // Ignore callback errors
          }
        }
      }
    });

    this.connection.addEventListener("close", () => {
      this.readLoopActive = false;
      this.close();
    });

    this.connection.addEventListener("error", (e) => {
      if (this.config.onError) {
        try {
          this.config.onError(new Error(`WebSocket error: ${e}`));
        } catch {
          // Ignore callback errors
        }
      }
    });
  }

  private handleBinaryMessage(payload: Uint8Array): void {
    let envelope: Message;
    try {
      envelope = fromBinary(MessageSchema, payload);
    } catch (e) {
      if (this.config.onError) {
        try {
          this.config.onError(new Error(`Failed to decode message: ${e}`));
        } catch {
          // Ignore callback errors
        }
      }
      return;
    }

    if (envelope.type === MessageType.MESSAGE_SERVER_RESPONSE_ANIMATION) {
      if (this.config.transportFrames && envelope.data.case === "serverResponseAnimation") {
        const isLast = envelope.data.value.end;
        try {
          this.config.transportFrames(payload, isLast);
        } catch {
          // Ignore callback errors
        }
      }
    } else if (envelope.type === MessageType.MESSAGE_SERVER_ERROR) {
      if (this.config.onError && envelope.data.case === "serverError") {
        const err = envelope.data.value;
        const errorMsg = `Avatar session error (connection_id=${err.connectionId}, req_id=${err.reqId}, code=${err.code}): ${err.message}`;
        try {
          this.config.onError(new Error(errorMsg));
        } catch {
          // Ignore callback errors
        }
      }
    }
  }

  private mapWsConnectErrorToCode(e: unknown): AvatarSDKErrorCode | null {
    const status =
      (e as { status?: number })?.status ??
      (e as { statusCode?: number })?.statusCode ??
      (e as { response?: { status?: number } })?.response?.status;

    if (status === 401) return AvatarSDKErrorCode.SessionTokenExpired;
    if (status === 400) return AvatarSDKErrorCode.SessionTokenInvalid;
    if (status === 404) return AvatarSDKErrorCode.AppIDUnrecognized;
    return null;
  }

  private formatSessionTokenError(
    status: number,
    responseData: {
      errors?: Array<{ status?: number; code?: string; title?: string; detail?: string }>;
    }
  ): string {
    const errors = responseData.errors ?? [];
    if (errors.length === 0) {
      return `Unknown error with status ${status}`;
    }

    const err = errors[0];
    return `Error ${err.status ?? status} (${err.code ?? "unknown"}): ${err.title ?? "Error"} - ${err.detail ?? "No details"}`;
  }
}

/**
 * Options for creating a new avatar session.
 */
export interface NewAvatarSessionOptions {
  avatarId?: string;
  apiKey?: string;
  appId?: string;
  useQueryAuth?: boolean;
  expireAt?: Date;
  sampleRate?: number;
  bitrate?: number;
  transportFrames?: (data: Uint8Array, isLast: boolean) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  consoleEndpointUrl?: string;
  ingressEndpointUrl?: string;
  livekitEgress?: LiveKitEgressConfig;
  /** Custom WebSocket factory for different runtimes */
  webSocketFactory?: WebSocketFactory;
  /** Custom fetch implementation */
  fetch?: typeof fetch;
}

/**
 * Create a new AvatarSession with the provided configuration options.
 */
export function newAvatarSession(options: NewAvatarSessionOptions): AvatarSession {
  const builder = new SessionConfigBuilder();

  if (options.avatarId) builder.withAvatarId(options.avatarId);
  if (options.apiKey) builder.withApiKey(options.apiKey);
  if (options.appId) builder.withAppId(options.appId);
  if (options.useQueryAuth !== undefined) builder.withUseQueryAuth(options.useQueryAuth);
  if (options.expireAt) builder.withExpireAt(options.expireAt);
  if (options.sampleRate !== undefined) builder.withSampleRate(options.sampleRate);
  if (options.bitrate !== undefined) builder.withBitrate(options.bitrate);
  if (options.transportFrames) builder.withTransportFrames(options.transportFrames);
  if (options.onError) builder.withOnError(options.onError);
  if (options.onClose) builder.withOnClose(options.onClose);
  if (options.consoleEndpointUrl) builder.withConsoleEndpointUrl(options.consoleEndpointUrl);
  if (options.ingressEndpointUrl) builder.withIngressEndpointUrl(options.ingressEndpointUrl);
  if (options.livekitEgress) builder.withLivekitEgress(options.livekitEgress);

  const config = builder.build();

  return new AvatarSession(config, {
    webSocketFactory: options.webSocketFactory,
    fetch: options.fetch,
  });
}
