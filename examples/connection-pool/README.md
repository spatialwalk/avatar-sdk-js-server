# Connection Pool Example

Demonstrates efficient resource management by maintaining a pool of pre-initialized connections and processing multiple concurrent audio requests over multiple rounds.

## Features

- Pre-initializes 100 WebSocket connections
- Runs 10 rounds of 5 concurrent requests each
- 30-second intervals between rounds
- Tracks connection usage statistics
- Comprehensive performance reporting

## Setup

1. Create an `audio_16000.pcm` file in this directory (16kHz mono 16-bit PCM audio)

2. Set environment variables:
```bash
export AVATAR_API_KEY="your-api-key"
export AVATAR_APP_ID="your-app-id"
export AVATAR_CONSOLE_ENDPOINT="https://console.us-west.spatialwalk.cloud/v1/console"
export AVATAR_INGRESS_ENDPOINT="https://api.us-west.spatialwalk.cloud/v2/driveningress"
export AVATAR_SESSION_AVATAR_ID="your-avatar-id"
```

3. Install dependencies and run:
```bash
pnpm install
pnpm start
```

## Configuration

You can modify these constants in `main.ts`:

- `POOL_SIZE`: Number of connections to pre-initialize (default: 100)
- `CONCURRENT_REQUESTS`: Requests per round (default: 5)
- `NUM_ROUNDS`: Number of test rounds (default: 10)
- `ROUND_INTERVAL_MS`: Delay between rounds (default: 30000ms)
- `SESSION_TTL_MS`: Session time-to-live (default: 10 minutes)
- `REQUEST_TIMEOUT_MS`: Per-request timeout (default: 45000ms)

## Output

The example outputs:
- Per-round statistics (OK/FAILED counts, duration, average frames)
- Overall summary with success rate and averages
- Connection usage distribution showing which connections handled how many requests
