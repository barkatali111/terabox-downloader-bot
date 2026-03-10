/**
 * Main Telegram Bot Application
 * Handles user interactions, message processing, and file delivery
 */

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const TeraBoxExtractor = require('./extractor');
const ParallelDownloader = require('./downloader');
const QueueManager = require('./queue');

// Initialize components
const bot = new TelegramBot(config.telegramBotToken, { polling: true });
const extractor = new TeraBoxExtractor();
const downloader = new ParallelDownloader();
const queue = new QueueManager();

// Logging setup
const logStream = fs.createWriteStream(
    path.join(config.download.logsDir, 'logs.txt'), 
    { flags: 'a' }
);

// Ensure directories exist
[config.download.tempDir, config.download.logsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Store active progress messages
const progressMessages = new Map();

/**
 * Logging function
 * @param {string} userId - User ID
 * @param {string} fileName - File name
 * @param {number} fileSize - File size
 * @param {number} downloadTime - Download time in ms
 */
function logActivity(userId, fileName, fileSize, downloadTime) {
    const logEntry = `${new Date().toISOString()} | User: ${userId} | File: ${fileName} | Size: ${fileSize} bytes | Time: ${downloadTime}ms\n`;
    logStream.write(logEntry);
    console.log(logEntry.trim());
}

/**
 * Start command handler
 */
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcomeMessage = `
Welcome to TeraBox Downloader Bot! 🚀

Send any TeraBox share link and I'll instantly process and download the file for you.

Features:
• High-speed parallel downloading
• Support for files up to 5GB
• Progress tracking
• Smart queue system
• Direct download links for large files

Send me a TeraBox link to get started!
    `;
    
    bot.sendMessage(chatId, welcomeMessage);
});

/**
 * Handle all messages (for link detection)
 */
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Ignore commands
    if (text.startsWith('/')) return;

    // Check if message contains TeraBox link
    if (!extractor.isValidTeraBoxLink(text)) {
        bot.sendMessage(chatId, '❌ Please send a valid TeraBox link.\nExample: https://terabox.com/s/xxxx');
        return;
    }

    // Start processing
    await processTeraBoxLink(chatId, text, msg.from.id);
});

/**
 * Process TeraBox link
 * @param {number} chatId - Chat ID
 * @param {string} link - TeraBox link
 * @param {string} userId - User ID
 */
async function processTeraBoxLink(chatId, link, userId) {
    let progressMessage;
    let startTime = Date.now();

    try {
        // Send initial processing message
        progressMessage = await bot.sendMessage(chatId, '🔄 Processing link...');
        progressMessages.set(userId, progressMessage.message_id);

        // Add to queue for processing
        const result = await queue.addToQueue(userId, link, async () => {
            
            // Step 1: Extract file information
            await editProgressMessage(chatId, progressMessage.message_id, '🔍 Extracting file information...');
            const fileInfo = await extractor.extractFileInfo(link);
            
            if (!fileInfo || !fileInfo.downloadUrl) {
                throw new Error('Could not extract file information');
            }

            // Check file size
            if (fileInfo.fileSize > config.telegram.maxFileSize) {
                // File too large for Telegram
                await editProgressMessage(
                    chatId, 
                    progressMessage.message_id, 
                    `📁 File: ${fileInfo.fileName}\n` +
                    `📊 Size: ${formatFileSize(fileInfo.fileSize)}\n\n` +
                    `⚠️ File exceeds Telegram's 50MB limit.\n\n` +
                    `🔗 Direct download link:\n${fileInfo.downloadUrl}`
                );
                
                logActivity(userId, fileInfo.fileName, fileInfo.fileSize, Date.now() - startTime);
                return;
            }

            // Step 2: Setup progress tracking
            setupProgressTracking(chatId, progressMessage.message_id, fileInfo);

            // Step 3: Download file
            await editProgressMessage(chatId, progressMessage.message_id, '📥 Starting download...');
            const filePath = await downloader.downloadFile(fileInfo.downloadUrl, fileInfo, userId);

            // Step 4: Upload to Telegram
            await editProgressMessage(chatId, progressMessage.message_id, '📤 Uploading to Telegram...');
            
            await bot.sendDocument(chatId, filePath, {
                caption: `✅ File: ${fileInfo.fileName}\n📊 Size: ${formatFileSize(fileInfo.fileSize)}`,
                filename: fileInfo.fileName
            });

            // Step 5: Cleanup and finalize
            const downloadTime = Date.now() - startTime;
            logActivity(userId, fileInfo.fileName, fileInfo.fileSize, downloadTime);
            
            await editProgressMessage(
                chatId, 
                progressMessage.message_id, 
                `✅ Download complete!\n📁 ${fileInfo.fileName}\n⏱️ Time: ${formatTime(downloadTime)}`
            );

            // Cleanup
            setTimeout(() => {
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                    bot.deleteMessage(chatId, progressMessage.message_id).catch(() => {});
                } catch (error) {
                    console.error('Cleanup error:', error.message);
                }
            }, 60000); // Delete after 1 minute

            return filePath;
        });

    } catch (error) {
        console.error('Processing error:', error);
        
        const errorMessage = error.message.includes('Rate limit')
            ? '⏳ Rate limit exceeded. Please wait 10 seconds before trying again.'
            : `❌ Error: ${error.message}`;
        
        if (progressMessage) {
            await editProgressMessage(chatId, progressMessage.message_id, errorMessage);
        } else {
            await bot.sendMessage(chatId, errorMessage);
        }
        
        // Cleanup progress tracking
        progressMessages.delete(userId);
    }
}

