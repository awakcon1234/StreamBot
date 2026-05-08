import dotenv from "dotenv"

dotenv.config({ quiet: true });

const VALID_VIDEO_CODECS = ['VP8', 'H264', 'H265', 'VP9', 'AV1'];

export function parseVideoCodec(value: string): "VP8" | "H264" | "H265" {
	if (typeof value === "string") {
		value = value.trim().toUpperCase();
	}
	if (VALID_VIDEO_CODECS.includes(value)) {
		return value as "VP8" | "H264" | "H265";
	}
	return "H264";
}

export function parsePreset(value: string): "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow" {
	if (typeof value === "string") {
		value = value.trim().toLowerCase();
	}
	switch (value) {
		case "ultrafast":
		case "superfast":
		case "veryfast":
		case "faster":
		case "fast":
		case "medium":
		case "slow":
		case "slower":
		case "veryslow":
			return value as "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow";
		default:
			return "ultrafast";
	}
}

export function parseBoolean(value: string | undefined): boolean {
	if (typeof value === "string") {
		value = value.trim().toLowerCase();
	}
	switch (value) {
		case "true":
			return true;
		default:
			return false;
	}
}

function parseAdminIds(value: string): string[] {
	try {
		// Try to parse as JSON array first
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) {
			return parsed.filter(id => typeof id === 'string' && id.trim() !== '');
		}
	} catch {
		// If not JSON, try comma-separated values
		if (value.includes(',')) {
			return value.split(',').map(id => id.trim()).filter(id => id !== '');
		}
	}
	// Single value
	return value.trim() ? [value.trim()] : [];
}

function parseIdList(value: string): string[] {
    if (typeof value !== "string") return [];
    return value
        .split(",")
        .map(item => item.trim())
        .filter(item => item.length > 0);
}

const cmdChannelIds = process.env.COMMAND_CHANNEL_ID ? parseIdList(process.env.COMMAND_CHANNEL_ID) : [];

