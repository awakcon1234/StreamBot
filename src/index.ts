import { Client, TextChannel, CustomStatus, Message, MessageAttachment, ActivityOptions } from "discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream } from "@dank074/discord-video-stream";
import config from "./config.js";
import fs from 'fs';
import path from 'path';
import { getStream, getVod } from 'twitch-m3u8';
import yts from 'play-dl';
import { getVideoParams, ffmpegScreenshot } from "./utils/ffmpeg.js";
import logger from './utils/logger.js';
import { downloadExecutable, downloadToTempFile, checkForUpdatesAndUpdate } from './utils/yt-dlp.js';
import ytdl from './utils/yt-dlp.js';
import { Youtube } from './utils/youtube.js';
import { TwitchStream } from './types/index.js';
import https from 'https';
import { WebSocket as WsWebSocket } from 'ws';

if (!(globalThis as any).WebSocket) {
	(globalThis as any).WebSocket = WsWebSocket;
	logger.info('Đã thiết lập WebSocket polyfill cho môi trường Node.');
}

// Download yt-dlp and check for updates
(async () => {
	try {
		await downloadExecutable();
		await checkForUpdatesAndUpdate();
	} catch (error) {
		logger.error("Lỗi khi thiết lập/cập nhật yt-dlp ban đầu:", error);
	}
})();

// Create a new instance of Client
const client = new Client();

// Create a new instance of Streamer
const streamer = new Streamer(client);

// Create a new instance of Youtube
const youtube = new Youtube();

// Declare controllers per guild to abort streams
const controllerMap = new Map<string, AbortController>();
const queueMap = new Map<string, QueueItem[]>();
const prefetchMap = new Map<string, Promise<void>>();

type QueueItem = {
	message: Message;
	source: string;
	title?: string;
	initialMessage?: Message | null;
	voiceChannelId: string;
	prefetchedPath?: string | null;
	flowId?: string;
};

function buildFlowId(guildId: string): string {
	return `${guildId || 'noguild'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const noisyFlowStages = new Set([
	'play_video.ffmpeg.progress',
	'play_video.output.chunk_progress',
	'play_video.output.heartbeat',
]);

function logFlow(flowId: string, stage: string, details?: Record<string, unknown>) {
	if (!config.streamDebugLogs && noisyFlowStages.has(stage)) {
		return;
	}

	if (!details || Object.keys(details).length === 0) {
		logger.info(`[flow:${flowId}] ${stage}`);
		return;
	}

	try {
		logger.info(`[flow:${flowId}] ${stage} | ${JSON.stringify(details)}`);
	} catch (error) {
		logger.warn(`[flow:${flowId}] Không thể stringify details cho stage '${stage}':`, error);
		logger.info(`[flow:${flowId}] ${stage} | [unserializable details]`);
	}
}

const streamOpts = {
	width: config.width,
	height: config.height,
	frameRate: config.fps,
	bitrateVideo: config.bitrateKbps,
	bitrateVideoMax: config.maxBitrateKbps,
	videoCodec: Utils.normalizeVideoCodec(config.videoCodec),
	hardwareAcceleratedDecoding: config.hardwareAcceleratedDecoding,
	minimizeLatency: false,
	h26xPreset: config.h26xPreset
};

const twitchSafeProfile = {
	enabled: config.twitchSafeProfileEnabled,
	width: config.twitchSafeWidth,
	height: config.twitchSafeHeight,
	frameRate: config.twitchSafeFps,
	bitrateVideo: config.twitchSafeBitrateKbps,
	bitrateVideoMax: config.twitchSafeMaxBitrateKbps,
	videoCodec: Utils.normalizeVideoCodec(config.twitchSafeVideoCodec),
	includeAudio: config.twitchSafeIncludeAudio,
};

const youtubeSafeProfile = {
	enabled: config.youtubeSafeProfileEnabled,
	width: config.youtubeSafeWidth,
	height: config.youtubeSafeHeight,
	frameRate: config.youtubeSafeFps,
	bitrateVideo: config.youtubeSafeBitrateKbps,
	bitrateVideoMax: config.youtubeSafeMaxBitrateKbps,
	videoCodec: Utils.normalizeVideoCodec(config.youtubeSafeVideoCodec),
	includeAudio: config.youtubeSafeIncludeAudio,
};

const retryProfile = {
	enabled: config.retryProfileEnabled,
	width: config.retryWidth,
	height: config.retryHeight,
	frameRate: config.retryFps,
	bitrateVideo: config.retryBitrateKbps,
	bitrateVideoMax: config.retryMaxBitrateKbps,
	includeAudio: config.retryIncludeAudio,
};

// Create the videosFolder dir if it doesn't exist
if (!fs.existsSync(config.videosDir)) {
	fs.mkdirSync(config.videosDir);
}

// Create previewCache parent dir if it doesn't exist
if (!fs.existsSync(path.dirname(config.previewCacheDir))) {
	fs.mkdirSync(path.dirname(config.previewCacheDir), { recursive: true });
}

// Create the previewCache dir if it doesn't exist
if (!fs.existsSync(config.previewCacheDir)) {
	fs.mkdirSync(config.previewCacheDir);
}

// Get all video files
const videoFiles = fs.readdirSync(config.videosDir);

// Create an array of video objects
let videos = videoFiles.map(file => {
	const fileName = path.parse(file).name;
	return { name: fileName, path: path.join(config.videosDir, file) };
});

async function enqueueOrPlay(item: QueueItem, status: StreamStatus) {
	const guildId = item.message.guild?.id || "";
	const flowId = item.flowId || buildFlowId(guildId);
	logFlow(flowId, 'enqueue_or_play.enter', {
		guildId,
		joined: status.joined,
		playing: status.playing,
		source: item.source,
		title: item.title || null
	});

	if (!guildId) {
		logFlow(flowId, 'enqueue_or_play.abort', { reason: 'missing_guild' });
		await sendError(item.message, 'Không thể xác định máy chủ.');
		return;
	}

	if (status.joined || status.playing) {
		const queue = queueMap.get(guildId) ?? [];
		queue.push(item);
		queueMap.set(guildId, queue);
		logFlow(flowId, 'queue.enqueued', { position: queue.length, queueLength: queue.length });
		await sendSuccess(item.message, `Đã thêm vào hàng đợi (#${queue.length}).`);
		await prefetchNextInQueue(guildId);
		return;
	}

	logFlow(flowId, 'enqueue_or_play.direct_play');
	await playVideo(item.message, item.source, item.title, item.initialMessage ?? undefined, item.voiceChannelId, undefined, flowId);
}

async function startNextInQueue(guildId: string) {
	const queue = queueMap.get(guildId);
	if (!queue || queue.length === 0) return;
	const next = queue.shift()!;
	queueMap.set(guildId, queue);
	const status = getStreamStatus(guildId);
	const flowId = next.flowId || buildFlowId(guildId);
	logFlow(flowId, 'queue.start_next', { remaining: queue.length, source: next.source, title: next.title || null });
	await playVideo(next.message, next.source, next.title, next.initialMessage ?? undefined, next.voiceChannelId, next.prefetchedPath ?? undefined, flowId);
}