/**
 * Setup progress tracking for download
 * @param {number} chatId - Chat ID
 * @param {number} messageId - Message ID
 * @param {object} fileInfo - File information
 */
function setupProgressTracking(chatId, messageId, fileInfo) {
    const progressHandler = (progress) => {
        editProgressMessage(chatId, messageId, 
            `📁 File: ${fileInfo.fileName}\n` +
            `📊 Size: ${formatFileSize(fileInfo.fileSize)}\n\n` +
            `${progress.status}`
        );
    };

    downloader.on('progress', progressHandler);

    // Remove listener after download completes
    setTimeout(() => {
        downloader.removeListener('progress', progressHandler);
    }, 3600000); // Remove after 1 hour
}

/**
 * Edit progress message
 * @param {number} chatId - Chat ID
 * @param {number} messageId - Message ID
 * @param {string} text - New message text
 */
async function editProgressMessage(chatId, messageId, text) {
    try {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId
        });
    } catch (error) {
        // Ignore edit errors (message might be too old)
        if (!error.message.includes('message is not modified')) {
            console.error('Edit message error:', error.message);
        }
    }
}

/**
 * Format file size for display
 * @param {number} bytes - Size in bytes
 * @returns {string} - Formatted size
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Format time for display
 * @param {number} ms - Time in milliseconds
 * @returns {string} - Formatted time
 */
function formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Handle queue status command
 */
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const status = queue.getQueueStatus(userId);
    
    let statusMessage = '📊 Queue Status:\n\n';
    
    if (status.isDownloading) {
        statusMessage += '✅ Your download is currently in progress\n';
    } else if (status.inQueue) {
        statusMessage += `⏳ You are #${status.queuePosition} in queue\n`;
    } else {
        statusMessage += 'ℹ️ You have no active downloads\n';
    }
    
    statusMessage += `\nActive downloads: ${status.activeDownloads}\n`;
    statusMessage += `Queue length: ${status.queueLength}`;
    
    bot.sendMessage(chatId, statusMessage);
});

/**
 * Handle cancel command
 */
bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const cancelled = queue.cancelUserDownload(userId);
    
    if (cancelled) {
        bot.sendMessage(chatId, '✅ Your download has been cancelled.');
        
        // Clean up progress message
        const progressMsgId = progressMessages.get(userId);
        if (progressMsgId) {
            try {
                await bot.deleteMessage(chatId, progressMsgId);
            } catch (error) {
                // Ignore delete errors
            }
            progressMessages.delete(userId);
        }
    } else {
        bot.sendMessage(chatId, 'ℹ️ You have no active downloads to cancel.');
    }
});

/**
 * Error handling for bot
 */
bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

bot.on('webhook_error', (error) => {
    console.error('Webhook error:', error);
});

// Graceful shutdown
process.once('SIGINT', () => {
    console.log('Shutting down...');
    bot.stopPolling();
    logStream.end();
    process.exit(0);
});

process.once('SIGTERM', () => {
    console.log('Shutting down...');
    bot.stopPolling();
    logStream.end();
    process.exit(0);
});

console.log('TeraBox Downloader Bot is running...');
