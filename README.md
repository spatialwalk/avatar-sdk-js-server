# Avatar SDK Server (TypeScript/JavaScript)

A TypeScript/JavaScript SDK for connecting to avatar services via WebSocket, supporting audio streaming and receiving animation frames.

Supports Node.js, Bun, Deno.

## Installation

```bash
pnpm add avatarkit-server
```

For Node.js, you also need the `ws` package:

```bash
pnpm add ws
```

## Quick Start

```typescript
import { newAvatarSession } from "avatarkit-server";

const session = newAvatarSession({
  apiKey: "your-api-key",
  appId: "your-app-id",
  avatarId: "your-avatar-id",
  consoleEndpointUrl: "https://console.us-west.spatialwalk.cloud/v1/console",
  ingressEndpointUrl: "wss://api.us-west.spatialwalk.cloud/v2/driveningress",
  expireAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes from now
  transportFrames: (frame, isLast) => {
    console.log(`Received frame: ${frame.length} bytes, last=${isLast}`);
  },
  onError: (err) => console.error("Error:", err),
  onClose: () => console.log("Session closed"),
});

// Initialize and connect
await session.init();
const connectionId = await session.start();
console.log(`Connected: ${connectionId}`);

// Send audio
const audioData = new Uint8Array([...]); // Your PCM audio data
const requestId = await session.sendAudio(audioData, true);
console.log(`Sent audio: ${requestId}`);

// Close when done
await session.close();
```

## LiveKit Egress Mode

For real-time applications, you can configure LiveKit egress to stream avatar output directly to a LiveKit room:

```typescript
import { newAvatarSession } from "avatarkit-server";

const session = newAvatarSession({
  apiKey: "your-api-key",
  appId: "your-app-id",
  avatarId: "your-avatar-id",
  consoleEndpointUrl: "https://console.us-west.spatialwalk.cloud/v1/console",
  ingressEndpointUrl: "wss://api.us-west.spatialwalk.cloud/v2/driveningress",
  expireAt: new Date(Date.now() + 5 * 60 * 1000),
  livekitEgress: {
    url: "wss://your-livekit-server.com",
    apiKey: "livekit-api-key",
    apiSecret: "livekit-api-secret",
    roomName: "your-room-name",
    publisherId: "avatar-publisher",
    extraAttributes: { role: "avatar", locale: "en-US" },
    idleTimeout: 120,
  },
  onError: (err) => console.error("Error:", err),
  onClose: () => console.log("Session closed"),
});
```

When LiveKit egress is enabled:
- The `transportFrames` callback will **not** be invoked
- Audio and animation data are published directly to the specified LiveKit room
- Your client must use the **avatarkit-livekit-adapter** to render the avatar

`livekitEgress.extraAttributes` lets you pass participant attributes to LiveKit, and
`livekitEgress.idleTimeout` sets idle timeout in seconds (0/undefined uses server defaults).

### Interrupt (LiveKit Egress Only)

When using LiveKit egress mode, you can interrupt ongoing audio processing:

```typescript
// Send audio
const requestId = await session.sendAudio(audioData, true);

// Later, interrupt if needed
const interruptedId = await session.interrupt();
console.log(`Interrupted request: ${interruptedId}`);
```

## Runtime Support

### Node.js

Requires the `ws` package:

```bash
npm install ws
```

### Bun

Works out of the box with Bun's built-in WebSocket.

### Deno

Works with Deno's built-in WebSocket.

### Cloudflare Workers

Works with Cloudflare Workers' WebSocket API. Note that you may need to use a custom WebSocket factory for certain edge cases.

## Custom WebSocket Factory

For environments with non-standard WebSocket implementations, you can provide a custom factory:

```typescript
import { newAvatarSession, WebSocketFactory } from "avatarkit-server";

const customFactory: WebSocketFactory = async (url, headers) => {
  // Your custom WebSocket creation logic
  const ws = new MyCustomWebSocket(url, { headers });
  return ws;
};

const session = newAvatarSession({
  // ... other options
  webSocketFactory: customFactory,
});
```

## API Reference

### `newAvatarSession(options)`

Create a new avatar session with the provided options.

**Options:**
- `avatarId` - Avatar identifier
- `apiKey` - API key for authentication
- `appId` - Application identifier
- `useQueryAuth` - Send auth via query params instead of headers (default: false)
- `expireAt` - Session expiration time
- `sampleRate` - Audio sample rate in Hz (default: 16000)
- `bitrate` - Audio bitrate (default: 0)
- `transportFrames` - Callback for receiving animation frames
- `onError` - Error callback
- `onClose` - Close callback
- `consoleEndpointUrl` - Console API URL
- `ingressEndpointUrl` - Ingress WebSocket URL
- `livekitEgress` - LiveKit egress configuration
- `webSocketFactory` - Custom WebSocket factory
- `fetch` - Custom fetch implementation

### `AvatarSession`

**Methods:**
- `init()` - Initialize session and obtain token
- `start()` - Start WebSocket connection, returns connection ID
- `sendAudio(audio, end)` - Send audio data, returns request ID
- `interrupt()` - Interrupt current processing (LiveKit egress only)
- `close()` - Close the session
- `getConfig()` - Get session configuration
- `getConnectionId()` - Get connection ID

## Audio Format

The SDK currently supports **mono 16-bit PCM (s16le)** audio:

- Sample Rate: 8000, 16000, 22050, 24000, 32000, 44100, or 48000 Hz
- Channels: 1 (mono)
- Bit Depth: 16-bit
- Format: Raw PCM bytes as `Uint8Array`

## Examples

See the [examples](./examples) directory for complete working examples:

- [single-audio-clip](./examples/single-audio-clip) - Basic usage with a single audio file
- [connection-pool](./examples/connection-pool) - Efficient connection pooling for high-throughput scenarios
- [http-service](./examples/http-service) - HTTP API that processes audio and returns animation data

To run an example:

```bash
cd examples/single-audio-clip
pnpm install
pnpm start
```

## License

MIT