async function handleUrlPlay(message: Message, link: string, status: StreamStatus, flowId: string) {
	logFlow(flowId, 'url_play.received', { link });
	const voiceChannelId = message.member?.voice?.channelId || "";
	if (!voiceChannelId) {
		logFlow(flowId, 'url_play.abort', { reason: 'missing_voice_channel' });
		await sendError(message, 'Bạn cần vào kênh thoại trước khi phát video.');
		return;
	}

	if (isYoutubePlaylistUrl(link)) {
		logFlow(flowId, 'url_play.detected_playlist', { link });
		await handleYoutubePlaylistPlay(message, link, status, voiceChannelId, flowId);
		return;
	}

	let title: string | undefined = undefined;
	let source = link;

	if (link.includes('youtube.com/') || link.includes('youtu.be/')) {
		try {
			const videoDetails = await youtube.getVideoInfo(link);
			if (videoDetails?.title) {
				title = videoDetails.title;
			}
			logFlow(flowId, 'url_play.youtube_resolved', { title: title || null });
		} catch (error) {
			logger.error(`Lỗi khi xử lý liên kết YouTube: ${link}`, error);
		}
	} else if (link.includes('twitch.tv')) {
		const twitchId = link.split('/').pop() as string;
		logFlow(flowId, 'url_play.twitch_resolving', { twitchId });
		const twitchUrl = await getTwitchStreamUrl(link, flowId);
		if (twitchUrl) {
			source = twitchUrl;
			title = `twitch.tv/${twitchId}`;
			logFlow(flowId, 'url_play.twitch_resolved', { resolved: true });
		} else {
			logFlow(flowId, 'url_play.abort', { reason: 'twitch_resolve_failed' });
			await sendError(message, 'Không thể lấy URL Twitch.');
			return;
		}
	} else {
		if (URL.canParse(link)) {
			title = new URL(link).hostname;
		} else {
			logger.warn(`Không thể parse hostname từ liên kết: ${link}. Sử dụng fallback title 'URL'.`);
			title = "URL";
		}
	}

	if (status.joined || status.playing) {
		await enqueueOrPlay({
			message,
			source,
			title,
			voiceChannelId,
			flowId
		}, status);
		return;
	}

	const prepMessageContent = [
		`-# 📥 Đang chuẩn bị video...`,
		`> **${title || new URL(link).hostname}**`
	].join("\n");

	const prepMessage = await message.reply(prepMessageContent).catch(e => {
		logger.warn("Gửi thông báo 'Đang tải...' thất bại:", e);
		return null;
	});

	await enqueueOrPlay({
		message,
		source,
		title,
		initialMessage: prepMessage,
		voiceChannelId,
		flowId
	}, status);
}

async function handleYoutubePlaylistPlay(message: Message, link: string, status: StreamStatus, voiceChannelId: string, flowId: string) {
	const entries = await youtube.getPlaylistEntries(link);
	logFlow(flowId, 'playlist.fetch_result', { count: entries.length });
	if (!entries.length) {
		await sendError(message, 'Không thể lấy danh sách phát hoặc danh sách trống.');
		return;
	}

	const guildId = message.guild?.id || "";
	if (!guildId) {
		await sendError(message, 'Không thể xác định máy chủ.');
		return;
	}

	const queue = queueMap.get(guildId) ?? [];

	if (status.joined || status.playing) {
		for (const entry of entries) {
			queue.push({
				message,
				source: entry.url,
				title: entry.title,
				voiceChannelId,
				flowId
			});
		}
		queueMap.set(guildId, queue);
		logFlow(flowId, 'playlist.queued', { added: entries.length, queueLength: queue.length });
		await sendSuccess(message, `Đã thêm ${entries.length} video vào hàng đợi.`);
		return;
	}

	const [first, ...rest] = entries;
	for (const entry of rest) {
		queue.push({
			message,
			source: entry.url,
			title: entry.title,
			voiceChannelId,
			flowId
		});
	}
	queueMap.set(guildId, queue);

	await sendSuccess(message, `Đang phát video đầu tiên và thêm ${rest.length} video vào hàng đợi.`);
	logFlow(flowId, 'playlist.play_first', { firstTitle: first.title || null, queuedAfterFirst: rest.length });
	await playVideo(message, first.url, first.title, undefined, voiceChannelId, undefined, flowId);
}

async function prefetchNextInQueue(guildId: string) {
	if (prefetchMap.has(guildId)) return;
	const queue = queueMap.get(guildId);
	if (!queue || queue.length === 0) return;
	const next = queue[0];
	if (next.prefetchedPath) return;
	if (!isUrl(next.source)) return;
	if (!next.source.includes('youtube.com/') && !next.source.includes('youtu.be/')) return;

	const task = (async () => {
		try {
			const videoDetails = await youtube.getVideoInfo(next.source);
			if (videoDetails?.videoDetails?.isLiveContent) return;

			const ytDlpDownloadOptions: Parameters<typeof downloadToTempFile>[1] = {
				format: `bestvideo[height<=${streamOpts.height || 720}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${streamOpts.height || 720}]+bestaudio/best[height<=${streamOpts.height || 720}]/best`,
				noPlaylist: true,
			};

			const tempPath = await downloadToTempFile(next.source, ytDlpDownloadOptions);
			next.prefetchedPath = tempPath;
			queueMap.set(guildId, queue);
			logger.info(`Đã tải trước video kế tiếp: ${next.title || next.source}`);
		} catch (error) {
			logger.warn('Tải trước video kế tiếp thất bại:', error);
		}
	})();

	prefetchMap.set(guildId, task);
	await task;
	prefetchMap.delete(guildId);
}

// print out all videos
logger.info(`Các video có sẵn:\n${videos.map(m => m.name).join('\n')}`);

// Ready event
streamer.client.on("ready", async () => {
	if (streamer.client.user) {
		logger.info(`${streamer.client.user.tag} đã sẵn sàng`);
		streamer.client.user?.setActivity(status_idle() as ActivityOptions);
	}
});

streamer.client.on("error", (error) => {
	logger.error("Discord client error:", error);
});

streamer.client.on("warn", (warning) => {
	logger.warn("Discord client warning:", warning);
});

type StreamStatus = {
	joined: boolean;
	joinsucc: boolean;
	playing: boolean;
	manualStop: boolean;
	channelInfo: {
		guildId: string;
		channelId: string;
		cmdChannelId: string;
	};
};

const streamStatusMap = new Map<string, StreamStatus>();

const createDefaultStreamStatus = (guildId: string): StreamStatus => ({
	joined: false,
	joinsucc: false,
	playing: false,
	manualStop: false,
	channelInfo: {
		guildId,
		channelId: "",
		cmdChannelId: ""
	}
});

function getStreamStatus(guildId: string): StreamStatus {
	if (!streamStatusMap.has(guildId)) {
		streamStatusMap.set(guildId, createDefaultStreamStatus(guildId));
	}
	return streamStatusMap.get(guildId)!;
}

function resetStreamStatus(guildId: string) {
	streamStatusMap.set(guildId, createDefaultStreamStatus(guildId));
}

function isUrl(input: string): boolean {
	if (!URL.canParse(input)) {
		return false;
	}
	const parsed = new URL(input);
	return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function isYoutubePlaylistUrl(input: string): boolean {
	if (!URL.canParse(input)) {
		return false;
	}
	const parsed = new URL(input);
	const host = parsed.hostname.toLowerCase();
	if (!host.includes("youtube.com") && !host.includes("youtu.be")) return false;
	return parsed.searchParams.has("list");
}

function isSelfConnectedToChannel(guildId: string, channelId: string): boolean {
	const selfId = streamer.client.user?.id;
	if (!selfId) return false;

	const guild = streamer.client.guilds.cache.get(guildId);
	const currentChannelId = guild?.voiceStates?.cache?.get(selfId)?.channelId;
	return currentChannelId === channelId;
}

function hasVoiceConnectionReady(): boolean {
	return Boolean((streamer as any).voiceConnection);
}

function getConnectionSnapshot() {
	const voiceConnection = (streamer as any).voiceConnection;
	const streamConnection = voiceConnection?.streamConnection;
	return {
		hasVoiceConnection: Boolean(voiceConnection),
		hasVoiceUdp: Boolean(voiceConnection?.udp),
		hasStreamConnection: Boolean(streamConnection),
		hasStreamUdp: Boolean(streamConnection?.udp),
		selfStreamExists: Boolean((streamer as any).client?.user)
	};
}

async function joinVoiceWithTimeout(guildId: string, channelId: string, flowId: string, timeoutMs = 15000): Promise<void> {
	let joinError: unknown = null;
	void streamer.joinVoice(guildId, channelId).catch((error) => {
		joinError = error;
	});

	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (joinError) {
			logFlow(flowId, 'play_video.voice_join.error', {
				error: joinError instanceof Error ? joinError.message : String(joinError)
			});
			throw joinError;
		}

		const connected = isSelfConnectedToChannel(guildId, channelId);
		const connectionReady = hasVoiceConnectionReady();
		if (connected && connectionReady) {
			logFlow(flowId, 'play_video.voice_join.ready', {
				waitedMs: Date.now() - startedAt
			});
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, 250));
	}

	const connected = isSelfConnectedToChannel(guildId, channelId);
	if (connected) {
		logger.warn(`joinVoice chưa trả về sau ${timeoutMs}ms nhưng bot đã vào channel ${channelId}. Tiếp tục phát stream.`);
		logFlow(flowId, 'play_video.voice_join.timeout_but_connected', { timeoutMs, connectionReady: hasVoiceConnectionReady() });
		return;
	}

	if (joinError) {
		logFlow(flowId, 'play_video.voice_join.error', {
			error: joinError instanceof Error ? joinError.message : String(joinError)
		});
		throw joinError;
	}

	logFlow(flowId, 'play_video.voice_join.timeout', { timeoutMs, channelId });
	throw new Error(`joinVoice timeout sau ${timeoutMs}ms và bot chưa vào voice channel.`);
}

