require('dotenv').config(); // Cargar variables de entorno al inicio
const express = require('express');
const path = require('path');
const cors = require('cors');
// Multer ya no se configura globalmente aquí, se maneja en cada router
const fs = require('fs'); // Usar fs normal
const b2 = require('./back.js'); // Importar módulo de Backblaze B2 (para autorización inicial)
const morgan = require('morgan'); // Import morgan
const ffmpeg = require('fluent-ffmpeg'); // Still needed for ffprobe in utils/hls
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const axios = require("axios")
// Import utils and routes
const { ensureDirExists, VIDEOS_DIR_ROOT } = require('./utils/hls'); // VIDEOS_DIR_ROOT para asegurar directorio
const uploadRoutes = require('./routes/upload'); // Ruta para subida local y conversión HLS
const videoRoutes = require('./routes/videos'); // Ruta para listar videos HLS locales
const b2Routes = require('./routes/b2.js'); // Nuevas rutas para Backblaze B2
const b2get = require('./routes/b2get.js'); // Importar módulo de Backblaze B2 (para autorización inicial)

// Set ffmpeg path (needs to be done once)
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

// --- Define Root Paths ---
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROCESSED_DIR_ROOT = path.join(__dirname, 'processed_videos'); // Path relative to index.js (root)

// --- Middleware ---
app.use(cors({ origin: '*' })); // Allow all origins (adjust for production)
app.use(morgan('dev')); // Add HTTP request logging ('dev' format is concise)

// Serve static files
app.use(express.static(PUBLIC_DIR)); // Serve frontend examples from public/
app.use('/processed', express.static(PROCESSED_DIR_ROOT)); // Servir videos HLS procesados localmente

// --- API Routes ---
app.use('/upload', uploadRoutes);   // Ruta para subida local y conversión HLS
app.use('/videos', videoRoutes);   // Ruta para listar videos HLS locales
app.use('/b2', b2Routes);          // Rutas para interactuar con Backblaze B2 (/b2/upload, /b2/videos)
app.use('/b2', b2get);          // Rutas para interactuar con Backblaze B2 (/b2/upload, /b2/videos)

app.get('/stream-resource/:videoId/:resourcePath(*)', async (req, res) => {
    const { videoId, resourcePath } = req.params;
    const backblazeBaseUrl = 'https://f005.backblazeb2.com/file/cloud-video-store/';
    const token = await b2.getAuthToken();
    const resourceUrl = `${backblazeBaseUrl}${videoId}/${resourcePath}?Authorization=`+token; // Ejemplo: "video123/480p/playlist.m3u8"
    console.log("resourceUrl",resourceUrl)
    try {
      const response = await axios.get(resourceUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        responseType: 'stream', // Para manejar .ts y otros flujos
      });
  
      const contentType = resourceUrl.endsWith('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : 'video/mp2t'; // Para .ts
      res.setHeader('Content-Type', contentType);
      response.data.pipe(res);
    } catch (error) {
      console.error(`Error fetching resource ${resourceUrl}:`, error);
      res.status(500).send('Error al procesar el recurso');
    }
  });
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
        // 1. Autorizar con Backblaze B2
        console.log("Attempting Backblaze B2 authorization...");
        const authSuccess = await b2.authorizeAccount();
        if (!authSuccess) {
            console.error("Backblaze B2 authorization failed. Server cannot start.");
            process.exit(1); // Salir si la autorización falla
        }
        console.log("Backblaze B2 authorization successful.");
        console.log("videosDir",VIDEOS_DIR_ROOT,"processedDirRoot",PROCESSED_DIR_ROOT)
        // 2. Asegurar directorios necesarios al inicio
        await ensureDirExists(VIDEOS_DIR_ROOT); // Directorio para videos originales subidos localmente
        await ensureDirExists(PROCESSED_DIR_ROOT); // Directorio para videos HLS procesados
        const tempDir = path.join(__dirname, 'temp_uploads'); // Directorio temporal para subidas a B2
         if (!fs.existsSync(tempDir)){
            fs.mkdirSync(tempDir, { recursive: true });
            console.log(`Created temporary upload directory: ${tempDir}`);
        }


        // 3. Iniciar el servidor Express
        app.listen(PORT, () => {
            console.log(`Server listening on port ${PORT}`);
            console.log(`Frontend example: http://localhost:${PORT}/`);
            console.log(`Local Upload & HLS endpoint: POST http://localhost:${PORT}/upload (form-data field: 'video')`);
            console.log(`List Local HLS Videos endpoint: GET http://localhost:${PORT}/videos`);
            console.log(`Access processed HLS videos base URL: http://localhost:${PORT}/processed/`);
            console.log(`B2 Direct Upload endpoint: POST http://localhost:${PORT}/b2/upload (form-data field: 'videoFile')`);
            console.log(`B2 HLS Upload endpoint: POST http://localhost:${PORT}/b2/upload-hls (form-data field: 'videoFile')`);
            console.log(`B2 List Videos endpoint: GET http://localhost:${PORT}/b2/videos`);
        });
    } catch (error) {
        console.error("Failed to start server or authorize B2:", error);
        process.exit(1);
    }
};

startServer();
