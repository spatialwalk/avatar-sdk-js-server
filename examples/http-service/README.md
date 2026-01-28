# HTTP Service Example

Exposes an HTTP API that accepts POST requests with a desired sample rate, loads the corresponding PCM audio file, processes it through the avatar service, and returns the results as JSON.

## Endpoints

- `GET /healthz` - Health check
- `POST /generate` - Generate animation from audio

## Setup

1. Create audio files in this directory with the naming pattern `audio_<samplerate>.pcm`:
   - `audio_16000.pcm` (16kHz)
   - `audio_22050.pcm` (22.05kHz)
   - etc.

2. Set environment variables:
```bash
export AVATAR_API_KEY="your-api-key"
export AVATAR_APP_ID="your-app-id"
export AVATAR_CONSOLE_ENDPOINT="https://console.us-west.spatialwalk.cloud/v1/console"
export AVATAR_INGRESS_ENDPOINT="https://api.us-west.spatialwalk.cloud/v2/driveningress"
export AVATAR_SESSION_AVATAR_ID="your-avatar-id"
# Optional:
export PORT=8080
export HOST=127.0.0.1
```

3. Install dependencies and run:
```bash
pnpm install
pnpm start
```

## Usage

### Health Check

```bash
curl http://localhost:8080/healthz
```

Response:
```json
{"status": "ok"}
```

### Generate Animation

```bash
curl -X POST http://localhost:8080/generate \
  -H "Content-Type: application/json" \
  -d '{"sample_rate": 16000}'
```

Response:
```json
{
  "sample_rate": 16000,
  "audio_format": "pcm_s16le_mono",
  "audio_base64": "...",
  "connection_id": "...",
  "req_id": "...",
  "animation_messages_base64": ["...", "..."]
}
```

## Error Responses

```json
{
  "error": {
    "code": "audio_not_found",
    "message": "No audio file for sample rate 44100. Available: 16000, 22050"
  }
}
```

Error codes:
- `invalid_request` (400) - Invalid JSON body
- `audio_not_found` (404) - No audio file for requested sample rate
- `session_token_error` (502) - Failed to get session token
- `sessionTokenExpired` (502) - Session token expired
- `sessionTokenInvalid` (502) - Session token invalid
- `appIDUnrecognized` (502) - App ID not recognized
- `internal_error` (500) - Other errors