async function waitForVoiceHandshakeReady(guildId: string, flowId: string, timeoutMs = 5000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const status = getStreamStatus(guildId);
		const connected = isSelfConnectedToChannel(guildId, status.channelInfo.channelId);
		const connectionReady = hasVoiceConnectionReady();

		if (status.joinsucc || (connected && connectionReady)) {
			logFlow(flowId, 'play_video.voice_handshake.ready', {
				waitedMs: Date.now() - startedAt,
				joinsucc: status.joinsucc,
				connected,
				connectionReady
			});
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, 200));
	}

	const status = getStreamStatus(guildId);
	logFlow(flowId, 'play_video.voice_handshake.timeout', {
		timeoutMs,
		joinsucc: status.joinsucc,
		connectionReady: hasVoiceConnectionReady()
	});
}

// Voice state update event
streamer.client.on('voiceStateUpdate', async (oldState, newState) => {
	// When exit channel
	if (oldState.member?.user.id == streamer.client.user?.id) {
		if (oldState.channelId && !newState.channelId) {
			resetStreamStatus(oldState.guild.id);
			streamer.client.user?.setActivity(status_idle() as ActivityOptions);
		}
	}

	// When join channel success
	if (newState.member?.user.id == streamer.client.user?.id) {
		if (newState.channelId && !oldState.channelId) {
			const status = getStreamStatus(newState.guild.id);
			status.joined = true;
			if (newState.guild.id == status.channelInfo.guildId && newState.channelId == status.channelInfo.channelId) {
				status.joinsucc = true;
			}
		}
	}
})

