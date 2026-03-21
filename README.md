<div align="center">

# StreamBot

[![Ceasefire Now](https://badge.techforpalestine.org/default)](https://techforpalestine.org/learn-more)

A powerful Discord selfbot for streaming videos and live content to Discord voice channels.

![GitHub release](https://img.shields.io/github/v/release/ysdragon/StreamBot)
[![CodeFactor](https://www.codefactor.io/repository/github/ysdragon/streambot/badge)](https://www.codefactor.io/repository/github/ysdragon/streambot)

</div>

## ✨ Features

- 📁 Stream videos from a local folder
- 🎬 Stream and search YouTube videos by title
- 🔗 Stream YouTube videos/live streams by link
- 🌐 Stream from arbitrary links (video files, live streams, Twitch, etc.)
- ⚡ Playback controls: play, stop
- 📋 Video library management

## 📋 Requirements
- [Bun](https://bun.sh/) `v1.1.39+`
- [FFmpeg](https://www.ffmpeg.org/) _(in PATH or working directory)_

## 🚀 Installation

This project is [hosted on GitHub](https://github.com/ysdragon/StreamBot).

1. Clone the repository:
```bash
git clone https://github.com/ysdragon/StreamBot
```

2. Install dependencies:
```bash
bun install
```

3. Configure environment:
   - Rename `.env.example` to `.env`
   - Update configuration values

## 🎮 Usage

Start with Bun:
```bash
bun run start
```

Start with Node.js:
```bash
bun run build
bun run start:node
```

## 🐳 Docker Setup

### Standard Setup
1. Create a directory and navigate to it:
```bash
mkdir streambot && cd streambot
```

2. Download the compose file:
```bash
wget https://raw.githubusercontent.com/ysdragon/StreamBot/main/docker-compose.yml
```

3. Configure environment variables in `docker-compose.yml`

4. Launch container:
```bash
docker compose up -d
```

### Cloudflare WARP Setup
1. Download WARP compose file:
```bash
wget https://raw.githubusercontent.com/ysdragon/StreamBot/main/docker-compose-warp.yml
```

2. Configure `docker-compose-warp.yml` and add your WARP license key

3. Launch with WARP:
```bash
docker compose -f docker-compose-warp.yml up -d
```
> [!NOTE]
> The basic video server will not work if you use WARP.


## 🎯 Commands

| Command | Description |
|---------|-------------|
| `play <video>` | Play local video |
| `playlink <url>` | Stream from URL/YouTube/Twitch |
| `ytplay <query>` | Play YouTube video |
| `ytsearch <query>` | Search YouTube |
| `stop` | Stop playback |
| `list` | Show video library |
| `refresh` | Update video list |
| `status` | Show playback status |
| `preview <video>` | Generate thumbnails |
| `help` | Show help |

## Configuration

Configuration is done via `.env`:

```bash
# Selfbot options
TOKEN = "" # Your Discord self-bot token
PREFIX = "$" # The prefix used to trigger your self-bot commands
COMMAND_CHANNEL_ID = "" # Comma-separated IDs of channels where your self-bot will respond to commands

# General options
VIDEOS_DIR = "./videos" # The local path where you store video files
PREVIEW_CACHE_DIR = "./tmp/preview-cache" # The local path where your self-bot will cache video preview thumbnails

# yt-dlp options
YTDLP_COOKIES_PATH = "" # Path to cookies file for yt-dlp (for accessing age-restricted or premium content)

# Stream options
STREAM_RESPECT_VIDEO_PARAMS = "false"  # This option is used to respect video parameters such as width, height, fps, bitrate, and max bitrate.
STREAM_WIDTH = "1280" # The width of the video stream in pixels
STREAM_HEIGHT = "720" # The height of the video stream in pixels
STREAM_FPS = "30" # The frames per second (FPS) of the video stream
STREAM_BITRATE_KBPS = "2000" # The bitrate of the video stream in kilobits per second (Kbps)
STREAM_MAX_BITRATE_KBPS = "2500" # The maximum bitrate of the video stream in kilobits per second (Kbps)
STREAM_HARDWARE_ACCELERATION = "false" # Whether to use hardware acceleration for video decoding, set to "true" to enable, "false" to disable
STREAM_VIDEO_CODEC = "H264" # The video codec to use for the stream, can be "H264" or "H265" or "VP8"

# Twitch safe profile (applies when source is Twitch)
STREAM_TWITCH_SAFE_PROFILE_ENABLED = "true"
STREAM_TWITCH_SAFE_WIDTH = "1280"
STREAM_TWITCH_SAFE_HEIGHT = "720"
STREAM_TWITCH_SAFE_FPS = "30"
STREAM_TWITCH_SAFE_BITRATE_KBPS = "2500"
STREAM_TWITCH_SAFE_MAX_BITRATE_KBPS = "4000"
STREAM_TWITCH_SAFE_VIDEO_CODEC = "H264"
STREAM_TWITCH_SAFE_INCLUDE_AUDIO = "false"

# YouTube safe profile (applies when source is YouTube URL)
STREAM_YOUTUBE_SAFE_PROFILE_ENABLED = "false"
STREAM_YOUTUBE_SAFE_WIDTH = "1280"
STREAM_YOUTUBE_SAFE_HEIGHT = "720"
STREAM_YOUTUBE_SAFE_FPS = "30"
STREAM_YOUTUBE_SAFE_BITRATE_KBPS = "2000"
STREAM_YOUTUBE_SAFE_MAX_BITRATE_KBPS = "2500"
STREAM_YOUTUBE_SAFE_VIDEO_CODEC = "H264"
STREAM_YOUTUBE_SAFE_INCLUDE_AUDIO = "true"

# Retry profile (applies on retryCount > 0)
STREAM_RETRY_PROFILE_ENABLED = "true"
STREAM_RETRY_WIDTH = "1280"
STREAM_RETRY_HEIGHT = "720"
STREAM_RETRY_FPS = "30"
STREAM_RETRY_BITRATE_KBPS = "2500"
STREAM_RETRY_MAX_BITRATE_KBPS = "4000"
STREAM_RETRY_INCLUDE_AUDIO = "false"

# STREAM_H26X_PRESET: Determines the encoding preset for H26x video streams. 
# If the STREAM_H26X_PRESET environment variable is set, it parses the value 
# using the parsePreset function. If not set, it defaults to 'ultrafast' for 
# optimal encoding speed. This preset is only applicable when the codec is 
# H26x; otherwise, it should be disabled or ignored.
# Available presets: "ultrafast", "superfast", "veryfast", "faster", 
# "fast", "medium", "slow", "slower", "veryslow".
STREAM_H26X_PRESET = "ultrafast"

# Videos server options
SERVER_ENABLED = "false" # Whether to enable the built-in video server
SERVER_USERNAME = "admin" # The username for the video server's admin interface
SERVER_PASSWORD = "admin" # The password for the video server's admin interface
SERVER_PORT = "8080" # The port number the video server will listen on
```

When a playback command is executed, the bot will join the voice channel that the command executor is currently connected to.

### Using Cookies with yt-dlp

To access private or premium content with yt-dlp:

1. Export cookies from your browser using an extension such as:
   - [Get cookies.txt LOCALLY](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) (Chromium based)
   - [cookies.txt](https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/) (Firefox based)
2. Save the exported file (commonly `cookies.txt`) somewhere accessible to the bot.
3. Configure the path:
   - Set `YTDLP_COOKIES_PATH` in your `.env` file, e.g. `YTDLP_COOKIES_PATH="./cookies.txt"`; or
   - Use the bot's config command if available: `$config ytdlpCookiesPath ./cookies.txt`.
4. Restart the bot if you updated `.env`.

The cookies file will be used automatically for yt-dlp calls, enabling access to restricted content.

## Get Token ?
Check the [Get token wiki](https://github.com/ysdragon/StreamBot/wiki/Get-Discord-user-token)

## Server

An optional basic HTTP server can be enabled to manage the video library:

- List videos
- Upload videos
- Delete videos
- Generate video preview thumbnails

## Todo

- [x]  Adding ytsearch and ytplay commands   

## 🤝 Contributing
Contributions are welcome! Feel free to:
- 🐛 Report bugs via [issues](https://github.com/ysdragon/StreamBot/issues/new)
- 🔧 Submit [pull requests](https://github.com/ysdragon/StreamBot/pulls)
- 💡 Suggest new features

## ⚠️ Legal

This bot may violate Discord's ToS. Use at your own risk.

## إبراء الذمة
أتبرأ من أي استخدام غير أخلاقي لهذا المشروع أمام الله.

## 📝 License

Licensed under MIT License. See [LICENSE](https://github.com/ysdragon/StreamBot/blob/main/LICENSE) for details.
