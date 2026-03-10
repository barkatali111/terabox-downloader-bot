/**
 * Intelligent Queue Management System
 * Handles request queuing, rate limiting, and concurrent download management
 */

const EventEmitter = require('events');
const config = require('./config');

class QueueManager extends EventEmitter {
    constructor() {
        super();
        this.queue = [];                    // Pending requests
        this.activeDownloads = new Map();    // Currently processing downloads
        this.userRateLimit = new Map();      // Rate limiting per user
        this.downloadHistory = new Map();    // Track completed downloads
        this.maxConcurrent = config.download.maxConcurrentDownloads;
    }

    /**
     * Add request to queue
     * @param {string} userId - User ID
     * @param {string} link - TeraBox link
     * @param {function} processFunction - Function to process the download
     * @returns {Promise} - Queue promise
     */
    async addToQueue(userId, link, processFunction) {
        // Check rate limit
        if (this.isRateLimited(userId)) {
            throw new Error('Rate limit exceeded. Please wait 10 seconds before trying again.');
        }

        // Update rate limit
        this.updateRateLimit(userId);

        // Check if user already has active downloads
        const userActiveDownloads = Array.from(this.activeDownloads.values())
            .filter(download => download.userId === userId).length;

        if (userActiveDownloads >= 1) {
            // Add to queue instead of starting immediately
            return new Promise((resolve, reject) => {
                const queueItem = {
                    id: this.generateQueueId(),
                    userId,
                    link,
                    processFunction,
                    resolve,
                    reject,
                    status: 'queued',
                    addedAt: Date.now()
                };
                
                this.queue.push(queueItem);
                this.emit('queued', { userId, position: this.queue.length });
                
                // Process queue if slot available
                this.processQueue();
            });
        }

        // Start download immediately if slot available
        if (this.activeDownloads.size < this.maxConcurrent) {
            return this.startDownload(userId, link, processFunction);
        } else {
            // Add to queue
            return new Promise((resolve, reject) => {
                const queueItem = {
                    id: this.generateQueueId(),
                    userId,
                    link,
                    processFunction,
                    resolve,
                    reject,
                    status: 'queued',
                    addedAt: Date.now()
                };
                
                this.queue.push(queueItem);
                this.emit('queued', { userId, position: this.queue.length });
            });
        }
    }

    /**
     * Start a download
     * @param {string} userId - User ID
     * @param {string} link - TeraBox link
     * @param {function} processFunction - Processing function
     * @returns {Promise} - Download result
     */
    async startDownload(userId, link, processFunction) {
        const downloadId = this.generateDownloadId();
        
        const downloadItem = {
            id: downloadId,
            userId,
            link,
            status: 'downloading',
            startedAt: Date.now()
        };

        this.activeDownloads.set(downloadId, downloadItem);
        this.emit('started', { userId, downloadId });

        try {
            // Execute the download
            const result = await processFunction();
            
            // Mark as completed
            downloadItem.status = 'completed';
            downloadItem.completedAt = Date.now();
            
            // Store in history
            this.downloadHistory.set(downloadId, downloadItem);
            
            // Remove from active downloads
            this.activeDownloads.delete(downloadId);
            
            // Process next item in queue
            this.processQueue();
            
            return result;
            
        } catch (error) {
            // Handle failure
            downloadItem.status = 'failed';
            downloadItem.error = error.message;
            
            this.activeDownloads.delete(downloadId);
            this.processQueue();
            
            throw error;
        }
    }

    /**
     * Process next items in queue
     */
    processQueue() {
        // Check if slots available
        while (this.activeDownloads.size < this.maxConcurrent && this.queue.length > 0) {
            // Get next item (FIFO)
            const nextItem = this.queue.shift();
            
            // Check if item is expired (older than 30 minutes)
            if (Date.now() - nextItem.addedAt > 30 * 60 * 1000) {
                nextItem.reject(new Error('Queue item expired'));
                continue;
            }

            // Start the download
            this.startDownload(nextItem.userId, nextItem.link, nextItem.processFunction)
                .then(result => nextItem.resolve(result))
                .catch(error => nextItem.reject(error));
        }
    }

    /**
     * Check if user is rate limited
     * @param {string} userId - User ID
     * @returns {boolean} - True if rate limited
     */
    isRateLimited(userId) {
        const userLimit = this.userRateLimit.get(userId);
        if (!userLimit) return false;

        const now = Date.now();
        const timeSinceLastRequest = now - userLimit.lastRequest;

        return timeSinceLastRequest < config.rateLimit.timeWindow;
    }

    /**
     * Update rate limit for user
     * @param {string} userId - User ID
     */
    updateRateLimit(userId) {
        const now = Date.now();
        const userLimit = this.userRateLimit.get(userId) || { count: 0, lastRequest: 0 };

        // Reset count if time window passed
        if (now - userLimit.lastRequest > config.rateLimit.timeWindow) {
            userLimit.count = 0;
        }

        userLimit.count++;
        userLimit.lastRequest = now;

        this.userRateLimit.set(userId, userLimit);

        // Clean up old rate limit entries every hour
        if (Math.random() < 0.01) { // 1% chance to trigger cleanup
            this.cleanupRateLimits();
        }
    }

    /**
     * Clean up old rate limit entries
     */
    cleanupRateLimits() {
        const now = Date.now();
        for (const [userId, limit] of this.userRateLimit.entries()) {
            if (now - limit.lastRequest > 3600000) { // 1 hour
                this.userRateLimit.delete(userId);
            }
        }
    }

    /**
     * Get queue status for user
     * @param {string} userId - User ID
     * @returns {object} - Queue status
     */
    getQueueStatus(userId) {
        const userQueuePosition = this.queue.findIndex(item => item.userId === userId);
        const userActiveDownload = Array.from(this.activeDownloads.values())
            .find(download => download.userId === userId);

        return {
            inQueue: userQueuePosition !== -1,
            queuePosition: userQueuePosition !== -1 ? userQueuePosition + 1 : null,
            isDownloading: !!userActiveDownload,
            activeDownloads: this.activeDownloads.size,
            queueLength: this.queue.length
        };
    }

    /**
     * Cancel user's download
     * @param {string} userId - User ID
     * @returns {boolean} - True if cancelled
     */
    cancelUserDownload(userId) {
        // Check active downloads
        for (const [id, download] of this.activeDownloads.entries()) {
            if (download.userId === userId) {
                this.activeDownloads.delete(id);
                this.emit('cancelled', { userId, downloadId: id });
                return true;
            }
        }

        // Check queue
        const queueIndex = this.queue.findIndex(item => item.userId === userId);
        if (queueIndex !== -1) {
            const [cancelledItem] = this.queue.splice(queueIndex, 1);
            cancelledItem.reject(new Error('Download cancelled by user'));
            this.emit('cancelled', { userId });
            return true;
        }

        return false;
    }

    /**
     * Generate unique queue ID
     * @returns {string} - Queue ID
     */
    generateQueueId() {
        return `queue_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Generate unique download ID
     * @returns {string} - Download ID
     */
    generateDownloadId() {
        return `dl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}

module.exports = QueueManager;