// Message create event
streamer.client.on('messageCreate', async (message) => {
	if (
		message.author.bot ||
		message.author.id === streamer.client.user?.id ||
		!config.cmdChannelIds.includes(message.channel.id.toString()) ||
		!message.content.startsWith(config.prefix!)
	) return; // Ignore bots, self, non-command channels, and non-commands

	const args = message.content.slice(config.prefix!.length).trim().split(/ +/); // Split command and arguments

	if (args.length === 0) return; // No arguments provided

	const user_cmd = args.shift()!.toLowerCase();
	const guildId = message.guild?.id || "";
	const status = guildId ? getStreamStatus(guildId) : null;
	const flowId = buildFlowId(guildId);

	logFlow(flowId, 'command.received', {
		command: user_cmd,
		args,
		messageId: message.id,
		guildId,
		channelId: message.channel.id,
		userId: message.author.id,
		voiceChannelId: message.member?.voice?.channelId || null
	});

	switch (user_cmd) {
			case 'play':
				{
					if (!status) {
						await sendError(message, 'Không thể xác định máy chủ.');
						return;
					}
					const input = args.shift();
					if (!input) {
						await sendError(message, 'Vui lòng cung cấp video hoặc liên kết.');
						return;
					}

					if (isUrl(input)) {
						logFlow(flowId, 'command.play.url_input', { input });
						await handleUrlPlay(message, input, status, flowId);
						return;
					}

					// Get video name and find video file
					const videoname = input;
					const video = videos.find(m => m.name == videoname);

					if (!video) {
						await sendError(message, 'Không tìm thấy video');
						return;
					}

					const voiceChannelId = message.member?.voice?.channelId || "";
					if (!voiceChannelId) {
						await sendError(message, 'Bạn cần vào kênh thoại trước khi phát video.');
						return;
					}

					// Check if the respect video parameters environment variable is enabled
					if (config.respect_video_params) {
						// Checking video params
						try {
							const resolution = await getVideoParams(video.path);
							streamOpts.height = resolution.height;
							streamOpts.width = resolution.width;
							if (resolution.bitrate != "N/A") {
								streamOpts.bitrateVideo = Math.floor(Number(resolution.bitrate) / 1000);
							}

							if (resolution.maxbitrate != "N/A") {
								streamOpts.bitrateVideoMax = Math.floor(Number(resolution.bitrate) / 1000);
							}

							if (resolution.fps) {
								streamOpts.frameRate = resolution.fps
							}

						} catch (error) {
							logger.error('Không thể xác định độ phân giải, sử dụng độ phân giải tĩnh....', error);
						}
					}

					// Log playing video
					logger.info(`Phát video cục bộ: ${video.path}`);
					logFlow(flowId, 'command.play.local_resolved', { videoPath: video.path, videoName: videoname });

					await enqueueOrPlay({
						message,
						source: video.path,
						title: videoname,
						voiceChannelId,
						flowId
					}, status);
				}
				break;
			case 'playlink':
				{
					if (!status) {
						await sendError(message, 'Không thể xác định máy chủ.');
						return;
					}

					const link = args.shift() || '';

					if (!link) {
						await sendError(message, 'Vui lòng cung cấp liên kết.');
						return;
					}

					logFlow(flowId, 'command.playlink.input', { link });
					await handleUrlPlay(message, link, status, flowId);
				}
				break;
			case 'ytplay':
				{
					if (!status) {
						await sendError(message, 'Không thể xác định máy chủ.');
						return;
					}
					const title = args.length > 1 ? args.slice(1).join(' ') : args[1] || args.shift() || '';

					if (!title) {
						await sendError(message, 'Vui lòng cung cấp tiêu đề video.');
						return;
					}

					try {
						logFlow(flowId, 'command.ytplay.search_start', { query: title });
						const searchResults = await yts.search(title, { limit: 1 });
						const videoResult = searchResults[0];

						const searchResult = await youtube.searchAndGetPageUrl(title);

						if (searchResult.pageUrl && searchResult.title) {
							logFlow(flowId, 'command.ytplay.search_resolved', {
								resultTitle: searchResult.title,
								resultUrl: searchResult.pageUrl,
								playDlResultTitle: videoResult?.title || null
							});
							const voiceChannelId = message.member?.voice?.channelId || "";
							if (!voiceChannelId) {
								await sendError(message, 'Bạn cần vào kênh thoại trước khi phát video.');
								return;
							}
							await enqueueOrPlay({
								message,
								source: searchResult.pageUrl,
								title: searchResult.title,
								voiceChannelId,
								flowId
							}, status);
						} else {
							logger.warn(`Không tìm thấy video hoặc tiêu đề bị thiếu cho tìm kiếm: "${title}" sử dụng youtube.searchAndGetPageUrl.`);
							throw new Error('Could not find video');
						}
					} catch (error) {
						logger.error('Không thể phát video YouTube:', error);
						await cleanupStreamStatus(guildId);
						await sendError(message, 'Không thể phát video. Vui lòng thử lại.');
					}
				}
				break;
			case 'ytsearch':
				{
					const query = args.length > 1 ? args.slice(1).join(' ') : args[1] || args.shift() || '';

					if (!query) {
						await sendError(message, 'Vui lòng cung cấp truy vấn tìm kiếm.');
						return;
					}

					const ytSearchQuery = await ytSearch(query);
					try {
						if (ytSearchQuery) {
							await sendList(message, ytSearchQuery, "ytsearch");
						}

					} catch (error) {
						await sendError(message, 'Không thể tìm kiếm video.');
					}
				}
				break;
			case 'stop':
				{
					if (!status) {
						await sendError(message, 'Không thể xác định máy chủ.');
						return;
					}
					if (!status.joined) {
						sendError(message, 'Đã dừng rồi!');
						return;
					}

					try {
						status.manualStop = true;

						const controller = controllerMap.get(guildId);
						controller?.abort();

						await sendSuccess(message, 'Đã dừng phát video.');
						logger.info('Đã dừng phát video.');

						streamer.stopStream();
						streamer.leaveVoice();
						streamer.client.user?.setActivity(status_idle() as ActivityOptions);

						const voiceChannel = streamer.client.channels.cache.get(status.channelInfo.channelId);
						if (voiceChannel?.type === 'GUILD_VOICE' || voiceChannel?.type === 'GUILD_STAGE_VOICE') {
							//voiceChannel.status = "";
							await updateVoiceStatus(status.channelInfo.channelId, "");
						}

						resetStreamStatus(guildId);
						controllerMap.delete(guildId);
						queueMap.delete(guildId);
						prefetchMap.delete(guildId);

					} catch (error) {
						logger.error('Lỗi khi dừng cưỡng bức:', error);
					}
				}
				break;
			case 'skip':
				{
					if (!status) {
						await sendError(message, 'Không thể xác định máy chủ.');
						return;
					}
					const guildQueue = queueMap.get(guildId) ?? [];
					if (!status.joined && guildQueue.length === 0) {
						await sendError(message, 'Không có gì để bỏ qua.');
						return;
					}

					try {
						status.manualStop = true;
						const controller = controllerMap.get(guildId);
						controller?.abort();
						await cleanupStreamStatus(guildId);
						await startNextInQueue(guildId);
						await sendSuccess(message, 'Đã chuyển sang video tiếp theo.');
					} catch (error) {
						logger.error('Lỗi khi bỏ qua video:', error);
						await sendError(message, 'Không thể bỏ qua video.');
					}
				}
				break;
			case 'queue':
				{
					const guildQueue = queueMap.get(guildId) ?? [];
					if (guildQueue.length === 0) {
						await sendInfo(message, 'Hàng đợi', 'Không có video trong hàng đợi.');
						return;
					}
					const lines = guildQueue.map((item, index) => {
						const name = item.title || item.source;
						return `${index + 1}. ${name}`;
					});
					await sendList(message, lines, "queue");
				}
				break;
			case 'remove':
				{
					const guildQueue = queueMap.get(guildId) ?? [];
					const indexRaw = args.shift();
					const index = indexRaw ? parseInt(indexRaw, 10) : NaN;
					if (!indexRaw || Number.isNaN(index) || index < 1 || index > guildQueue.length) {
						await sendError(message, 'Vui lòng cung cấp số thứ tự hợp lệ trong hàng đợi.');
						return;
					}

					const removed = guildQueue.splice(index - 1, 1)[0];
					queueMap.set(guildId, guildQueue);
					await sendSuccess(message, `Đã xóa: ${removed.title || removed.source}`);
				}
				break;
			case 'list':
				{
					const videoList = videos.map((video, index) => `${index + 1}. \`${video.name}\``);
					if (videoList.length > 0) {
						await sendList(message, videoList);
					} else {
						await sendError(message, 'Không tìm thấy video nào');
					}
				}
				break;
			case 'status':
				{
					if (!status) {
						await sendError(message, 'Không thể xác định máy chủ.');
						return;
					}
					await sendInfo(message, 'Trạng thái',
						`Đã tham gia: ${status.joined}\nĐang phát: ${status.playing}`);
				}
				break;
			case 'refresh':
				{
					// Refresh video list
					const videoFiles = fs.readdirSync(config.videosDir);
					videos = videoFiles.map(file => {
						const fileName = path.parse(file).name;
						// Replace space with _
						return { name: fileName.replace(/ /g, '_'), path: path.join(config.videosDir, file) };
					});
					const refreshedList = videos.map((video, index) => `${index + 1}. \`${video.name}\``);
					await sendList(message,
						[`(${videos.length} videos found)`, ...refreshedList], "refresh");
				}
				break;
			case 'preview':
				{
					const vid = args.shift();
					const vid_name = videos.find(m => m.name === vid);

					if (!vid_name) {
						await sendError(message, 'Không tìm thấy video');
						return;
					}

					// React with camera emoji
					message.react('📸');

					// Reply with message to indicate that the preview is being generated
					message.reply('📸 **Đang tạo ảnh xem trước...**');

					try {

						const hasUnderscore = vid_name.name.includes('_');
						//                                                Replace _ with space
						const thumbnails = await ffmpegScreenshot(`${hasUnderscore ? vid_name.name : vid_name.name.replace(/_/g, ' ')}${path.extname(vid_name.path)}`);
						if (thumbnails.length > 0) {
							const attachments: MessageAttachment[] = [];
							for (const screenshotPath of thumbnails) {
								attachments.push(new MessageAttachment(screenshotPath));
							}

							// Message content
							const content = `📸 **Preview**: \`${vid_name.name}\``;

							// Send message with attachments
							await message.reply({
								content,
								files: attachments
							});

						} else {
							await sendError(message, 'Tạo ảnh xem trước thất bại.');
						}
					} catch (error) {
						logger.error('Lỗi khi tạo ảnh xem trước:', error);
					}
				}
				break;
			case 'help':
				{
					// Help text
					const helpText = [
						'📽 **Các câu lệnh có sẵn**',
						'',
						'🎬 **Phát lại**',
						`\`${config.prefix}play\` - Phát video offline`,
						`\`${config.prefix}playlink\` - Phát video từ URL/YouTube/Twitch`,
						`\`${config.prefix}ytplay\` - Phát video từ YouTube`,
						`\`${config.prefix}stop\` - Dừng phát`,
						`\`${config.prefix}skip\` - Bỏ qua và phát tiếp`,
						'',
						'🛠️ **Công cụ**',
						`\`${config.prefix}list\` - Hiện danh sách video offline`,
						`\`${config.prefix}refresh\` - Cập nhật danh sách video`,
						`\`${config.prefix}status\` - Hiện trạng thái phát`,
						`\`${config.prefix}queue\` - Xem hàng đợi`,
						`\`${config.prefix}remove <#>\` - Xóa khỏi hàng đợi`,
						`\`${config.prefix}preview\` - Xem trước video`,
						'',
						'🔍 **Tìm kiếm**',
						`\`${config.prefix}ytsearch\` - Tìm kiếm trên YouTube`,
						`\`${config.prefix}help\` - Hiện trợ giúp này`
					].join('\n');

					// React with clipboard emoji
					await message.react('📋');

					// Reply with all commands
					await message.reply(helpText);
				}
				break;
			default:
				{
					await sendError(message, 'Lệnh không hợp lệ');
				}
	}
});

