const express = require('express');
const path = require('path');
const cors = require('cors');
const morgan = require('morgan'); // Import morgan
const ffmpeg = require('fluent-ffmpeg'); // Still needed for ffprobe in utils
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

// Import utils and routes
// Import VIDEOS_DIR from utils (now correctly relative to root)
// PROCESSED_DIR will be defined locally in index.js for static serving
const { ensureDirExists, VIDEOS_DIR } = require('./utils/hls');
const uploadRoutes = require('./routes/upload');
const videoRoutes = require('./routes/videos');

// Set ffmpeg path (needs to be done once)
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 4200;

// --- Define Root Paths ---
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROCESSED_DIR_ROOT = path.join(__dirname, 'processed_videos'); // Path relative to index.js (root)

// --- Middleware ---
app.use(cors({ origin: '*' })); // Allow all origins (adjust for production)
app.use(morgan('dev')); // Add HTTP request logging ('dev' format is concise)

// Serve static files
app.use(express.static(PUBLIC_DIR)); // Serve frontend examples from public/
app.use('/processed', express.static(PROCESSED_DIR_ROOT)); // Serve processed HLS videos from processed_videos/

// --- API Routes ---
app.use('/upload', uploadRoutes);
app.use('/videos', videoRoutes);

// --- Basic Root Route (Optional) ---
app.get('/', (req, res) => {
    // Send the index.html from the public directory
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- Error Handling Middleware ---
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err.stack || err);
    res.status(err.status || 500).json({
        error: {
            message: err.message || 'Something broke!',
            // Optionally include stack trace in development
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        }
    });
});

// --- Start Server ---
const startServer = async () => {
    try {
        // Ensure necessary directories exist on startup using paths relative to root
        await ensureDirExists(VIDEOS_DIR); // VIDEOS_DIR from utils is already root-relative
        await ensureDirExists(PROCESSED_DIR_ROOT); // Use the root-relative path defined here

        app.listen(PORT, () => {
            console.log(`Server listening on port ${PORT}`);
            console.log(`Frontend example: http://localhost:${PORT}/`);
            console.log(`Upload endpoint: http://localhost:${PORT}/upload`);
            console.log(`List videos endpoint: http://localhost:${PORT}/videos`);
            console.log(`Access processed videos base URL: http://localhost:${PORT}/processed/`);
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
};

startServer();
