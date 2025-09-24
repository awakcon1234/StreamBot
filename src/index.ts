import { Client, TextChannel, CustomStatus, Message, MessageAttachment, ActivityOptions, BaseGuildVoiceChannel } from "discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream } from "@dank074/discord-video-stream";
import config from "./config.js";
import fs from 'fs';
import path from 'path';
import { getStream, getVod } from 'twitch-m3u8';
import yts from 'play-dl';
import { getVideoParams, ffmpegScreenshot } from "./utils/ffmpeg.js";
import logger from './utils/logger.js';
import { downloadExecutable, downloadToTempFile, checkForUpdatesAndUpdate } from './utils/yt-dlp.js';
import { Youtube } from './utils/youtube.js';
import { TwitchStream } from './@types/index.js';

// Download yt-dlp and check for updates
(async () => {
	try {
		await downloadExecutable();
		await checkForUpdatesAndUpdate();
	} catch (error) {
		logger.error("Lỗi khi thiết lập/cập nhật yt-dlp ban đầu:", error);
	}
})();

// Create a new instance of Streamer
const streamer = new Streamer(new Client());

// Declare a controller to abort the stream
let controller: AbortController;

// Create a new instance of Youtube
const youtube = new Youtube();

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
	// replace space with _
	return { name: fileName.replace(/ /g, '_'), path: path.join(config.videosDir, file) };
});

// print out all videos
logger.info(`Các video có sẵn:\n${videos.map(m => m.name).join('\n')}`);

// Ready event
streamer.client.on("ready", async () => {
	if (streamer.client.user) {
		logger.info(`${streamer.client.user.tag} đã sẵn sàng`);
		streamer.client.user?.setActivity(status_idle() as ActivityOptions);
	}
});

// Stream status object
const streamStatus = {
	joined: false,
	joinsucc: false,
	playing: false,
	manualStop: false,
	channelInfo: {
		guildId: config.guildId,
		channelId: config.videoChannelId,
		cmdChannelId: config.cmdChannelId
	}
}

// Voice state update event
streamer.client.on('voiceStateUpdate', async (oldState, newState) => {
	// When exit channel
	if (oldState.member?.user.id == streamer.client.user?.id) {
		if (oldState.channelId && !newState.channelId) {
			streamStatus.joined = false;
			streamStatus.joinsucc = false;
			streamStatus.playing = false;
			streamStatus.channelInfo = {
				guildId: config.guildId,
				channelId: config.videoChannelId,
				cmdChannelId: config.cmdChannelId
			}
			streamer.client.user?.setActivity(status_idle() as ActivityOptions);
		}
	}

	// When join channel success
	if (newState.member?.user.id == streamer.client.user?.id) {
		if (newState.channelId && !oldState.channelId) {
			streamStatus.joined = true;
			if (newState.guild.id == streamStatus.channelInfo.guildId && newState.channelId == streamStatus.channelInfo.channelId) {
				streamStatus.joinsucc = true;
			}
		}
	}
})

