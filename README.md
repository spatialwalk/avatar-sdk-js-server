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
