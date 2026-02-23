import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { newAvatarSession } from "./avatar-session.js";
import { EgressType, MessageSchema, MessageType } from "./proto/generated/message_pb.js";
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
  (session as unknown as { sessionToken: string | null }).sessionToken = token;
}

describe("AvatarSession v2", () => {
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

    expect(ws.sent.length).toBeGreaterThanOrEqual(1);
    const first = fromBinary(MessageSchema, ws.sent[0]);
    expect(first.type).toBe(MessageType.MESSAGE_CLIENT_CONFIGURE_SESSION);
    expect(first.data.case).toBe("clientConfigureSession");
    if (first.data.case === "clientConfigureSession") {
      expect(first.data.value.sampleRate).toBe(16000);
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

  it("start with livekit egress sends livekit fields", async () => {
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

    expect(ws.sent.length).toBeGreaterThanOrEqual(1);
    const first = fromBinary(MessageSchema, ws.sent[0]);
    expect(first.type).toBe(MessageType.MESSAGE_CLIENT_CONFIGURE_SESSION);
    expect(first.data.case).toBe("clientConfigureSession");
    if (first.data.case === "clientConfigureSession") {
      expect(first.data.value.egressType).toBe(EgressType.LIVEKIT);
      expect(first.data.value.livekitEgress?.extraAttributes).toEqual({
        role: "avatar",
        region: "us-west",
      });
      expect(first.data.value.livekitEgress?.idleTimeout).toBe(120);
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
    (
      session as unknown as { handleBinaryMessage: (payload: Uint8Array) => void }
    ).handleBinaryMessage(payload);

    expect(got).toHaveLength(1);
    expect(got[0].isLast).toBe(true);
    expect(got[0].data).toEqual(payload);
  });

  it("start throws on server error during handshake", async () => {
    const ws = new FakeWebSocket();
    const wsFactory = vi.fn(async () => {
      setTimeout(() => ws.emitMessage(makeServerErrorMessage(400, "bad params")), 0);
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

    await expect(session.start()).rejects.toThrow("ServerError during handshake");
    await session.close();
  });
});
