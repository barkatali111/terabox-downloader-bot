/**
 * Configuration file for TeraBox Downloader Bot
 * Contains all configurable parameters and settings
 */

const config = {
    // Telegram Bot Token (REPLACE WITH YOUR OWN)
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE',
    
    // Bot settings
    botName: 'TeraBox Downloader Bot',
    
    // Download settings
    download: {
        chunkSize: 10 * 1024 * 1024, // 10MB chunks for parallel download
        maxConcurrentDownloads: 3,    // Maximum simultaneous downloads
        maxConcurrentWorkers: 4,       // Maximum worker threads per download
        tempDir: './temp',             // Temporary file storage
        logsDir: './logs'               // Log files directory
    },
    
    // Rate limiting
    rateLimit: {
        maxRequestsPerUser: 1,          // Max requests per time window
        timeWindow: 10000                // Time window in milliseconds (10 seconds)
    },
    
    // Telegram limits
    telegram: {
        maxFileSize: 50 * 1024 * 1024    // 50MB Telegram limit
    },
    
    // TeraBox domains
    teraboxDomains: [
        'terabox.com',
        'www.terabox.com',
        'teraboxapp.com',
        '1024terabox.com'
    ],
    
    // User agent for requests
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

module.exports = config;
