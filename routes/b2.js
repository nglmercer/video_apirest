const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer'); // Para manejar subida de archivos
const fs = require('fs'); // Usar fs normal para sync ops
const fsPromises = require('fs').promises; // Usar promesas para async ops
const b2 = require('../back.js'); // Importar módulo de Backblaze B2
const { ensureDirExists, convertToHls } = require('../utils/hls'); // Importar funciones HLS

// --- Constantes de Directorios ---
// Usar path.resolve para asegurar rutas absolutas desde la raíz del proyecto
const TEMP_UPLOAD_DIR = path.resolve(__dirname, '..', 'temp_uploads');
const PROCESSED_DIR_ROOT = path.resolve(__dirname, '..', 'processed_videos');

// --- Configuración de Multer para subida directa a B2 (en memoria) ---
const storageDirectB2 = multer.memoryStorage();
const uploadDirectB2 = multer({ storage: storageDirectB2 });

// --- Configuración de Multer para subida local temporal (para conversión HLS) ---
const storageTempLocal = multer.diskStorage({
    destination: async (req, file, cb) => {
        // Asegurar que el directorio temporal existe
        if (!fs.existsSync(TEMP_UPLOAD_DIR)){
            fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
        }
        cb(null, TEMP_UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        // Usar un nombre temporal único para evitar colisiones
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        cb(null, uniqueSuffix + '-' + safeOriginalName);
    }
});
const uploadTempLocal = multer({
    storage: storageTempLocal,
    limits: { fileSize: 1024 * 1024 * 500 }, // 500MB limit (ajustar si es necesario)
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only video files are allowed.'), false);
        }
    }
}).single('video'); // Usar el mismo nombre de campo 'video'

// --- Ruta para subir archivos DIRECTAMENTE a Backblaze B2 ---
// POST /b2/upload
router.post('/upload', uploadDirectB2.single('video'), async (req, res, next) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    // El archivo está en req.file.buffer (Multer en memoria)
    const tempFilePath = path.join(TEMP_UPLOAD_DIR, `direct-upload-${Date.now()}-${req.file.originalname}`);

    try {
        // Escribir el buffer al archivo temporal para que b2.uploadFile lo lea
        fs.writeFileSync(tempFilePath, req.file.buffer);
        console.log(`[B2 Direct Upload] Archivo temporal creado en: ${tempFilePath}`);

        // Subir a B2 usando la función refactorizada
        const bucketId = process.env.B2_BUCKET_ID;
        const fileName = req.file.originalname; // Usar el nombre original para la subida y el registro

        // uploadFile ahora registra automáticamente el historial
        const uploadResult = await b2.uploadFile(bucketId, fileName, tempFilePath);

        // Eliminar el archivo temporal después de subirlo
        fs.unlinkSync(tempFilePath);
        console.log(`[B2 Direct Upload] Archivo temporal eliminado: ${tempFilePath}`);

        // Obtener el historial de esta subida específica
        const uploadHistory = b2.getUploadHistory(fileName);

        if (uploadResult) {
            // Construir la URL de descarga
            const downloadUrl = `${b2.getDownloadUrl()}/file/${process.env.B2_BUCKET_NAME}/${encodeURIComponent(fileName)}`;
            res.status(200).json({
                message: 'File uploaded successfully to B2!',
                fileInfo: uploadResult,
                downloadUrl: downloadUrl,
                uploadHistory: uploadHistory // Incluir historial
            });
        } else {
             res.status(500).json({
                message: 'Failed to upload file to B2.',
                uploadHistory: uploadHistory // Incluir historial incluso en fallo
            });
        }
    } catch (error) {
         // Asegurarse de eliminar el archivo temporal incluso si hay error
        if (fs.existsSync(tempFilePath)) {
            try {
                fs.unlinkSync(tempFilePath);
                console.log(`[B2 Direct Upload] Archivo temporal eliminado tras error: ${tempFilePath}`);
            } catch (unlinkError) {
                console.error("[B2 Direct Upload] Error eliminando archivo temporal tras error:", unlinkError);
            }
        }
        console.error('[B2 Direct Upload] Error during B2 direct upload:', error);
        next(error); // Pasar el error al manejador de errores global
    }
});



