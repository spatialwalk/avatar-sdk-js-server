# Single Audio Clip Example

Demonstrates the basic workflow of connecting to an avatar service, sending a single audio file, and receiving animation frames.

## Setup

1. Create an `audio_16000.pcm` file in this directory (16kHz mono 16-bit PCM audio)

2. Set environment variables:
```bash
export AVATAR_API_KEY="your-api-key"
export AVATAR_APP_ID="your-app-id"
export AVATAR_CONSOLE_ENDPOINT="https://console.us-west.spatialwalk.cloud/v1/console"
export AVATAR_INGRESS_ENDPOINT="https://api.us-west.spatialwalk.cloud/v2/driveningress"
export AVATAR_SESSION_AVATAR_ID="your-avatar-id"
# Optional: export AVATAR_USE_QUERY_AUTH="true"
```

3. Install dependencies and run:
```bash
pnpm install
pnpm start
```

## Output

The example outputs a JSON result with:
- `audio_preview`: First 100 bytes of the audio file
- `animation_count`: Number of animation frames received
- `animation_sizes`: Size of each animation frame in bytes
- `connection_id`: WebSocket connection ID
- `req_id`: Request ID for the audio
