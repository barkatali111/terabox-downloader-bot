/**
 * TeraBox Link Extractor
 * Handles extraction of file metadata and direct download URLs from TeraBox share links
 * No external APIs used - pure HTML parsing
 */

const axios = require('axios');
const cheerio = require('cheerio');
const config = require('./config');

class TeraBoxExtractor {
    constructor() {
        this.headers = {
            'User-Agent': config.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Connection': 'keep-alive',
        };
    }

    /**
     * Validate if URL is a valid TeraBox link
     * @param {string} url - The URL to validate
     * @returns {boolean} - True if valid TeraBox link
     */
    isValidTeraBoxLink(url) {
        try {
            const urlObj = new URL(url);
            return config.teraboxDomains.some(domain => urlObj.hostname.includes(domain));
        } catch (error) {
            return false;
        }
    }

    /**
     * Extract share ID and shortcode from URL
     * @param {string} url - TeraBox share URL
     * @returns {object} - Extracted parameters
     */
    extractUrlParams(url) {
        const patterns = [
            /\/s\/([a-zA-Z0-9_-]+)/,  // Standard /s/ format
            /\/sharing\/([a-zA-Z0-9_-]+)/, // Sharing format
            /[?&]surl=([a-zA-Z0-9_-]+)/ // Parameter format
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                return { shortcode: match[1] };
            }
        }
        