export default {
	// Selfbot options
	token: process.env.TOKEN || '',
	prefix: process.env.PREFIX || '',
	guildId: process.env.GUILD_ID ? process.env.GUILD_ID : '',
    cmdChannelId: cmdChannelIds[0] || process.env.COMMAND_CHANNEL_ID || '',
    cmdChannelIds,
	videoChannelId: process.env.VIDEO_CHANNEL_ID ? process.env.VIDEO_CHANNEL_ID : '',
	adminIds: process.env.ADMIN_IDS ? parseAdminIds(process.env.ADMIN_IDS) : [],

	// General options
	videosDir: process.env.VIDEOS_DIR ? process.env.VIDEOS_DIR : './videos',
	previewCacheDir: process.env.PREVIEW_CACHE_DIR ? process.env.PREVIEW_CACHE_DIR : './tmp/preview-cache',

	// yt-dlp options
	ytdlpCookiesPath: process.env.YTDLP_COOKIES_PATH ? process.env.YTDLP_COOKIES_PATH : '',

	// Stream options
	respect_video_params: process.env.STREAM_RESPECT_VIDEO_PARAMS ? parseBoolean(process.env.STREAM_RESPECT_VIDEO_PARAMS) : false,
	bitrateOverride: process.env.STREAM_BITRATE_OVERRIDE ? parseBoolean(process.env.STREAM_BITRATE_OVERRIDE) : false,
	width: process.env.STREAM_WIDTH ? parseInt(process.env.STREAM_WIDTH) : 1280,
	height: process.env.STREAM_HEIGHT ? parseInt(process.env.STREAM_HEIGHT) : 720,
	fps: process.env.STREAM_FPS ? parseInt(process.env.STREAM_FPS) : 30,
	bitrateKbps: process.env.STREAM_BITRATE_KBPS ? parseInt(process.env.STREAM_BITRATE_KBPS) : 1000,
	maxBitrateKbps: process.env.STREAM_MAX_BITRATE_KBPS ? parseInt(process.env.STREAM_MAX_BITRATE_KBPS) : 2500,
	maxWidth: process.env.STREAM_MAX_WIDTH ? parseInt(process.env.STREAM_MAX_WIDTH) : 0,
	maxHeight: process.env.STREAM_MAX_HEIGHT ? parseInt(process.env.STREAM_MAX_HEIGHT) : 0,
	hardwareAcceleratedDecoding: process.env.STREAM_HARDWARE_ACCELERATION ? parseBoolean(process.env.STREAM_HARDWARE_ACCELERATION) : false,
	h26xPreset: process.env.STREAM_H26X_PRESET ? parsePreset(process.env.STREAM_H26X_PRESET) : 'ultrafast',
	videoCodec: process.env.STREAM_VIDEO_CODEC ? parseVideoCodec(process.env.STREAM_VIDEO_CODEC) : 'H264',
	streamDebugLogs: process.env.STREAM_DEBUG_LOGS ? parseBoolean(process.env.STREAM_DEBUG_LOGS) : false,

	// Safe profile options
	twitchSafeProfileEnabled: process.env.STREAM_TWITCH_SAFE_PROFILE_ENABLED ? parseBoolean(process.env.STREAM_TWITCH_SAFE_PROFILE_ENABLED) : true,
	twitchSafeWidth: process.env.STREAM_TWITCH_SAFE_WIDTH ? parseInt(process.env.STREAM_TWITCH_SAFE_WIDTH) : (process.env.STREAM_WIDTH ? parseInt(process.env.STREAM_WIDTH) : 1280),
	twitchSafeHeight: process.env.STREAM_TWITCH_SAFE_HEIGHT ? parseInt(process.env.STREAM_TWITCH_SAFE_HEIGHT) : (process.env.STREAM_HEIGHT ? parseInt(process.env.STREAM_HEIGHT) : 720),
	twitchSafeFps: process.env.STREAM_TWITCH_SAFE_FPS ? parseInt(process.env.STREAM_TWITCH_SAFE_FPS) : (process.env.STREAM_FPS ? parseInt(process.env.STREAM_FPS) : 30),
	twitchSafeBitrateKbps: process.env.STREAM_TWITCH_SAFE_BITRATE_KBPS ? parseInt(process.env.STREAM_TWITCH_SAFE_BITRATE_KBPS) : (process.env.STREAM_BITRATE_KBPS ? parseInt(process.env.STREAM_BITRATE_KBPS) : 1000),
	twitchSafeMaxBitrateKbps: process.env.STREAM_TWITCH_SAFE_MAX_BITRATE_KBPS ? parseInt(process.env.STREAM_TWITCH_SAFE_MAX_BITRATE_KBPS) : (process.env.STREAM_MAX_BITRATE_KBPS ? parseInt(process.env.STREAM_MAX_BITRATE_KBPS) : 2500),
	twitchSafeVideoCodec: process.env.STREAM_TWITCH_SAFE_VIDEO_CODEC ? parseVideoCodec(process.env.STREAM_TWITCH_SAFE_VIDEO_CODEC) : (process.env.STREAM_VIDEO_CODEC ? parseVideoCodec(process.env.STREAM_VIDEO_CODEC) : 'H264'),
	twitchSafeIncludeAudio: process.env.STREAM_TWITCH_SAFE_INCLUDE_AUDIO ? parseBoolean(process.env.STREAM_TWITCH_SAFE_INCLUDE_AUDIO) : false,

	youtubeSafeProfileEnabled: process.env.STREAM_YOUTUBE_SAFE_PROFILE_ENABLED ? parseBoolean(process.env.STREAM_YOUTUBE_SAFE_PROFILE_ENABLED) : false,
	youtubeSafeWidth: process.env.STREAM_YOUTUBE_SAFE_WIDTH ? parseInt(process.env.STREAM_YOUTUBE_SAFE_WIDTH) : (process.env.STREAM_WIDTH ? parseInt(process.env.STREAM_WIDTH) : 1280),
	youtubeSafeHeight: process.env.STREAM_YOUTUBE_SAFE_HEIGHT ? parseInt(process.env.STREAM_YOUTUBE_SAFE_HEIGHT) : (process.env.STREAM_HEIGHT ? parseInt(process.env.STREAM_HEIGHT) : 720),
	youtubeSafeFps: process.env.STREAM_YOUTUBE_SAFE_FPS ? parseInt(process.env.STREAM_YOUTUBE_SAFE_FPS) : (process.env.STREAM_FPS ? parseInt(process.env.STREAM_FPS) : 30),
	youtubeSafeBitrateKbps: process.env.STREAM_YOUTUBE_SAFE_BITRATE_KBPS ? parseInt(process.env.STREAM_YOUTUBE_SAFE_BITRATE_KBPS) : (process.env.STREAM_BITRATE_KBPS ? parseInt(process.env.STREAM_BITRATE_KBPS) : 1000),
	youtubeSafeMaxBitrateKbps: process.env.STREAM_YOUTUBE_SAFE_MAX_BITRATE_KBPS ? parseInt(process.env.STREAM_YOUTUBE_SAFE_MAX_BITRATE_KBPS) : (process.env.STREAM_MAX_BITRATE_KBPS ? parseInt(process.env.STREAM_MAX_BITRATE_KBPS) : 2500),
	youtubeSafeVideoCodec: process.env.STREAM_YOUTUBE_SAFE_VIDEO_CODEC ? parseVideoCodec(process.env.STREAM_YOUTUBE_SAFE_VIDEO_CODEC) : (process.env.STREAM_VIDEO_CODEC ? parseVideoCodec(process.env.STREAM_VIDEO_CODEC) : 'H264'),
	youtubeSafeIncludeAudio: process.env.STREAM_YOUTUBE_SAFE_INCLUDE_AUDIO ? parseBoolean(process.env.STREAM_YOUTUBE_SAFE_INCLUDE_AUDIO) : true,

	retryProfileEnabled: process.env.STREAM_RETRY_PROFILE_ENABLED ? parseBoolean(process.env.STREAM_RETRY_PROFILE_ENABLED) : true,
	retryWidth: process.env.STREAM_RETRY_WIDTH ? parseInt(process.env.STREAM_RETRY_WIDTH) : 1280,
	retryHeight: process.env.STREAM_RETRY_HEIGHT ? parseInt(process.env.STREAM_RETRY_HEIGHT) : 720,
	retryFps: process.env.STREAM_RETRY_FPS ? parseInt(process.env.STREAM_RETRY_FPS) : 30,
	retryBitrateKbps: process.env.STREAM_RETRY_BITRATE_KBPS ? parseInt(process.env.STREAM_RETRY_BITRATE_KBPS) : 2500,
	retryMaxBitrateKbps: process.env.STREAM_RETRY_MAX_BITRATE_KBPS ? parseInt(process.env.STREAM_RETRY_MAX_BITRATE_KBPS) : 4000,
	retryIncludeAudio: process.env.STREAM_RETRY_INCLUDE_AUDIO ? parseBoolean(process.env.STREAM_RETRY_INCLUDE_AUDIO) : false,

	// Videos server options
	server_enabled: process.env.SERVER_ENABLED ? parseBoolean(process.env.SERVER_ENABLED) : false,
	server_username: process.env.SERVER_USERNAME ? process.env.SERVER_USERNAME : 'admin',
	server_password: process.env.SERVER_PASSWORD ? process.env.SERVER_PASSWORD : 'admin',
	server_port: parseInt(process.env.SERVER_PORT ? process.env.SERVER_PORT : '8080'),
}