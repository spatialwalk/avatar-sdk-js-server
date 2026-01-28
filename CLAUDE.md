# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
# Install dependencies
pnpm install

# Build (ESM + CJS)
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck

# Regenerate protobuf code (after modifying proto/message.proto)
pnpm proto:generate
```

## Architecture

This is a TypeScript/JavaScript SDK for WebSocket-based avatar services with audio streaming and animation frame reception. Published as `avatarkit-server` on npm.

Supports multiple runtimes: Node.js, Bun, Deno, and Cloudflare Workers.

### Core Components

- **`avatar-session.ts`** - Main `AvatarSession` class managing WebSocket connections, audio streaming, and frame reception. Uses v2 protocol with HTTP-based session token acquisition followed by WebSocket handshake.

- **`session-config.ts`** - `SessionConfig` interface, `LiveKitEgressConfig` interface, and `SessionConfigBuilder` (fluent builder pattern) for session configuration.

- **`errors.ts`** - `AvatarSDKError` class with stable error codes (`AvatarSDKErrorCode` enum), and `SessionTokenError` for token acquisition failures.

- **`logid.ts`** - `generateLogId()` utility for generating unique log IDs in format "YYYYMMDDHHMMSS_<nanoid>".

- **`websocket.ts`** - `WebSocketLike` interface and `WebSocketFactory` type for cross-runtime WebSocket support.

- **`proto/generated/`** - Auto-generated protobuf code from `proto/message.proto`.

### Session Flow

1. `newAvatarSession()` or `SessionConfigBuilder` creates configuration
2. `session.init()` - HTTP POST to console API for session token
3. `session.start()` - WebSocket connection + v2 handshake, returns connection_id
4. `session.sendAudio()` - Send PCM audio via protobuf
5. Background read loop delivers animation frames via `transportFrames` callback
6. `session.close()` - Cleanup

### Audio Format

Mono 16-bit PCM (s16le) only. Supported sample rates: 8000, 16000, 22050, 24000, 32000, 44100, 48000 Hz.

### Authentication

Two modes controlled by `useQueryAuth`:
- `false` (default): Headers-based auth (mobile pattern)
- `true`: Query params-based auth (web pattern)

### LiveKit Egress Mode (Egress Mode Only)

When configured with `livekitEgress`, audio and animation data are streamed to a LiveKit room via the egress service instead of being returned through the WebSocket connection.

### Interrupt Functionality (Egress Mode Only)

The `interrupt()` method sends an interrupt signal to stop current audio processing. Only available when using LiveKit egress mode.

### Build Output

- `dist/index.js` - ESM build
- `dist/index.cjs` - CommonJS build
- `dist/index.d.ts` - TypeScript declarations