// --- Ruta para subir video, convertir a HLS y subir HLS a B2 ---
// POST /b2/upload-hls
router.post('/upload-hls', (req, res, next) => {
    // Usar uploadTempLocal que guarda en disco temporalmente
    uploadTempLocal(req, res, async (err) => {
        if (err) {
            console.error('[B2 HLS Upload] Multer or Filter error:', err.message);
            // Asegurarse que el campo sea 'video' como se definió en multer
            if (err.code === 'LIMIT_UNEXPECTED_FILE' && err.field !== 'video') {
                 return res.status(400).json({ error: `Upload error: Unexpected field '${err.field}'. Expected 'video'.` });
            }
            return res.status(400).json({ error: `Upload error: ${err.message}` });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'No video file uploaded (expected field: video).' });
        }

        const originalTempPath = req.file.path; // Ruta al video original temporal
        const videoId = path.basename(originalTempPath, path.extname(originalTempPath));
        const basePath = req.body.basePath ? req.body.basePath.trim().replace(/^\/|\/$/g, '') : ''; // Limpiar slashes
        console.log(`[B2 HLS Upload] Base path: ${basePath}`);
        const finalB2Prefix = basePath ? `${basePath}/${videoId}` : videoId; // Construir prefijo final en B2
        
        const hlsLocalOutputDir = path.join(PROCESSED_DIR_ROOT, videoId); // Directorio donde convertToHls guardará los archivos

        console.log(`[B2 HLS Upload] Video temporal recibido: ${originalTempPath}`);
        console.log(`[B2 HLS Upload] Iniciando conversión HLS para videoId: ${videoId}`);

        try {
            // 1. Convertir a HLS localmente
            // 1. Convertir a HLS localmente
            // Asegúrate de que convertToHls no necesite el token si no lo usa internamente
            await convertToHls(originalTempPath, { videoId, basePath: basePath });
            console.log(`[B2 HLS Upload] Conversión HLS completada para videoId: ${videoId}. Archivos en: ${hlsLocalOutputDir}`);

            // 2. Subir el directorio HLS completo a B2 usando la nueva función
            const bucketId = process.env.B2_BUCKET_ID;
            const b2Prefix = videoId; // Usar videoId como prefijo en B2
            /*            res.status(200).json({
                message: 'HLS conversion and upload to B2 completed successfully.',
                videoId: videoId,
                b2Prefix: finalB2Prefix,
            });*/
            const uploadDirResult = await b2.uploadDirectoryToB2(bucketId, hlsLocalOutputDir, finalB2Prefix);

            // 3. Limpieza local (independientemente del éxito de la subida a B2)
            try {
                await fsPromises.unlink(originalTempPath);
                console.log(`[B2 HLS Upload] Archivo original temporal eliminado: ${originalTempPath}`);
                await fsPromises.rm(hlsLocalOutputDir, { recursive: true, force: true });
                console.log(`[B2 HLS Upload] Directorio HLS local eliminado: ${hlsLocalOutputDir}`);
            } catch (cleanupError) {
                console.error(`[B2 HLS Upload] Error durante la limpieza local:`, cleanupError);
            }

            // 4. Responder al cliente
            const mainManifestB2Path = `${finalB2Prefix}/master.m3u8`; // Usar el prefijo
            const mainManifestUrl = `${b2.getDownloadUrl()}/file/${process.env.B2_BUCKET_NAME}/${encodeURIComponent(mainManifestB2Path)}`;

            if (!uploadDirResult.success) {
                 res.status(207).json({ // Multi-Status
                    message: `HLS conversion complete. ${uploadDirResult.successfulUploads.length} files uploaded to B2, ${uploadDirResult.failedUploads.length} failed.`,
                    videoId: videoId,
                    b2Prefix: finalB2Prefix + '/',
                    mainManifestUrl: mainManifestUrl,
                    uploadHistory: uploadDirResult.history // Incluir historial agrupado
                });
            } else {
                 res.status(200).json({
                    message: 'HLS conversion and upload to B2 completed successfully.',
                    videoId: videoId,
                    b2Prefix: finalB2Prefix + '/',
                    mainManifestUrl: mainManifestUrl,
                    uploadHistory: uploadDirResult.history // Incluir historial agrupado
                });
            }

        } catch (error) {
            console.error(`[B2 HLS Upload] Error en el proceso HLS o subida a B2 para videoId: ${videoId}`, error);
            // Intentar limpieza incluso si falla la conversión o subida
             try {
                if (fs.existsSync(originalTempPath)) {
                    await fsPromises.unlink(originalTempPath);
                    console.log(`[B2 HLS Upload] Archivo original temporal eliminado tras error: ${originalTempPath}`);
                }
                if (fs.existsSync(hlsLocalOutputDir)) {
                    await fsPromises.rm(hlsLocalOutputDir, { recursive: true, force: true });
                    console.log(`[B2 HLS Upload] Directorio HLS local eliminado tras error: ${hlsLocalOutputDir}`);
                }
            } catch (cleanupError) {
                console.error(`[B2 HLS Upload] Error durante la limpieza local tras error principal:`, cleanupError);
            }
            next(error); // Pasar al manejador de errores global
        }
    });
});


module.exports = router;