        throw new Error('Could not extract share ID from URL');
    }

    /**
     * Fetch and parse TeraBox share page
     * @param {string} url - TeraBox share URL
     * @returns {Promise<object>} - File metadata and download info
     */
    async extractFileInfo(url) {
        try {
            // Validate URL first
            if (!this.isValidTeraBoxLink(url)) {
                throw new Error('Invalid TeraBox link');
            }

            // Extract URL parameters
            const { shortcode } = this.extractUrlParams(url);
            
            // Fetch the share page
            const response = await axios.get(url, {
                headers: this.headers,
                timeout: 10000
            });

            // Parse HTML with cheerio
            const $ = cheerio.load(response.data);
            
            // Method 1: Look for window.DATA or window.yunData
            let fileData = this.extractFromScripts($, response.data);
            
            // Method 2: Look for embedded JSON-LD
            if (!fileData) {
                fileData = this.extractFromJSONLD($);
            }
            
            // Method 3: Parse from HTML attributes
            if (!fileData) {
                fileData = this.extractFromHTML($);
            }

            if (!fileData) {
                throw new Error('Could not extract file information from page');
            }

            // Generate direct download URL
            const downloadUrl = await this.generateDownloadUrl(fileData, shortcode);
            
            return {
                fileName: fileData.fileName || fileData.filename || 'unknown.bin',
                fileSize: parseInt(fileData.fileSize || fileData.size || 0),
                downloadUrl: downloadUrl,
                mimeType: fileData.mimeType || this.getMimeType(fileData.fileName),
                shortcode: shortcode
            };
            
        } catch (error) {
            console.error('Extraction error:', error.message);
            throw new Error(`Failed to extract file info: ${error.message}`);
        }
    }

    /**
     * Extract data from script tags containing JSON
     * @param {object} $ - Cheerio object
     * @param {string} html - Raw HTML
     * @returns {object|null} - Extracted file data
     */
    extractFromScripts($, html) {
        // Look for window.DATA pattern
        const dataMatch = html.match(/window\.DATA\s*=\s*({[^;]+})/);
        if (dataMatch) {
            try {
                const data = JSON.parse(dataMatch[1]);
                if (data.fileInfo || data.info) {
                    return data.fileInfo || data.info;
                }
            } catch (e) {
                // Ignore parse errors
            }
        }

        // Look for window.yunData
        const yunMatch = html.match(/window\.yunData\s*=\s*({[^;]+})/);
        if (yunMatch) {
            try {
                return JSON.parse(yunMatch[1]);
            } catch (e) {
                // Ignore parse errors
            }
        }

        // Search all script tags for JSON data
        const scripts = $('script');
        for (let i = 0; i < scripts.length; i++) {
            const scriptContent = $(scripts[i]).html();
            if (scriptContent && scriptContent.includes('file')) {
                const jsonMatch = scriptContent.match(/({.*"file".*})/);
                if (jsonMatch) {
                    try {
                        return JSON.parse(jsonMatch[1]);
                    } catch (e) {
                        // Continue if parse fails
                    }
                }
            }
        }
        
        return null;
    }

    /**
     * Extract from JSON-LD structured data
     * @param {object} $ - Cheerio object
     * @returns {object|null} - Extracted file data
     */
    extractFromJSONLD($) {
        const jsonld = $('script[type="application/ld+json"]').first();
        if (jsonld.length) {
            try {
                const data = JSON.parse(jsonld.html());
                if (data.name && data.contentUrl) {
                    return {
                        fileName: data.name,
                        fileSize: data.contentSize,
                        downloadUrl: data.contentUrl
                    };
                }
            } catch (e) {
                // Ignore parse errors
            }
        }
        return null;
    }

    /**
     * Extract from HTML meta tags and attributes
     * @param {object} $ - Cheerio object
     * @returns {object|null} - Extracted file data
     */
    extractFromHTML($) {
        const fileData = {};
        
        // Look for meta tags
        $('meta').each((i, elem) => {
            const name = $(elem).attr('name') || $(elem).attr('property');
            const content = $(elem).attr('content');
            
            if (name && content) {
                if (name.includes('filename') || name.includes('title')) {
                    fileData.fileName = content;
                }
                if (name.includes('filesize') || name.includes('size')) {
                    fileData.fileSize = content;
                }
            }
        });

        // Look for data attributes in body
        const bodyHtml = $('body').html() || '';
        const sizeMatch = bodyHtml.match(/data-size=["'](\d+)["']/);
        if (sizeMatch) {
            fileData.fileSize = sizeMatch[1];
        }

        return Object.keys(fileData).length ? fileData : null;
    }

    /**
     * Generate direct download URL from extracted data
     * @param {object} fileData - Extracted file data
     * @param {string} shortcode - Share shortcode
     * @returns {Promise<string>} - Direct download URL
     */
    async generateDownloadUrl(fileData, shortcode) {
        // If download URL already exists, use it
        if (fileData.downloadUrl || fileData.url) {
            return fileData.downloadUrl || fileData.url;
        }

        // Try to construct from file ID
        if (fileData.fs_id || fileData.fileId) {
            const fileId = fileData.fs_id || fileData.fileId;
            const timestamp = Date.now();
            
            // Construct common TeraBox download URL patterns
            const patterns = [
                `https://www.terabox.com/api/download?fileId=${fileId}&shortcode=${shortcode}&_=${timestamp}`,
                `https://www.terabox.com/share/download?fileId=${fileId}&shortcode=${shortcode}`,
                `https://www.terabox.com/api/content/download?fileId=${fileId}&shortcode=${shortcode}`
            ];
            
            // Test which pattern works
            for (const pattern of patterns) {
                try {
                    const response = await axios.head(pattern, {
                        headers: this.headers,
                        timeout: 5000,
                        maxRedirects: 0,
                        validateStatus: (status) => status < 400 || status === 302
                    });
                    
                    if (response.status === 200 || response.status === 302) {
                        return pattern;
                    }
                } catch (e) {
                    // Ignore errors and try next pattern
                }
            }
        }

        throw new Error('Could not generate download URL');
    }

    /**
     * Get MIME type from filename
     * @param {string} filename - File name
     * @returns {string} - MIME type
     */
    getMimeType(filename) {
        const extension = filename.split('.').pop().toLowerCase();
        const mimeTypes = {
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'mp4': 'video/mp4',
            'mp3': 'audio/mpeg',
            'pdf': 'application/pdf',
            'zip': 'application/zip',
            'txt': 'text/plain'
        };
        return mimeTypes[extension] || 'application/octet-stream';
    }
}

module.exports = TeraBoxExtractor;
