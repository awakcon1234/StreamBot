# StreamBot Copilot Instructions

## Big picture
- The Discord selfbot runtime is in `src/index.ts`: it wires Discord events, command parsing, stream lifecycle (`streamStatus`, `AbortController`), and calls `prepareStream`/`playStream` from `@dank074/discord-video-stream`.
- The optional video management web UI is an Express server in `src/server.ts` (login, list/upload/delete, preview thumbnails) and is dynamically imported when `SERVER_ENABLED=true`.
- Configuration is centralized in `src/config.ts` and sourced from `.env` (or `.env.prod` via `prod:node`). It also normalizes booleans, codec/preset values, and hashes server password with bcrypt.

## Key workflows (local)
- Install deps: `bun install`
- Run bot (Bun): `bun run start`
- Build for Node: `bun run build`
- Run bot (Node): `bun run start:node`
- Run bot with .env.prod: `bun run prod:node`
- Run web UI server only: `bun run server`
- Compile only watch: `bun run watch`

## Project-specific patterns
- Commands are handled in a single `messageCreate` switch in `src/index.ts`; add new commands there and follow the existing reply/react patterns (`sendError`, `sendSuccess`, `sendList`).
- Streaming uses `streamStatus` flags + an `AbortController` to handle stop/cleanup; always call `cleanupStreamStatus()` on failure paths.
- YouTube handling splits live vs VODs: live uses `Youtube.getLiveStreamUrl()`; VODs download via `downloadToTempFile()` then delete the temp file.
- Twitch URLs are resolved to a stream/VOD URL in `getTwitchStreamUrl()` before streaming.

## External integrations
- yt-dlp is downloaded automatically to `scripts/` unless a system `yt-dlp` is found in PATH (`src/utils/yt-dlp.ts`). Cookies are optional via `YTDLP_COOKIES_PATH`.
- FFmpeg is required and used for streaming and previews (`src/utils/ffmpeg.ts`). The preview cache lives at `PREVIEW_CACHE_DIR`.
- Discord voice status is updated via direct API calls in `updateVoiceStatus()` (uses the selfbot token).

## Conventions to follow
- This repo is ESM (`"type": "module"`); keep `import ... from "./file.js"` extension style.
- Most user-facing messages are Vietnamese; keep language consistent when adding bot responses.
- `logger` (Winston) is the standard logging utility (`src/utils/logger.ts`).
