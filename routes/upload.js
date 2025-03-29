const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const { ensureDirExists, convertToHls, VIDEOS_DIR } = require('../utils/hls'); // Import from utils

// --- Multer Setup for Video Upload ---
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        await ensureDirExists(VIDEOS_DIR); // Use helper from utils
        cb(null, VIDEOS_DIR);
    },
    filename: (req, file, cb) => {
        const safeFilename = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        cb(null, Date.now() + '-' + safeFilename);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 1024 * 1024 * 500 }, // 500MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only video files are allowed.'), false);
        }
    }
}).single('video');

// --- POST /upload Route ---
router.post('/', (req, res) => {
    upload(req, res, async (err) => {
        if (err instanceof multer.MulterError) {
            console.error('Multer error:', err);
            return res.status(400).json({ error: `Upload error: ${err.message}` });
        } else if (err) {
            console.error('Unknown upload error:', err);
            return res.status(500).json({ error: `Upload error: ${err.message}` });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No video file uploaded.' });
        }

        const videoPath = req.file.path;
        const videoId = path.basename(videoPath, path.extname(videoPath));

        console.log(`Video uploaded successfully: ${videoPath}`);
        res.status(202).json({
            message: 'Video uploaded successfully. Processing started.',
            videoId: videoId,
            originalFilename: req.file.originalname,
        });

        // Start HLS conversion asynchronously
        convertToHls(videoPath, videoId)
            .then(result => {
                console.log(`[${videoId}] HLS processing completed successfully.`);
                // Optionally delete original:
                // require('fs').promises.unlink(videoPath).catch(e => console.error(`Error deleting original file ${videoPath}:`, e));
            })
            .catch(error => {
                console.error(`[${videoId}] HLS processing failed:`, error);
            });
    });
});

module.exports = router;
