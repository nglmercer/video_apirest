require('dotenv').config(); // Cargar variables de entorno al inicio
const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer'); // Para manejar subida de archivos
const fs = require('fs'); // Usar fs normal, no promesas por ahora
const b2 = require('./back.js'); // Importar módulo de Backblaze B2
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
// app.use('/upload', uploadRoutes); // Comentado - Usando /upload/b2 ahora
// app.use('/videos', videoRoutes); // Comentado - Usando /videos/b2 ahora

// --- Configuración de Multer para subida en memoria ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- Ruta para subir archivos a Backblaze B2 ---
app.post('/upload/b2', upload.single('video'), async (req, res, next) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    // Guardar temporalmente el buffer en un archivo para b2.uploadFile
    const tempDir = path.join(__dirname, 'temp_uploads');
    const tempFilePath = path.join(tempDir, req.file.originalname);

    try {
        // Asegurarse que el directorio temporal existe
        if (!fs.existsSync(tempDir)){
            fs.mkdirSync(tempDir);
        }
        // Escribir el buffer al archivo temporal
        fs.writeFileSync(tempFilePath, req.file.buffer);

        console.log(`Archivo temporal creado en: ${tempFilePath}`);

        // Subir a B2 usando la función refactorizada
        const bucketId = process.env.B2_BUCKET_ID;
        const fileName = req.file.originalname; // Usar el nombre original

        const uploadResult = await b2.uploadFile(bucketId, fileName, tempFilePath);

        // Eliminar el archivo temporal después de subirlo
        fs.unlinkSync(tempFilePath);
        console.log(`Archivo temporal eliminado: ${tempFilePath}`);


        if (uploadResult) {
            // Construir la URL de descarga (simplificada, puede necesitar ajustes)
            const downloadUrl = `${b2.getDownloadUrl()}/file/${process.env.B2_BUCKET_NAME}/${encodeURIComponent(fileName)}`;
            res.status(200).json({
                message: 'File uploaded successfully to B2!',
                fileInfo: uploadResult,
                downloadUrl: downloadUrl
            });
        } else {
            res.status(500).send('Failed to upload file to B2.');
        }
    } catch (error) {
         // Asegurarse de eliminar el archivo temporal incluso si hay error
        if (fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
                console.log(`Archivo temporal eliminado tras error: ${tempFilePath}`);
            } catch (unlinkError) {
                console.error("Error eliminando archivo temporal tras error:", unlinkError);
            }
        }
        console.error('Error during B2 upload:', error);
        next(error); // Pasar el error al manejador de errores global
    }
});

// --- Ruta para listar archivos/videos desde Backblaze B2 ---
app.get('/videos/b2', async (req, res, next) => {
    try {
        const bucketId = process.env.B2_BUCKET_ID;
        const listResult = await b2.listFiles(bucketId);

        if (listResult && listResult.files) {
            // Mapear los resultados para incluir la URL de descarga directa
            const filesWithUrls = listResult.files.map(file => ({
                ...file,
                downloadUrl: `${b2.getDownloadUrl()}/file/${process.env.B2_BUCKET_NAME}/${encodeURIComponent(file.fileName)}`
            }));

            res.status(200).json({
                files: filesWithUrls,
                nextFileName: listResult.nextFileName // Para paginación futura
            });
        } else {
            res.status(500).send('Failed to list files from B2.');
        }
    } catch (error) {
        console.error('Error listing B2 files:', error);
        next(error);
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

        // 2. Asegurar directorios (si aún son necesarios para otras funciones)
        // await ensureDirExists(VIDEOS_DIR); // Comentado si solo usamos B2
        // await ensureDirExists(PROCESSED_DIR_ROOT); // Comentado si solo usamos B2
        // Asegurar directorio temporal para subidas
        const tempDir = path.join(__dirname, 'temp_uploads');
         if (!fs.existsSync(tempDir)){
            fs.mkdirSync(tempDir);
            console.log(`Created temporary upload directory: ${tempDir}`);
        }


        // 3. Iniciar el servidor Express
        app.listen(PORT, () => {
            console.log(`Server listening on port ${PORT}`);
            console.log(`Frontend example: http://localhost:${PORT}/`);
            console.log(`B2 Upload endpoint: POST http://localhost:${PORT}/upload/b2 (form-data field: 'videoFile')`);
            console.log(`B2 List Videos endpoint: GET http://localhost:${PORT}/videos/b2`);
            // console.log(`Access processed videos base URL: http://localhost:${PORT}/processed/`); // Comentado
        });
    } catch (error) {
        console.error("Failed to start server or authorize B2:", error);
        process.exit(1);
    }
};

startServer();