// Message create event
streamer.client.on('messageCreate', async (message) => {
	if (
		message.author.bot ||
		message.author.id === streamer.client.user?.id ||
		!config.cmdChannelId.includes(message.channel.id.toString()) ||
		!message.content.startsWith(config.prefix!)
	) return; // Ignore bots, self, non-command channels, and non-commands

	const args = message.content.slice(config.prefix!.length).trim().split(/ +/); // Split command and arguments

	if (args.length === 0) return; // No arguments provided

	const user_cmd = args.shift()!.toLowerCase();

	if (config.cmdChannelId.includes(message.channel.id)) {
		switch (user_cmd) {
			case 'play':
				{
					if (streamStatus.joined) {
						sendError(message, 'Đã tham gia');
						return;
					}
					// Get video name and find video file
					const videoname = args.shift()
					const video = videos.find(m => m.name == videoname);

					if (!video) {
						await sendError(message, 'Không tìm thấy video');
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

					// Play video
					playVideo(message, video.path, videoname);
				}
				break;
			case 'playlink':
				{
					if (streamStatus.joined) {
						sendError(message, 'Đã tham gia');
						return;
					}

					const link = args.shift() || '';

					if (!link) {
						await sendError(message, 'Vui lòng cung cấp liên kết.');
						return;
					}

					switch (true) {
						case (link.includes('youtube.com/') || link.includes('youtu.be/')):
							{
								try {
									const videoDetails = await youtube.getVideoInfo(link);

									if (videoDetails && videoDetails.title) {
										playVideo(message, link, videoDetails.title);
									} else {
										logger.error(`Không thể lấy thông tin video YouTube cho liên kết: ${link}.`);
										await sendError(message, 'Xử lý liên kết YouTube thất bại.');
									}
								} catch (error) {
									logger.error(`Lỗi khi xử lý liên kết YouTube: ${link}`, error);
									await sendError(message, 'Xử lý liên kết YouTube thất bại.');
								}
							}
							break;
						case link.includes('twitch.tv'):
							{
								const twitchId = link.split('/').pop() as string;
								const twitchUrl = await getTwitchStreamUrl(link);
								if (twitchUrl) {
									playVideo(message, twitchUrl, `twitch.tv/${twitchId}`);
								}
							}
							break;
						default:
							{
								playVideo(message, link, "URL");
							}
					}
				}
				break;
			case 'ytplay':
				{
					const title = args.length > 1 ? args.slice(1).join(' ') : args[1] || args.shift() || '';

					if (!title) {
						await sendError(message, 'Vui lòng cung cấp tiêu đề video.');
						return;
					}

					try {
						const searchResults = await yts.search(title, { limit: 1 });
						const videoResult = searchResults[0];

						const searchResult = await youtube.searchAndGetPageUrl(title);

						if (searchResult.pageUrl && searchResult.title) {
							playVideo(message, searchResult.pageUrl, searchResult.title);
						} else {
							logger.warn(`Không tìm thấy video hoặc tiêu đề bị thiếu cho tìm kiếm: "${title}" sử dụng youtube.searchAndGetPageUrl.`);
							throw new Error('Could not find video');
						}
					} catch (error) {
						logger.error('Không thể phát video YouTube:', error);
						await cleanupStreamStatus();
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
					if (!streamStatus.joined) {
						sendError(message, '**Đã dừng rồi!**');
						return;
					}

					try {
						streamStatus.manualStop = true;

						controller?.abort();

						await sendSuccess(message, 'Đã dừng phát video.');
						logger.info('Đã dừng phát video.');

						streamer.stopStream();
						streamer.leaveVoice();
						streamer.client.user?.setActivity(status_idle() as ActivityOptions);

						streamStatus.joined = false;
						streamStatus.joinsucc = false;
						streamStatus.playing = false;
						streamStatus.channelInfo = {
							guildId: "",
							channelId: "",
							cmdChannelId: "",
						};

					} catch (error) {
						logger.error('Lỗi khi dừng cưỡng bức:', error);
					}
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
					await sendInfo(message, 'Trạng thái',
						`Đã tham gia: ${streamStatus.joined}\nĐang phát: ${streamStatus.playing}`);
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
						'',
						'🛠️ **Công cụ**',
						`\`${config.prefix}list\` - Hiện danh sách video offline`,
						`\`${config.prefix}refresh\` - Cập nhật danh sách video`,
						`\`${config.prefix}status\` - Hiện trạng thái phát`,
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
	}
});

// Function to play video
async function playVideo(message: Message, videoSource: string, title?: string) {
	const [guildId, channelId, cmdChannelId] = [config.guildId, config.videoChannelId, config.cmdChannelId!];

	streamStatus.manualStop = false;

	let inputForFfmpeg: any = videoSource;
	let tempFilePath: string | null = null;
	let downloadInProgressMessage: Message | null = null;
	let isLiveYouTubeStream = false;

	try {
		if (typeof videoSource === 'string' && (videoSource.includes('youtube.com/') || videoSource.includes('youtu.be/'))) {
			const videoDetails = await youtube.getVideoInfo(videoSource);

			if (videoDetails?.videoDetails?.isLiveContent) {
				isLiveYouTubeStream = true;
				logger.info(`YouTube video is live: ${title || videoSource}.`);
				const liveStreamUrl = await youtube.getLiveStreamUrl(videoSource);
				if (liveStreamUrl) {
					inputForFfmpeg = liveStreamUrl;
					logger.info(`Sử dụng URL luồng trực tiếp cho ffmpeg: ${liveStreamUrl}`);
				} else {
					logger.error(`Không thể lấy URL luồng trực tiếp cho ${title || videoSource}.`);
					await sendError(message, `Không thể lấy URL luồng trực tiếp cho \`${title || 'YouTube live video'}\`.`);
					await cleanupStreamStatus();
					return;
				}
			} else {
				const downloadingMessage = [
					`-# 📥 Đang chuẩn bị...`,
					`> ${title || videoSource}`
				].join("\n");

				downloadInProgressMessage = await message.reply(downloadingMessage).catch(e => {
					logger.warn("Gửi thông báo 'Đang tải...' thất bại:", e);
					return null;
				});
				logger.info(`Đang tải xuống ${title || videoSource}...`);

				const ytDlpDownloadOptions: Parameters<typeof downloadToTempFile>[1] = {
					format: `bestvideo[height<=${streamOpts.height || 720}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${streamOpts.height || 720}]+bestaudio/best[height<=${streamOpts.height || 720}]/best`,
					noPlaylist: true,
				};

				try {
					tempFilePath = await downloadToTempFile(videoSource, ytDlpDownloadOptions);
					inputForFfmpeg = tempFilePath;
					logger.info(`Đang phát ${title || videoSource}...`);
					if (downloadInProgressMessage) {
						await downloadInProgressMessage.delete().catch(e => logger.warn("Xóa thông báo 'Đang tải...' thất bại:", e));
					}
				} catch (downloadError) {
					logger.error('Tải xuống video YouTube thất bại:', downloadError);
					if (downloadInProgressMessage) {
						await downloadInProgressMessage.edit(`❌ Tải xuống thất bại \`${title || 'Video YouTube'}\`.`).catch(e => logger.warn("Sửa thông báo 'Đang tải...' thất bại:", e));
					} else {
						await sendError(message, `Tải xuống video thất bại: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
					}
					await cleanupStreamStatus();
					return;
				}
			}
		}

		await streamer.joinVoice(guildId, channelId);
		streamStatus.joined = true;
		streamStatus.playing = true;
		streamStatus.channelInfo = { guildId, channelId, cmdChannelId };

		if (title) {
			streamer.client.user?.setActivity(status_watch(title) as ActivityOptions);
			const voiceChannel = streamer.client.channels.cache.get(channelId);

			if (voiceChannel?.type === 'GUILD_VOICE' || voiceChannel?.type === 'GUILD_STAGE_VOICE') {
				//voiceChannel.status = `📽 ${title}`;
				await updateVoiceStatus(channelId, `📽 ${title}`);
			}
		}

		await sendPlaying(message, title || videoSource);

		controller?.abort();
		controller = new AbortController();

		if (!controller) {
			throw new Error('Bộ điều khiển chưa được khởi tạo');
		}
		const { command, output: ffmpegOutput } = prepareStream(inputForFfmpeg, streamOpts, controller.signal);

		command.on("error", (err, stdout, stderr) => {
			// Don't log error if it's due to manual stop
			if (!streamStatus.manualStop && controller && !controller.signal.aborted) {
				logger.error('Lỗi xảy ra với ffmpeg:', err.message);
				if (stdout) {
					logger.error('ffmpeg stdout:', stdout);
				}
				if (stderr) {
					logger.error('ffmpeg stderr:', stderr);
				}
				controller.abort();
			}
		});

		await playStream(ffmpegOutput, streamer, undefined, controller.signal)
			.catch((err) => {
				if (controller && !controller.signal.aborted) {
					logger.error('Lỗi playStream:', err);
				}
				if (controller && !controller.signal.aborted) controller.abort();
			});

		if (controller && !controller.signal.aborted) {
			logger.info(`Đã phát xong: ${title || videoSource}`);
		}

	} catch (error) {
		logger.error(`Lỗi trong playVideo cho ${title || videoSource}:`, error);
		if (controller && !controller.signal.aborted) controller.abort();
	} finally {
		if (!streamStatus.manualStop && controller && !controller.signal.aborted) {
			await sendFinishMessage();
		}

		await cleanupStreamStatus();

		if (tempFilePath && !isLiveYouTubeStream) {
			try {
				fs.unlinkSync(tempFilePath);
			} catch (cleanupError) {
				logger.error(`Xóa tệp tạm ${tempFilePath} thất bại:`, cleanupError);
			}
		}
	}
}

// Function to cleanup stream status
async function cleanupStreamStatus() {
	if (streamStatus.manualStop) {
		return;
	}

	try {
		controller?.abort();
		streamer.stopStream();
		streamer.leaveVoice();

		streamer.client.user?.setActivity(status_idle() as ActivityOptions);

		const voiceChannel = streamer.client.channels.cache.get(streamStatus.channelInfo.channelId);

		if (voiceChannel?.type === 'GUILD_VOICE' || voiceChannel?.type === 'GUILD_STAGE_VOICE') {
			//voiceChannel.status = "";
			await updateVoiceStatus(streamStatus.channelInfo.channelId, "");
		}

		// Reset all status flags
		streamStatus.joined = false;
		streamStatus.joinsucc = false;
		streamStatus.playing = false;
		streamStatus.manualStop = false;
		streamStatus.channelInfo = {
			guildId: "",
			channelId: "",
			cmdChannelId: "",
		};
	} catch (error) {
		logger.error('Lỗi khi dọn dẹp:', error);
	}
}

// Function to get Twitch URL
async function getTwitchStreamUrl(url: string): Promise<string | null> {
	try {
		// Handle VODs
		if (url.includes('/videos/')) {
			const vodId = url.split('/videos/').pop() as string;
			const vodInfo = await getVod(vodId);
			const vod = vodInfo.find((stream: TwitchStream) => stream.resolution === `${config.width}x${config.height}`) || vodInfo[0];
			if (vod?.url) {
				return vod.url;
			}
			logger.error('Không tìm thấy URL VOD');
			return null;
		} else {
			const twitchId = url.split('/').pop() as string;
			const streams = await getStream(twitchId);
			const stream = streams.find((stream: TwitchStream) => stream.resolution === `${config.width}x${config.height}`) || streams[0];
			if (stream?.url) {
				return stream.url;
			}
			logger.error('Không tìm thấy URL luồng');
			return null;
		}
	} catch (error) {
		logger.error('Lấy URL Twitch thất bại:', error);
		return null;
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
		.setState(`Đang phát ${name}...`)
}

async function updateVoiceStatus(channelId: string, status: string) {
	try {
		if (!channelId) return;
		const token = config.token;
		if (!token) {
			logger.warn('Token Discord chưa được cấu hình, không thể cập nhật trạng thái kênh thoại');
			return;
		}

		const payload = JSON.stringify({ status });

		await new Promise<void>((resolve) => {
			const https = require('https');
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
					} else {
						logger.warn(`Không thể cập nhật trạng thái kênh thoại ${channelId}: ${res.statusCode} ${res.statusMessage} - ${body}`);
					}
					resolve();
				});
			});

			req.on('error', (err: any) => {
				logger.error('Lỗi khi cập nhật trạng thái kênh thoại:', err);
				resolve();
			});

			req.write(payload);
			req.end();
		});
	} catch (err) {
		logger.error('Lỗi updateVoiceStatus:', err);
	}
}

// Funtction to send playing message
async function sendPlaying(message: Message, title: string) {
	const content = [
		`-# 📽 Đang phát`,
		`> ${title}`
	].join("\n");
	await Promise.all([
		message.react('▶️'),
		message.reply(content)
	]);
}

// Function to send finish message
async function sendFinishMessage() {
	const channel = streamer.client.channels.cache.get(config.cmdChannelId.toString()) as TextChannel;
	if (channel) {
		const content = [
			`-# ⏹️ Ngắt kết nối`,
			`> Không còn video nào để phát tiếp.`
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
	await message.channel.send(`> ℹ️ ${title}\n${description}`);
}


// Function to send success message
async function sendSuccess(message: Message, description: string) {
	await message.react('✅');
	const content = [
		`-# ✅ Thành công`,
		`> ${description}`
	].join("\n");
	await message.channel.send(content);
}

// Function to send error message
async function sendError(message: Message, error: string) {
	await message.react('❌');
	const content = [
		`-# ❌ Lỗi`,
		`> ${error}`
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

// Run server if enabled in config
if (config.server_enabled) {
	// Run server.js
	import('./server.js');
}

// Login to Discord
streamer.client.login(config.token);