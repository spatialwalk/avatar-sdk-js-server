import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { newAvatarSession } from "./avatar-session.js";
import { AudioFormat } from "./session-config.js";
import { AvatarSDKError, AvatarSDKErrorCode } from "./errors.js";
import {
  EgressType,
  MessageSchema,
  MessageType,
  AudioFormat as ProtoAudioFormat,
} from "./proto/generated/message_pb.js";
import { WebSocketLike, WebSocketReadyState } from "./websocket.js";

class FakeWebSocket implements WebSocketLike {
  readyState: number = WebSocketReadyState.OPEN;
  sent: Uint8Array[] = [];

  private readonly messageListeners = new Set<
    (event: { data: ArrayBuffer | Uint8Array | Blob }) => void
  >();
  private readonly closeListeners = new Set<(event: { code: number; reason: string }) => void>();
  private readonly errorListeners = new Set<(event: unknown) => void>();
  private readonly openListeners = new Set<() => void>();

  send(data: ArrayBuffer | Uint8Array): void {
    this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  close(code = 1000, reason = ""): void {
    this.readyState = WebSocketReadyState.CLOSED;
    for (const listener of this.closeListeners) {
      listener({ code, reason });
    }
  }

  addEventListener(
    type: "message",
    listener: (event: { data: ArrayBuffer | Uint8Array | Blob }) => void
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message" | "close" | "error" | "open",
    listener:
      | ((event: { data: ArrayBuffer | Uint8Array | Blob }) => void)
      | ((event: { code: number; reason: string }) => void)
      | ((event: unknown) => void)
      | (() => void)
  ): void {
    if (type === "message") {
      this.messageListeners.add(
        listener as (event: { data: ArrayBuffer | Uint8Array | Blob }) => void
      );
      return;
    }
    if (type === "close") {
      this.closeListeners.add(listener as (event: { code: number; reason: string }) => void);
      return;
    }
    if (type === "error") {
      this.errorListeners.add(listener as (event: unknown) => void);
      return;
    }
    this.openListeners.add(listener as () => void);
  }

  removeEventListener(type: string, listener: (...args: unknown[]) => void): void {
    if (type === "message") {
      this.messageListeners.delete(
        listener as unknown as (event: { data: ArrayBuffer | Uint8Array | Blob }) => void
      );
      return;
    }
    if (type === "close") {
      this.closeListeners.delete(
        listener as unknown as (event: { code: number; reason: string }) => void
      );
      return;
    }
    if (type === "error") {
      this.errorListeners.delete(listener as unknown as (event: unknown) => void);
      return;
    }
    if (type === "open") {
      this.openListeners.delete(listener as unknown as () => void);
    }
  }

  emitMessage(data: Uint8Array): void {
    for (const listener of this.messageListeners) {
      listener({ data });
    }
  }
}

type AvatarSessionInternals = {
  sessionToken: string | null;
  handleBinaryMessage(payload: Uint8Array): void;
};

function makeConfirmMessage(connectionId: string): Uint8Array {
  return toBinary(
    MessageSchema,
    create(MessageSchema, {
      type: MessageType.MESSAGE_SERVER_CONFIRM_SESSION,
      data: {
        case: "serverConfirmSession",
        value: { connectionId },
      },
    })
  );
}

function makeServerErrorMessage(code: number, message: string): Uint8Array {
  return toBinary(
    MessageSchema,
    create(MessageSchema, {
      type: MessageType.MESSAGE_SERVER_ERROR,
      data: {
        case: "serverError",
        value: {
          connectionId: "cid",
          reqId: "rid",
          code,
          message,
        },
      },
    })
  );
}

function makeAnimationMessage(isLast: boolean): Uint8Array {
  return toBinary(
    MessageSchema,
    create(MessageSchema, {
      type: MessageType.MESSAGE_SERVER_RESPONSE_ANIMATION,
      data: {
        case: "serverResponseAnimation",
        value: {
          connectionId: "cid",
          reqId: "rid",
          end: isLast,
        },
      },
    })
  );
}

function setSessionToken(session: ReturnType<typeof newAvatarSession>, token: string): void {
  (session as unknown as AvatarSessionInternals).sessionToken = token;
}

describe("AvatarSession v2", () => {
  it("init surfaces structured session token errors", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          errors: [
            {
              status: 400,
              code: "INVALID_ARGUMENT",
              title: "Invalid Argument",
              detail: "expire_at must be in the future",
            },
          ],
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const failingSession = newAvatarSession({
      consoleEndpointUrl: "https://console.example.com",
      apiKey: "api",
      expireAt: new Date("2026-03-24T00:00:00Z"),
      fetch: fetchFn as typeof fetch,
    });

    await expect(failingSession.init()).rejects.toMatchObject({
      name: "SessionTokenError",
      code: AvatarSDKErrorCode.InvalidRequest,
      phase: "session_token",
      httpStatus: 400,
      serverCode: "INVALID_ARGUMENT",
      serverTitle: "Invalid Argument",
      serverDetail: "expire_at must be in the future",
    });
  });

  it("init wraps transport errors as session token errors", async () => {
    const session = newAvatarSession({
      consoleEndpointUrl: "https://console.example.com",
      apiKey: "api",
      expireAt: new Date("2026-03-24T00:00:00Z"),
      fetch: vi.fn(async () => {
        throw new Error("network down");
      }) as typeof fetch,
    });

    await expect(session.init()).rejects.toMatchObject({
      name: "SessionTokenError",
      code: AvatarSDKErrorCode.ConnectionFailed,
      phase: "session_token",
    });
  });

  it("start with header auth builds URL/headers and handshakes", async () => {
    const ws = new FakeWebSocket();
    const captured: { url: string; headers: Record<string, string> } = {
      url: "",
      headers: {},
    };

    const wsFactory = vi.fn(async (url: string, headers?: Record<string, string>) => {
      captured.url = url;
      captured.headers = { ...(headers ?? {}) };
      setTimeout(() => ws.emitMessage(makeConfirmMessage("server-conn")), 0);
      return ws;
    });

    const session = newAvatarSession({
      ingressEndpointUrl: "https://ingress.example.com",
      consoleEndpointUrl: "https://console.example.com",
      apiKey: "api",
      avatarId: "avatar-1",
      appId: "app-1",
      useQueryAuth: false,
      webSocketFactory: wsFactory,
    });
    setSessionToken(session, "tok-1");

    const connectionId = await session.start();

    expect(connectionId).toBe("server-conn");
    const parsed = new URL(captured.url);
    expect(parsed.searchParams.get("id")).toBe("avatar-1");
    expect(parsed.searchParams.has("appId")).toBe(false);
    expect(parsed.searchParams.has("sessionKey")).toBe(false);
    expect(captured.headers).toEqual({
      "X-App-ID": "app-1",
      "X-Session-Key": "tok-1",
    });

    const first = fromBinary(MessageSchema, ws.sent[0]);
    expect(first.type).toBe(MessageType.MESSAGE_CLIENT_CONFIGURE_SESSION);
    expect(first.data.case).toBe("clientConfigureSession");
    if (first.data.case === "clientConfigureSession") {
      expect(first.data.value.sampleRate).toBe(16000);
      expect(first.data.value.audioFormat).toBe(ProtoAudioFormat.PCM_S16LE);
    }

    await session.close();
  });

  it("start with query auth uses query parameters", async () => {
    const ws = new FakeWebSocket();
    const captured: { url: string; headers: Record<string, string> } = {
      url: "",
      headers: {},
    };

    const wsFactory = vi.fn(async (url: string, headers?: Record<string, string>) => {
      captured.url = url;
      captured.headers = { ...(headers ?? {}) };
      setTimeout(() => ws.emitMessage(makeConfirmMessage("server-conn")), 0);
      return ws;
    });

    const session = newAvatarSession({
      ingressEndpointUrl: "https://ingress.example.com",
      consoleEndpointUrl: "https://console.example.com",
      apiKey: "api",
      avatarId: "avatar-1",
      appId: "app-1",
      useQueryAuth: true,
      webSocketFactory: wsFactory,
    });
    setSessionToken(session, "tok-1");

    await session.start();

    const parsed = new URL(captured.url);
    expect(parsed.searchParams.get("id")).toBe("avatar-1");
    expect(parsed.searchParams.get("appId")).toBe("app-1");
    expect(parsed.searchParams.get("sessionKey")).toBe("tok-1");
    expect(captured.headers).toEqual({});

    await session.close();
  });

  it("start with livekit egress sends api token and existing egress fields", async () => {
    const ws = new FakeWebSocket();
    const wsFactory = vi.fn(async () => {
      setTimeout(() => ws.emitMessage(makeConfirmMessage("server-conn")), 0);
      return ws;
    });

    const session = newAvatarSession({
      ingressEndpointUrl: "https://ingress.example.com",
      consoleEndpointUrl: "https://console.example.com",
      apiKey: "api",
      avatarId: "avatar-1",
      appId: "app-1",
      livekitEgress: {
        url: "wss://livekit.example.com",
        apiKey: "lk-api-key",
        apiSecret: "lk-api-secret",
        apiToken: "lk-token",
        roomName: "lk-room",
        publisherId: "publisher-1",
        extraAttributes: {
          role: "avatar",
          region: "us-west",
        },
        idleTimeout: 120,
      },
      webSocketFactory: wsFactory,
    });
    setSessionToken(session, "tok-1");

    await session.start();

    const first = fromBinary(MessageSchema, ws.sent[0]);
    expect(first.type).toBe(MessageType.MESSAGE_CLIENT_CONFIGURE_SESSION);
    expect(first.data.case).toBe("clientConfigureSession");
    if (first.data.case === "clientConfigureSession") {
      expect(first.data.value.egressType).toBe(EgressType.LIVEKIT);
      expect(first.data.value.livekitEgress?.apiToken).toBe("lk-token");
      expect(first.data.value.livekitEgress?.extraAttributes).toEqual({
        role: "avatar",
        region: "us-west",
      });
      expect(first.data.value.livekitEgress?.idleTimeout).toBe(120);
    }

    await session.close();
  });

  it("start with ogg opus sends negotiated audio format", async () => {
    const ws = new FakeWebSocket();
    const wsFactory = vi.fn(async () => {
      setTimeout(() => ws.emitMessage(makeConfirmMessage("server-conn")), 0);
      return ws;
    });

    const session = newAvatarSession({
      ingressEndpointUrl: "https://ingress.example.com",
      consoleEndpointUrl: "https://console.example.com",
      apiKey: "api",
      avatarId: "avatar-1",
      appId: "app-1",
      sampleRate: 24000,
      bitrate: 32000,
      audioFormat: AudioFormat.OGG_OPUS,
      webSocketFactory: wsFactory,
    });
    setSessionToken(session, "tok-1");

    await session.start();

    const first = fromBinary(MessageSchema, ws.sent[0]);
    expect(first.data.case).toBe("clientConfigureSession");
    if (first.data.case === "clientConfigureSession") {
      expect(first.data.value.sampleRate).toBe(24000);
      expect(first.data.value.bitrate).toBe(32000);
      expect(first.data.value.audioFormat).toBe(ProtoAudioFormat.OGG_OPUS);
    }

    await session.close();
  });

  it("sendAudio preserves pre-encoded ogg opus payloads", async () => {
    const ws = new FakeWebSocket();
    const wsFactory = vi.fn(async () => {
      setTimeout(() => ws.emitMessage(makeConfirmMessage("server-conn")), 0);
      return ws;
    });

    const session = newAvatarSession({
      ingressEndpointUrl: "https://ingress.example.com",
      consoleEndpointUrl: "https://console.example.com",
      apiKey: "api",
      avatarId: "avatar-1",
      appId: "app-1",
      audioFormat: AudioFormat.OGG_OPUS,
      webSocketFactory: wsFactory,
    });
    setSessionToken(session, "tok-1");

    await session.start();

    const payload = new Uint8Array([79, 103, 103, 83, 1, 2, 3]);
    const reqId = await session.sendAudio(payload, true);
    const second = fromBinary(MessageSchema, ws.sent[1]);

    expect(second.data.case).toBe("clientAudioInput");
    if (second.data.case === "clientAudioInput") {
      expect(second.data.value.reqId).toBe(reqId);
      expect(second.data.value.audio).toEqual(payload);
      expect(second.data.value.end).toBe(true);
    }

    await session.close();
  });

  it("handleBinaryMessage forwards animation end flag", () => {
    const got: Array<{ data: Uint8Array; isLast: boolean }> = [];

    const session = newAvatarSession({
      ingressEndpointUrl: "https://ingress.example.com",
      consoleEndpointUrl: "https://console.example.com",
      apiKey: "api",
      avatarId: "avatar-1",
      appId: "app-1",
      transportFrames: (data, isLast) => {
        got.push({ data, isLast });
      },
    });

    const payload = makeAnimationMessage(true);
    (session as unknown as AvatarSessionInternals).handleBinaryMessage(payload);

    expect(got).toHaveLength(1);
    expect(got[0].isLast).toBe(true);
    expect(got[0].data).toEqual(payload);
  });

  it("start maps websocket HTTP rejection to structured sdk error", async () => {
    const session = newAvatarSession({
      ingressEndpointUrl: "https://ingress.example.com",
      consoleEndpointUrl: "https://console.example.com",
      apiKey: "api",
      avatarId: "avatar-1",
      appId: "app-1",
      webSocketFactory: vi.fn(async () => {
        throw {
          status: 400,
          body: '{"message":"Invalid session token"}\n',
        };
      }),
    });
    setSessionToken(session, "tok-1");

    await expect(session.start()).rejects.toMatchObject({
      code: AvatarSDKErrorCode.SessionTokenInvalid,
      phase: "websocket_connect",
      httpStatus: 400,
      serverDetail: "Invalid session token",
      rawBody: '{"message":"Invalid session token"}\n',
    });
  });

  it("start maps avatar not found rejection from websocket connect", async () => {
    const session = newAvatarSession({
      ingressEndpointUrl: "https://ingress.example.com",
      consoleEndpointUrl: "https://console.example.com",
      apiKey: "api",
      avatarId: "avatar-1",
      appId: "app-1",
      webSocketFactory: vi.fn(async () => {
        throw {
          statusCode: 404,
          response: {
            body: '{"message":"Avatar not found: avatar-1"}\n',
          },
        };
      }),
    });
    setSessionToken(session, "tok-1");

    await expect(session.start()).rejects.toMatchObject({
      code: AvatarSDKErrorCode.AvatarNotFound,
      phase: "websocket_connect",
      httpStatus: 404,
      serverDetail: "Avatar not found: avatar-1",
    });
  });

  it("start throws structured error on server error during handshake", async () => {
    const ws = new FakeWebSocket();
    const wsFactory = vi.fn(async () => {
      setTimeout(
        () => ws.emitMessage(makeServerErrorMessage(0, "unsupported sample rate: 12345")),
        0
      );
      return ws;
    });

    const session = newAvatarSession({
      ingressEndpointUrl: "https://ingress.example.com",
      consoleEndpointUrl: "https://console.example.com",
      apiKey: "api",
      avatarId: "avatar-1",
      appId: "app-1",
      webSocketFactory: wsFactory,
    });
    setSessionToken(session, "tok-1");

    await expect(session.start()).rejects.toMatchObject({
      code: AvatarSDKErrorCode.UnsupportedSampleRate,
      phase: "websocket_handshake",
      serverCode: "0",
      serverDetail: "unsupported sample rate: 12345",
    });
  });

  it("runtime server errors reach onError as AvatarSDKError", () => {
    const got: Error[] = [];
    const session = newAvatarSession({
      ingressEndpointUrl: "https://ingress.example.com",
      consoleEndpointUrl: "https://console.example.com",
      apiKey: "api",
      avatarId: "avatar-1",
      appId: "app-1",
      onError: (error) => {
        got.push(error);
      },
    });

    (session as unknown as AvatarSessionInternals).handleBinaryMessage(
      makeServerErrorMessage(4001, "Credits exhausted")
    );

    expect(got).toHaveLength(1);
    expect(got[0]).toBeInstanceOf(AvatarSDKError);
    expect(got[0]).toMatchObject({
      code: AvatarSDKErrorCode.CreditsExhausted,
      phase: "websocket_runtime",
      serverCode: "4001",
      serverDetail: "Credits exhausted",
      connectionId: "cid",
      reqId: "rid",
    });
  });
});