// Function to play video
async function playVideo(message: Message, videoSource: string, title?: string, initialMessage?: Message, targetVoiceChannelId?: string, prefetchedPath?: string, flowId?: string, retryCount = 0) {
	const guildId = message.guild?.id || "";
	const channelId = targetVoiceChannelId || message.member?.voice?.channelId || "";
	const cmdChannelId = message.channel.id;
	const resolvedFlowId = flowId || buildFlowId(guildId);

	logFlow(resolvedFlowId, 'play_video.enter', {
		title: title || null,
		source: videoSource,
		guildId,
		channelId: channelId || null,
		prefetched: !!prefetchedPath,
		retryCount
	});

	if (!guildId) {
		logFlow(resolvedFlowId, 'play_video.abort', { reason: 'missing_guild' });
		await sendError(message, "Không thể xác định máy chủ để phát video.");
		return;
	}
	const status = getStreamStatus(guildId);

	if (!channelId) {
		logFlow(resolvedFlowId, 'play_video.abort', { reason: 'missing_voice_channel' });
		await sendError(message, "Bạn cần vào kênh thoại trước khi phát video.");
		return;
	}

	status.manualStop = false;

	let inputForFfmpeg: any = videoSource;
	let tempFilePath: string | null = null;
	let downloadInProgressMessage: Message | null = null;
	let isLiveYouTubeStream = false;
	let controller: AbortController | undefined;
	let streamDebugInterval: NodeJS.Timeout | null = null;
	let removeStreamDebugListeners: (() => void) | null = null;
	let stallDetected = false;
	let chunkCount = 0;
	let totalBytes = 0;
	let firstChunkAt = 0;
	let lastChunkAt = 0;
	let streamStartedAt = 0;
	let streamFailedWithOutputClosed = false;
	const isTwitchPlayback = (
		typeof videoSource === 'string' && (videoSource.includes('twitch.tv') || videoSource.includes('ttvnw.net'))
	) || (title?.startsWith('twitch.tv/') ?? false);
	const isYoutubePlayback = typeof videoSource === 'string' && (videoSource.includes('youtube.com/') || videoSource.includes('youtu.be/'));

	try {
		if (typeof videoSource === 'string' && (videoSource.includes('youtube.com/') || videoSource.includes('youtu.be/'))) {
			logFlow(resolvedFlowId, 'play_video.youtube.inspect');
			const videoDetails = await youtube.getVideoInfo(videoSource);

			if (videoDetails?.videoDetails?.isLiveContent) {
				isLiveYouTubeStream = true;
				logFlow(resolvedFlowId, 'play_video.youtube.live_detected');
				logger.info(`YouTube video is live: ${title || videoSource}.`);
				const liveStreamUrl = await youtube.getLiveStreamUrl(videoSource);
				if (liveStreamUrl) {
					inputForFfmpeg = liveStreamUrl;
					logFlow(resolvedFlowId, 'play_video.youtube.live_url_resolved');
					logger.info(`Sử dụng URL luồng trực tiếp cho ffmpeg: ${liveStreamUrl}`);
				} else {
					logFlow(resolvedFlowId, 'play_video.abort', { reason: 'live_url_unavailable' });
					logger.error(`Không thể lấy URL luồng trực tiếp cho ${title || videoSource}.`);
					await sendError(message, `Không thể lấy URL luồng trực tiếp cho \`${title || 'YouTube live video'}\`.`);
					await cleanupStreamStatus(guildId);
					return;
				}
			} else {
				if (prefetchedPath) {
					inputForFfmpeg = prefetchedPath;
					tempFilePath = prefetchedPath;
					logFlow(resolvedFlowId, 'play_video.youtube.use_prefetched', { path: prefetchedPath });
					logger.info(`Sử dụng video đã tải trước: ${prefetchedPath}`);
				} else {
				logFlow(resolvedFlowId, 'play_video.youtube.download_start');
				const downloadingMessage = [
					`-# 📥 Đang tải về...`,
					`> **${title || videoSource}**`
				].join("\n");

				if (!initialMessage) {
					downloadInProgressMessage = await message.reply(downloadingMessage).catch(e => {
						logger.warn("Gửi thông báo 'Đang tải...' thất bại:", e);
						return null;
					});
				} else {
					downloadInProgressMessage = await initialMessage.edit(downloadingMessage).catch(e => {
						logger.warn("Gửi thông báo 'Đang tải...' thất bại:", e);
						return null;
					});
				}
				
				logger.info(`Đang tải xuống ${title || videoSource}...`);

				const ytDlpDownloadOptions: Parameters<typeof downloadToTempFile>[1] = {
					format: `bestvideo[height<=${streamOpts.height || 720}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${streamOpts.height || 720}]+bestaudio/best[height<=${streamOpts.height || 720}]/best`,
					noPlaylist: true,
				};

					try {
						tempFilePath = await downloadToTempFile(videoSource, ytDlpDownloadOptions);
						inputForFfmpeg = tempFilePath;
						logFlow(resolvedFlowId, 'play_video.youtube.download_done', { tempFilePath });
						logger.info(`Đang phát ${title || videoSource}...`);
						if (downloadInProgressMessage) {
							await downloadInProgressMessage.delete().catch(e => logger.warn("Xóa thông báo 'Đang tải...' thất bại:", e));
						}
					} catch (downloadError) {
						logFlow(resolvedFlowId, 'play_video.abort', {
							reason: 'youtube_download_failed',
							error: downloadError instanceof Error ? downloadError.message : String(downloadError)
						});
						logger.error('Tải xuống video YouTube thất bại:', downloadError);
						if (downloadInProgressMessage) {
							await downloadInProgressMessage.edit(`❌ Tải xuống thất bại \`${title || 'Video YouTube'}\`.`).catch(e => logger.warn("Sửa thông báo 'Đang tải...' thất bại:", e));
						} else {
							await sendError(message, `Tải xuống video thất bại: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
						}
						await cleanupStreamStatus(guildId);
						return;
					}
				}
			}
		}

		logFlow(resolvedFlowId, 'play_video.voice_join.start', { guildId, channelId });
		status.channelInfo = { guildId, channelId, cmdChannelId };
		status.joinsucc = false;
		await joinVoiceWithTimeout(guildId, channelId, resolvedFlowId);
		await waitForVoiceHandshakeReady(guildId, resolvedFlowId);
		status.joined = true;
		status.playing = true;
		await prefetchNextInQueue(guildId);

		if (title) {
			streamer.client.user?.setActivity(status_watch(title) as ActivityOptions);
			const voiceChannel = streamer.client.channels.cache.get(channelId);

			if (voiceChannel?.type === 'GUILD_VOICE' || voiceChannel?.type === 'GUILD_STAGE_VOICE') {
				//voiceChannel.status = `📽 ${title}`;
				await updateVoiceStatus(channelId, `📽 ${title}`);
			}
		}

		await sendPlaying(message, title || videoSource);
		logFlow(resolvedFlowId, 'play_video.now_playing_sent', { title: title || videoSource });

		const existingController = controllerMap.get(guildId);
		existingController?.abort();
		controller = new AbortController();
		controllerMap.set(guildId, controller);

		const useTwitchSafeProfile = isTwitchPlayback && twitchSafeProfile.enabled;
		const useYoutubeSafeProfile = isYoutubePlayback && youtubeSafeProfile.enabled;

		let targetFrameRate = streamOpts.frameRate;
		let targetHeight = streamOpts.height;
		let targetWidth = streamOpts.width;
		let targetBitrateVideo = streamOpts.bitrateVideo;
		let targetBitrateVideoMax = streamOpts.bitrateVideoMax;
		let targetVideoCodec = streamOpts.videoCodec;
		let targetIncludeAudio = !isTwitchPlayback;

		if (useTwitchSafeProfile) {
			targetFrameRate = twitchSafeProfile.frameRate;
			targetHeight = twitchSafeProfile.height;
			targetWidth = twitchSafeProfile.width;
			targetBitrateVideo = twitchSafeProfile.bitrateVideo;
			targetBitrateVideoMax = twitchSafeProfile.bitrateVideoMax;
			targetVideoCodec = twitchSafeProfile.videoCodec;
			targetIncludeAudio = twitchSafeProfile.includeAudio;
		} else if (useYoutubeSafeProfile) {
			targetFrameRate = youtubeSafeProfile.frameRate;
			targetHeight = youtubeSafeProfile.height;
			targetWidth = youtubeSafeProfile.width;
			targetBitrateVideo = youtubeSafeProfile.bitrateVideo;
			targetBitrateVideoMax = youtubeSafeProfile.bitrateVideoMax;
			targetVideoCodec = youtubeSafeProfile.videoCodec;
			targetIncludeAudio = youtubeSafeProfile.includeAudio;
		}

		if (retryCount > 0 && retryProfile.enabled) {
			targetFrameRate = Math.min(targetFrameRate, retryProfile.frameRate);
			targetHeight = Math.min(targetHeight, retryProfile.height);
			targetWidth = Math.min(targetWidth, retryProfile.width);
			targetBitrateVideo = Math.min(targetBitrateVideo, retryProfile.bitrateVideo);
			targetBitrateVideoMax = Math.min(targetBitrateVideoMax, retryProfile.bitrateVideoMax);
			targetIncludeAudio = targetIncludeAudio && retryProfile.includeAudio;
		}

		const encoderOptions = {
			...streamOpts,
			frameRate: targetFrameRate,
			height: targetHeight,
			width: targetWidth,
			bitrateVideo: targetBitrateVideo,
			bitrateVideoMax: targetBitrateVideoMax,
			videoCodec: targetVideoCodec,
			includeAudio: targetIncludeAudio,
			customFfmpegFlags: isTwitchPlayback
				? [
					'-fflags', 'nobuffer',
					'-flags', 'low_delay',
					'-reconnect', '1',
					'-reconnect_streamed', '1',
					'-reconnect_on_network_error', '1',
					'-reconnect_on_http_error', '4xx,5xx',
					'-reconnect_delay_max', '2',
					'-rw_timeout', '15000000'
				]
				: []
		};

		if (isTwitchPlayback) {
			logFlow(resolvedFlowId, 'play_video.ffmpeg.twitch_profile', {
				useSafeProfile: useTwitchSafeProfile,
				frameRate: encoderOptions.frameRate,
				width: encoderOptions.width,
				height: encoderOptions.height,
				bitrateVideo: encoderOptions.bitrateVideo,
				bitrateVideoMax: encoderOptions.bitrateVideoMax,
				videoCodec: encoderOptions.videoCodec,
				includeAudio: encoderOptions.includeAudio
			});
			logFlow(resolvedFlowId, 'play_video.ffmpeg.twitch_no_audio', {
				reason: 'avoid_av_sync_stall_on_live_twitch'
			});
		}

		if (isYoutubePlayback) {
			logFlow(resolvedFlowId, 'play_video.ffmpeg.youtube_profile', {
				useSafeProfile: useYoutubeSafeProfile,
				frameRate: encoderOptions.frameRate,
				width: encoderOptions.width,
				height: encoderOptions.height,
				bitrateVideo: encoderOptions.bitrateVideo,
				bitrateVideoMax: encoderOptions.bitrateVideoMax,
				videoCodec: encoderOptions.videoCodec,
				includeAudio: encoderOptions.includeAudio
			});
		}

		if (retryCount > 0) {
			logFlow(resolvedFlowId, 'play_video.retry.degraded_profile', {
				retryCount,
				frameRate: encoderOptions.frameRate,
				width: encoderOptions.width,
				height: encoderOptions.height,
				bitrateVideo: encoderOptions.bitrateVideo,
				bitrateVideoMax: encoderOptions.bitrateVideoMax,
				includeAudio: encoderOptions.includeAudio
			});
		}

		logFlow(resolvedFlowId, 'play_video.ffmpeg.prepare');
		const { command, output: ffmpegOutput } = prepareStream(inputForFfmpeg, encoderOptions, controller.signal);

		command.on('start', (commandLine: string) => {
			logFlow(resolvedFlowId, 'play_video.ffmpeg.start', {
				connection: getConnectionSnapshot()
			});
			logger.info(`FFmpeg command: ${commandLine}`);
		});

		command.on('progress', (progress: any) => {
			logFlow(resolvedFlowId, 'play_video.ffmpeg.progress', {
				frames: progress?.frames ?? null,
				currentKbps: progress?.currentKbps ?? null,
				timemark: progress?.timemark ?? null,
				targetSize: progress?.targetSize ?? null
			});
		});

		command.on('stderr', (line: string) => {
			const msg = line?.trim();
			if (!msg) return;
			if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('failed')) {
				logger.warn(`ffmpeg stderr: ${msg}`);
			}
		});

		command.on('end', () => {
			logFlow(resolvedFlowId, 'play_video.ffmpeg.end', {
				connection: getConnectionSnapshot()
			});
		});

		chunkCount = 0;
		totalBytes = 0;
		firstChunkAt = 0;
		lastChunkAt = 0;
		streamStartedAt = Date.now();
		streamFailedWithOutputClosed = false;

		const onOutputData = (chunk: Buffer) => {
			chunkCount += 1;
			totalBytes += chunk.length;
			if (!firstChunkAt) {
				firstChunkAt = Date.now();
				logFlow(resolvedFlowId, 'play_video.output.first_chunk', {
					afterMs: firstChunkAt - streamStartedAt,
					chunkBytes: chunk.length
				});
			}
			lastChunkAt = Date.now();

			if (chunkCount % 120 === 0) {
				logFlow(resolvedFlowId, 'play_video.output.chunk_progress', {
					chunks: chunkCount,
					totalBytes,
					uptimeMs: Date.now() - streamStartedAt
				});
			}
		};

		const onOutputEnd = () => {
			logFlow(resolvedFlowId, 'play_video.output.end', {
				chunks: chunkCount,
				totalBytes,
				uptimeMs: Date.now() - streamStartedAt
			});
		};

		const onOutputClose = () => {
			logFlow(resolvedFlowId, 'play_video.output.close', {
				chunks: chunkCount,
				totalBytes,
				uptimeMs: Date.now() - streamStartedAt
			});
		};

		const onOutputError = (error: unknown) => {
			logFlow(resolvedFlowId, 'play_video.output.error', {
				error: error instanceof Error ? error.message : String(error)
			});
		};

		ffmpegOutput.on('data', onOutputData);
		ffmpegOutput.on('end', onOutputEnd);
		ffmpegOutput.on('close', onOutputClose);
		ffmpegOutput.on('error', onOutputError);

		removeStreamDebugListeners = () => {
			ffmpegOutput.off('data', onOutputData);
			ffmpegOutput.off('end', onOutputEnd);
			ffmpegOutput.off('close', onOutputClose);
			ffmpegOutput.off('error', onOutputError);
		};

		streamDebugInterval = setInterval(() => {
			const elapsedMs = Date.now() - streamStartedAt;
			const kbps = elapsedMs > 0 ? Math.round((totalBytes * 8) / elapsedMs) : 0;
			const sinceLastChunkMs = lastChunkAt > 0 ? Date.now() - lastChunkAt : null;
			const connection = getConnectionSnapshot();
			logFlow(resolvedFlowId, 'play_video.output.heartbeat', {
				elapsedMs,
				chunks: chunkCount,
				totalBytes,
				approxKbps: kbps,
				firstChunkSeen: firstChunkAt > 0,
				sinceLastChunkMs,
				connection
			});

			if (sinceLastChunkMs !== null && sinceLastChunkMs > 5000 && chunkCount > 0) {
				logger.warn(`Phát hiện stall output: không có chunk mới trong ${sinceLastChunkMs}ms (chunks=${chunkCount}, bytes=${totalBytes}).`);
				logFlow(resolvedFlowId, 'play_video.output.stall_detected', {
					sinceLastChunkMs,
					chunks: chunkCount,
					totalBytes,
					connection
				});

				if (sinceLastChunkMs > 10000 && controller && !controller.signal.aborted && !stallDetected) {
					stallDetected = true;
					logFlow(resolvedFlowId, 'play_video.output.stall_abort', {
						reason: 'output_stall_over_10s',
						isTwitchPlayback,
						retryCount
					});
					controller.abort();
				}
			}
		}, 3000);

		command.on("error", (err, stdout, stderr) => {
			// Don't log error if it's due to manual stop
			if (!status.manualStop && controller && !controller.signal.aborted) {
				if (typeof err?.message === 'string' && err.message.toLowerCase().includes('output stream closed')) {
					streamFailedWithOutputClosed = true;
				}
				logFlow(resolvedFlowId, 'play_video.ffmpeg.error', { message: err.message });
				logger.error(`Lỗi xảy ra với ffmpeg: ${err.message}`);
				if (stdout) {
					logger.error(`ffmpeg stdout: ${stdout}`);
				}
				if (stderr) {
					logger.error(`ffmpeg stderr: ${stderr}`);
				}
				controller.abort();
			}
		});

		logFlow(resolvedFlowId, 'play_video.stream.start');
		await playStream(ffmpegOutput, streamer, undefined, controller.signal)
			.catch((err) => {
				if (controller && !controller.signal.aborted) {
					logFlow(resolvedFlowId, 'play_video.stream.error', { error: err instanceof Error ? err.message : String(err) });
					logger.error('Lỗi playStream:', err);
				}
				if (controller && !controller.signal.aborted) controller.abort();
			});

		if (controller && !controller.signal.aborted) {
			logFlow(resolvedFlowId, 'play_video.stream.finished');
			logger.info(`Đã phát xong: ${title || videoSource}`);
		}

	} catch (error) {
		logFlow(resolvedFlowId, 'play_video.exception', { error: error instanceof Error ? error.message : String(error) });
		logger.error(`Lỗi trong playVideo cho ${title || videoSource}:`, error);
		if (controller && !controller.signal.aborted) controller.abort();
	} finally {
		if (streamDebugInterval) {
			clearInterval(streamDebugInterval);
			streamDebugInterval = null;
		}

		if (removeStreamDebugListeners) {
			removeStreamDebugListeners();
			removeStreamDebugListeners = null;
		}

		logFlow(resolvedFlowId, 'play_video.finally', { manualStop: status.manualStop });
		let shouldRetryCurrent = false;
		let retrySource = videoSource;
		const streamDurationMs = Date.now() - streamStartedAt;
		const isFastFailOutputClose = isTwitchPlayback
			&& streamFailedWithOutputClosed
			&& streamDurationMs <= 10000
			&& chunkCount > 0;

		if ((stallDetected || isFastFailOutputClose) && retryCount < 1) {
			shouldRetryCurrent = true;
			logFlow(resolvedFlowId, 'play_video.retry.reason', {
				retryCount: retryCount + 1,
				stallDetected,
				streamFailedWithOutputClosed,
				streamDurationMs,
				chunks: chunkCount,
				totalBytes
			});
			const twitchTitle = title?.startsWith('twitch.tv/') ? title.slice('twitch.tv/'.length) : '';
			const twitchChannel = twitchTitle.split('?')[0].trim();
			if (isTwitchPlayback && twitchChannel) {
				const refreshed = await getTwitchStreamUrl(`https://www.twitch.tv/${twitchChannel}`, resolvedFlowId);
				if (refreshed) {
					retrySource = refreshed;
					logFlow(resolvedFlowId, 'play_video.retry.twitch_refreshed_url', { twitchChannel, retryCount: retryCount + 1 });
				} else {
					logFlow(resolvedFlowId, 'play_video.retry.twitch_refresh_failed', { twitchChannel, retryCount: retryCount + 1 });
				}
			}
		}

		const shouldStartNext = !status.manualStop && !shouldRetryCurrent;
		if (!status.manualStop && controller && !controller.signal.aborted) {
			await sendFinishMessage(guildId);
		}

		await cleanupStreamStatus(guildId);
		if (shouldStartNext) {
			logFlow(resolvedFlowId, 'play_video.queue_next.start');
			await startNextInQueue(guildId);
		}

		if (shouldRetryCurrent) {
			await new Promise((resolve) => setTimeout(resolve, 1200));
			logFlow(resolvedFlowId, 'play_video.retry.start', { retryCount: retryCount + 1 });
			await playVideo(message, retrySource, title, undefined, targetVoiceChannelId, undefined, resolvedFlowId, retryCount + 1);
		}

		if (tempFilePath && !isLiveYouTubeStream) {
			try {
				fs.unlinkSync(tempFilePath);
				logFlow(resolvedFlowId, 'play_video.temp_cleanup.done', { tempFilePath });
			} catch (cleanupError) {
				logger.error(`Xóa tệp tạm ${tempFilePath} thất bại:`, cleanupError);
			}
		}
	}
}

// Function to cleanup stream status

async function cleanupStreamStatus(guildId: string) {
	const status = getStreamStatus(guildId);
	try {
		const controller = controllerMap.get(guildId);
		controller?.abort();
		streamer.stopStream();
		streamer.leaveVoice();

		streamer.client.user?.setActivity(status_idle() as ActivityOptions);

		const voiceChannel = streamer.client.channels.cache.get(status.channelInfo.channelId);

		if (voiceChannel?.type === 'GUILD_VOICE' || voiceChannel?.type === 'GUILD_STAGE_VOICE') {
			//voiceChannel.status = "";
			await updateVoiceStatus(status.channelInfo.channelId, "");
		}

		// Reset all status flags
		resetStreamStatus(guildId);
		controllerMap.delete(guildId);
		prefetchMap.delete(guildId);
	} catch (error) {
		logger.error('Lỗi khi dọn dẹp:', error);
	}
}

function parseResolutionArea(resolution?: string): number {
	if (!resolution) return 0;
	const match = resolution.match(/(\d+)x(\d+)/i);
	if (!match) return 0;
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
	return width * height;
}

function selectBestTwitchStream(streams: TwitchStream[]): TwitchStream | null {
	if (!streams.length) return null;

	const targetArea = Math.max(1, config.width * config.height);
	let bestAtOrBelow: TwitchStream | null = null;
	let bestAtOrBelowArea = -1;
	let bestAbove: TwitchStream | null = null;
	let bestAboveArea = Number.MAX_SAFE_INTEGER;

	for (const stream of streams) {
		const area = parseResolutionArea(stream.resolution);
		if (area <= 0) continue;

		if (area <= targetArea) {
			if (area > bestAtOrBelowArea) {
				bestAtOrBelowArea = area;
				bestAtOrBelow = stream;
			}
		} else if (area < bestAboveArea) {
			bestAboveArea = area;
			bestAbove = stream;
		}
	}

	return bestAtOrBelow || bestAbove || streams[0];
}

async function getTwitchStreamUrlViaYtDlp(url: string, flowId?: string): Promise<string | null> {
	try {
		if (flowId) logFlow(flowId, 'twitch.ytdlp_fallback.start', { url });
		const result = await ytdl(url, {
			getUrl: true,
			noWarnings: true,
			noPlaylist: true,
			format: `bestvideo[height<=${config.height}]+bestaudio/best[height<=${config.height}]/best`
		});

		const text = typeof result === 'string' ? result : String(result ?? '');
		const firstUrl = text
			.split(/\r?\n/)
			.map(line => line.trim())
			.find(line => line.startsWith('http://') || line.startsWith('https://'));

		if (firstUrl) {
			if (flowId) logFlow(flowId, 'twitch.ytdlp_fallback.success');
			return firstUrl;
		}
		logger.error('yt-dlp không trả về URL stream hợp lệ cho Twitch.');
		return null;
	} catch (error) {
		if (flowId) logFlow(flowId, 'twitch.ytdlp_fallback.error', { error: error instanceof Error ? error.message : String(error) });
		logger.error('Fallback yt-dlp cho Twitch thất bại:', error);
		return null;
	}
}

// Function to get Twitch URL
async function getTwitchStreamUrl(url: string, flowId?: string): Promise<string | null> {
	try {
		if (flowId) logFlow(flowId, 'twitch.resolve.start', { url });
		const parsed = new URL(url);
		const segments = parsed.pathname.split('/').filter(Boolean);

		// Handle VODs
		if (segments.includes('videos')) {
			const videosIndex = segments.indexOf('videos');
			const vodId = segments[videosIndex + 1];
			if (!vodId) {
				logger.error('URL Twitch VOD không hợp lệ, thiếu ID video.');
				if (flowId) logFlow(flowId, 'twitch.resolve.vod.invalid');
				return await getTwitchStreamUrlViaYtDlp(url, flowId);
			}

			try {
				const vodInfo = await getVod(vodId);
				const vod = selectBestTwitchStream(vodInfo);
				if (vod?.url) {
					if (flowId) logFlow(flowId, 'twitch.resolve.vod.success', { resolution: vod.resolution });
					return vod.url;
				}
				logger.error('Không tìm thấy URL VOD từ twitch-m3u8');
			} catch (error) {
				if (flowId) logFlow(flowId, 'twitch.resolve.vod.error', { error: error instanceof Error ? error.message : String(error) });
				logger.warn('twitch-m3u8 lỗi khi lấy VOD, chuyển sang yt-dlp:', error);
			}

			return await getTwitchStreamUrlViaYtDlp(url, flowId);
		} else {
			const twitchId = segments[0];
			if (!twitchId) {
				logger.error('URL Twitch live không hợp lệ, thiếu channel.');
				if (flowId) logFlow(flowId, 'twitch.resolve.live.invalid');
				return await getTwitchStreamUrlViaYtDlp(url, flowId);
			}

			try {
				const streams = await getStream(twitchId);
				const stream = selectBestTwitchStream(streams);
				if (stream?.url) {
					if (flowId) logFlow(flowId, 'twitch.resolve.live.success', { resolution: stream.resolution });
					return stream.url;
				}
				logger.error('Không tìm thấy URL luồng từ twitch-m3u8');
			} catch (error) {
				if (flowId) logFlow(flowId, 'twitch.resolve.live.error', { error: error instanceof Error ? error.message : String(error) });
				logger.warn('twitch-m3u8 lỗi khi lấy stream live, chuyển sang yt-dlp:', error);
			}

			return await getTwitchStreamUrlViaYtDlp(url, flowId);
		}
	} catch (error) {
		if (flowId) logFlow(flowId, 'twitch.resolve.exception', { error: error instanceof Error ? error.message : String(error) });
		logger.error('Lấy URL Twitch thất bại:', error);
		return await getTwitchStreamUrlViaYtDlp(url, flowId);
	}
}

// Function to search for videos on YouTube
async function ytSearch(title: string): Promise<string[]> {
	return await youtube.search(title);
}

const status_idle = () => {
	return new CustomStatus(new Client())
		.setEmoji('📽')
		.setState('Đang xem gì đó!')
}

const status_watch = (name: string) => {
	return new CustomStatus(new Client())
		.setEmoji('📽')
		.setState(`Đang phát ${name.substring(0, 112)}...`)
}

async function updateVoiceStatus(channelId: string, status: string): Promise<boolean> {
	try {
		if (!channelId) {
			logger.warn('Bỏ qua cập nhật trạng thái kênh thoại: thiếu channelId');
			return false;
		}
		const token = config.token;
		if (!token) {
			logger.warn('Token Discord chưa được cấu hình, không thể cập nhật trạng thái kênh thoại');
			return false;
		}

		const payload = JSON.stringify({ status });

		return await new Promise<boolean>((resolve) => {
			const opts = {
				method: 'PUT',
				headers: {
					'Authorization': token,
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload)
				}
			};

			const req = https.request(`https://discord.com/api/v10/channels/${channelId}/voice-status`, opts as any, (res: any) => {
				let body = '';
				res.on('data', (chunk: any) => body += chunk);
				res.on('end', () => {
					if (res.statusCode >= 200 && res.statusCode < 300) {
						logger.info(`Đã cập nhật trạng thái kênh thoại ${channelId} -> ${status}`);
						resolve(true);
					} else {
						logger.warn(`Không thể cập nhật trạng thái kênh thoại ${channelId}: ${res.statusCode} ${res.statusMessage} - ${body}. Bỏ qua và tiếp tục.`);
						resolve(false);
					}
				});
			});

			req.setTimeout(10000, () => {
				logger.warn(`Yêu cầu cập nhật trạng thái kênh thoại ${channelId} bị timeout. Bỏ qua và tiếp tục.`);
				req.destroy();
				resolve(false);
			});

			req.on('error', (err: any) => {
				logger.warn('Lỗi khi cập nhật trạng thái kênh thoại, bỏ qua và tiếp tục:', err);
				resolve(false);
			});

			req.write(payload);
			req.end();
		});
	} catch (err) {
		logger.warn('Lỗi updateVoiceStatus, bỏ qua và tiếp tục:', err);
		return false;
	}
}

// Funtction to send playing message
async function sendPlaying(message: Message, title: string) {
	const content = [
		`-# 📽 Đang phát`,
		`> **${title}**`
	].join("\n");
	await Promise.all([
		message.react('▶️'),
		message.reply(content)
	]);
}

// Function to send finish message
async function sendFinishMessage(guildId: string) {
	const channelId = getStreamStatus(guildId).channelInfo.cmdChannelId;
	if (!channelId) return;
	const channel = streamer.client.channels.cache.get(channelId.toString()) as TextChannel;
	if (channel) {
		const content = [
			`-# ⏹️ Ngắt kết nối`,
			`> **Video đã kết thúc.**`
		].join("\n");
		channel.send(content);
	}
}

// Function to send video list message
async function sendList(message: Message, items: string[], type?: string) {
	await message.react('📋');
	if (type == "ytsearch") {
		const content = [
			`-# 📋 Kết quả tìm kiếm`,
			items.map(i => `- ${i}`).join('\n')
		].join("\n");
		await message.reply(content);
	} else if (type == "refresh") {
		const content = [
			`-# 📋 Đã làm mới danh sách video`,
			items.map(i => `- ${i}`).join('\n')
		].join("\n");
		await message.reply(content);
	} else if (type == "queue") {
		const content = [
			`-# 📋 Hàng đợi phát`,
			items.map(i => `- ${i}`).join('\n')
		].join("\n");
		await message.reply(content);
	} else {
		const content = [
			`-# 📋 Danh sách video`,
			items.map(i => `- ${i}`).join('\n')
		].join("\n");
		await message.channel.send(content);
	}
}

// Function to send info message
async function sendInfo(message: Message, title: string, description: string) {
	await message.react('ℹ️');
	await message.channel.send(`> ℹ️ ${title}\n> **${description}**`);
}


// Function to send success message
async function sendSuccess(message: Message, description: string) {
	await message.react('✅');
	const content = [
		`-# ✅ Thành công`,
		`> **${description}**`
	].join("\n");
	await message.channel.send(content);
}

// Function to send error message
async function sendError(message: Message, error: string) {
	await message.react('❌');
	const content = [
		`-# ❌ Lỗi`,
		`> **${error}**`
	].join("\n");
	await message.reply(content);
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
	if (!(error instanceof Error && error.message.includes('SIGTERM'))) {
		logger.error('Ngoại lệ không được xử lý:', error);
		return
	}
});

process.on('unhandledRejection', (reason) => {
	logger.error('Promise rejection không được xử lý:', reason);
});

process.on('warning', (warning) => {
	logger.warn('Node warning:', warning);
});

// Run server if enabled in config
if (config.server_enabled) {
	// Run server.ts
	import('./server/index.js');
}

// Login to Discord
client.login(config.token);