import winston from 'winston';

function stringifyMeta(meta: unknown): string {
    if (meta === undefined || meta === null) return '';

    if (meta instanceof Error) {
        return meta.stack || meta.message;
    }

    if (typeof meta === 'object') {
        try {
            return JSON.stringify(meta);
        } catch {
            return String(meta);
        }
    }

    return String(meta);
}

// Custom log format
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.colorize(),
    winston.format.printf((info) => {
        const { level, message, timestamp, stack, ...meta } = info;
        const primary = stack || message;
        const metaText = Object.keys(meta).length > 0 ? stringifyMeta(meta) : '';
        return `[${timestamp}] ${level}: ${primary}${metaText ? `\n${metaText}` : ''}`;
    })
);

// Create logger instance
const logger = winston.createLogger({
    level: 'info',
    format: logFormat,
    transports: [
        // Console output
        new winston.transports.Console()
    ]
});

export default logger;
