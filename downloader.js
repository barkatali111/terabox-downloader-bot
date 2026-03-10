/**
 * Advanced Parallel Downloader
 * Implements multi-threaded chunk downloading with streaming capabilities
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const crypto = require('crypto');
const axios = require('axios');
const config = require('./config');
const EventEmitter = require('events');

class ParallelDownloader extends EventEmitter {
    constructor() {
        super();
        this.downloads = new Map(); // Track active downloads
        this.tempDir = config.download.tempDir;
        
        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    /**
     * Main download method - orchestrates parallel chunk downloading
     * @param {string} url - Download URL
     * @param {object} fileInfo - File information
     * @param {string} userId - User ID for tracking
     * @returns {Promise<string>} - Path to downloaded file
     */
    async downloadFile(url, fileInfo, userId) {
        const downloadId = this.generateDownloadId(userId, fileInfo.fileName);
        const filePath = path.join(this.tempDir, `${downloadId}_${fileInfo.fileName}`);
        
        // Check if file already exists
        if (fs.existsSync(filePath)) {
            return filePath;
        }

        try {
            // Get file size if not provided
            let fileSize = fileInfo.fileSize;
            if (!fileSize || fileSize === 0) {
                fileSize = await this.getFileSize(url);
            }

            // For small files, download directly
            if (fileSize < config.download.chunkSize) {
                return await this.downloadSingleThread(url, filePath, fileInfo);
            }

            // For large files, use parallel chunks
            return await this.downloadParallel(url, filePath, fileSize, fileInfo, userId, downloadId);

        } catch (error) {
            this.cleanup(filePath);
            throw error;
        }
    }

    /**
     * Get file size from server
     * @param {string} url - Download URL
     * @returns {Promise<number>} - File size in bytes
     */
    async getFileSize(url) {
        try {
            const response = await axios.head(url, {
                headers: {
                    'User-Agent': config.userAgent
                },
                timeout: 5000
            });
            
            return parseInt(response.headers['content-length'] || 0);
        } catch (error) {
            console.error('Error getting file size:', error.message);
            return 0;
        }
    }

    /**
     * Single-thread download for small files
     * @param {string} url - Download URL
     * @param {string} filePath - Output file path
     * @param {object} fileInfo - File information
     * @returns {Promise<string>} - File path
     */
    async downloadSingleThread(url, filePath, fileInfo) {
        this.emit('progress', { percent: 0, status: 'Starting download...' });

        const writer = fs.createWriteStream(filePath);
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            headers: {
                'User-Agent': config.userAgent
            },
            timeout: 300000 // 5 minutes timeout
        });

        const totalLength = parseInt(response.headers['content-length'] || 0);
        let downloadedLength = 0;

        response.data.on('data', (chunk) => {
            downloadedLength += chunk.length;
            if (totalLength > 0) {
                const percent = Math.round((downloadedLength / totalLength) * 100);
                this.emit('progress', { 
                    percent, 
                    status: `Downloading: ${percent}%`,
                    downloaded: downloadedLength,
                    total: totalLength
                });
            }
        });

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                this.emit('progress', { percent: 100, status: 'Download complete' });
                resolve(filePath);
            });
            
            writer.on('error', reject);
            response.data.pipe(writer);
        });
    }

    /**
     * Parallel chunk download for large files
     * @param {string} url - Download URL
     * @param {string} filePath - Output file path
     * @param {number} fileSize - Total file size
     * @param {object} fileInfo - File information
     * @param {string} userId - User ID
     * @param {string} downloadId - Download ID
     * @returns {Promise<string>} - File path
     */
    async downloadParallel(url, filePath, fileSize, fileInfo, userId, downloadId) {
        const chunkSize = config.download.chunkSize;
        const numChunks = Math.ceil(fileSize / chunkSize);
        const maxWorkers = Math.min(config.download.maxConcurrentWorkers, numChunks);
        
        this.emit('progress', { 
            percent: 0, 
            status: `Preparing parallel download (${numChunks} chunks)...` 
        });

        // Create chunks directory
        const chunksDir = path.join(this.tempDir, `${downloadId}_chunks`);
        if (!fs.existsSync(chunksDir)) {
            fs.mkdirSync(chunksDir, { recursive: true });
        }

        // Track chunk completion
        const chunkStatus = new Array(numChunks).fill(false);
        let completedChunks = 0;

        // Create workers for parallel downloading
        const workers = [];
        const chunkPromises = [];

        for (let i = 0; i < numChunks; i++) {
            const start = i * chunkSize;
            const end = i === numChunks - 1 ? fileSize - 1 : (i + 1) * chunkSize - 1;
            
            const chunkPath = path.join(chunksDir, `chunk_${i}`);
            
            const workerPromise = this.runChunkWorker(url, chunkPath, start, end, i)
                .then(() => {
                    completedChunks++;
                    chunkStatus[i] = true;
                    
                    const percent = Math.round((completedChunks / numChunks) * 100);
                    this.emit('progress', { 
                        percent, 
                        status: `Downloading: ${percent}% (Chunk ${i + 1}/${numChunks})`,
                        downloaded: (completedChunks * chunkSize),
                        total: fileSize
                    });
                });

            chunkPromises.push(workerPromise);

            // Limit concurrent workers
            if (chunkPromises.length >= maxWorkers || i === numChunks - 1) {
                await Promise.race(chunkPromises);
                // Remove completed promises
                while (chunkPromises.length > 0 && chunkPromises[0].isResolved) {
                    chunkPromises.shift();
                }
            }
        }

        // Wait for all chunks to complete
        await Promise.all(chunkPromises);

        // Merge chunks
        this.emit('progress', { percent: 99, status: 'Merging chunks...' });
        await this.mergeChunks(chunksDir, filePath, numChunks);

        // Cleanup chunks directory
        fs.rmSync(chunksDir, { recursive: true, force: true });

        return filePath;
    }

    /**
     * Run worker thread for chunk download
     * @param {string} url - Download URL
     * @param {string} chunkPath - Path to save chunk
     * @param {number} start - Start byte
     * @param {number} end - End byte
     * @param {number} chunkIndex - Chunk index
     * @returns {Promise<void>}
     */
    runChunkWorker(url, chunkPath, start, end, chunkIndex) {
        return new Promise((resolve, reject) => {
            const worker = new Worker(`
                const { parentPort } = require('worker_threads');
                const axios = require('axios');
                const fs = require('fs');

                async function downloadChunk() {
                    try {
                        const response = await axios({
                            method: 'GET',
                            url: '${url}',
                            headers: {
                                'User-Agent': '${config.userAgent}',
                                'Range': 'bytes=${start}-${end}'
                            },
                            responseType: 'stream',
                            timeout: 300000
                        });

                        const writer = fs.createWriteStream('${chunkPath}');
                        
                        return new Promise((resolve, reject) => {
                            writer.on('finish', resolve);
                            writer.on('error', reject);
                            response.data.pipe(writer);
                        });
                    } catch (error) {
                        throw error;
                    }
                }

                downloadChunk()
                    .then(() => parentPort.postMessage('done'))
                    .catch(error => parentPort.postMessage({ error: error.message }));
            `, { eval: true });

            worker.on('message', (message) => {
                if (message.error) {
                    reject(new Error(message.error));
                } else {
                    resolve();
                }
            });

            worker.on('error', reject);
            worker.on('exit', (code) => {
                if (code !== 0) {
                    reject(new Error(`Worker stopped with exit code ${code}`));
                }
            });
        });
    }

    /**
     * Merge downloaded chunks into single file
     * @param {string} chunksDir - Directory containing chunks
     * @param {string} outputPath - Output file path
     * @param {number} numChunks - Number of chunks
     * @returns {Promise<void>}
     */
    async mergeChunks(chunksDir, outputPath, numChunks) {
        const writeStream = fs.createWriteStream(outputPath);
        
        for (let i = 0; i < numChunks; i++) {
            const chunkPath = path.join(chunksDir, `chunk_${i}`);
            const chunkData = await fs.promises.readFile(chunkPath);
            writeStream.write(chunkData);
        }

        return new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            writeStream.end();
        });
    }

    /**
     * Generate unique download ID
     * @param {string} userId - User ID
     * @param {string} fileName - File name
     * @returns {string} - Unique ID
     */
    generateDownloadId(userId, fileName) {
        const hash = crypto.createHash('md5')
            .update(`${userId}-${fileName}-${Date.now()}`)
            .digest('hex')
            .substring(0, 8);
        return hash;
    }

    /**
     * Clean up temporary files
     * @param {string} filePath - Path to file
     */
    cleanup(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (error) {
            console.error('Cleanup error:', error.message);
        }
    }
}

module.exports = ParallelDownloader;
