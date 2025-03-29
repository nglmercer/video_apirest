const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path'); // Import path module
const { ensureDirExists } = require('../utils/hls'); // Only import ensureDirExists

// Define PROCESSED_DIR relative to the project root (assuming routes is one level down)
const PROCESSED_DIR_ROOT = path.join(__dirname, '..', 'processed_videos');

// --- GET /videos Route ---
router.get('/', async (req, res) => {
    try {
        await ensureDirExists(PROCESSED_DIR_ROOT); // Use the locally defined root path
        const videoDirs = await fs.readdir(PROCESSED_DIR_ROOT, { withFileTypes: true }); // Use the locally defined root path
        const videos = videoDirs
            .filter(dirent => dirent.isDirectory())
            .map(dirent => ({
                id: dirent.name,
                masterPlaylistUrl: `/processed/${dirent.name}/master.m3u8` // Relative URL
            }));
        res.json(videos);
    } catch (error) {
        console.error('Error listing processed videos:', error);
        if (error.code === 'ENOENT') {
            // If PROCESSED_DIR doesn't exist yet (no videos processed)
            return res.json([]);
        }
        res.status(500).json({ error: 'Failed to list processed videos.' });
    }
});

module.exports = router;
