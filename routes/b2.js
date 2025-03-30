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

// --- Helper function to recursively list files ---
async function listFilesInDirRecursive(dirPath) {
    let fileList = [];
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name); // Usar join en lugar de resolve aquí
        if (entry.isDirectory()) {
            fileList = fileList.concat(await listFilesInDirRecursive(fullPath));
        } else if (entry.isFile()) {
            fileList.push(fullPath);
        }
    }
    return fileList;
}

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
        const fileName = req.file.originalname; // Usar el nombre original

        const uploadResult = await b2.uploadFile(bucketId, fileName, tempFilePath);

        // Eliminar el archivo temporal después de subirlo
        fs.unlinkSync(tempFilePath);
        console.log(`[B2 Direct Upload] Archivo temporal eliminado: ${tempFilePath}`);

        if (uploadResult) {
            // Construir la URL de descarga
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
                console.log(`[B2 Direct Upload] Archivo temporal eliminado tras error: ${tempFilePath}`);
            } catch (unlinkError) {
                console.error("[B2 Direct Upload] Error eliminando archivo temporal tras error:", unlinkError);
            }
        }
        console.error('[B2 Direct Upload] Error during B2 direct upload:', error);
        next(error); // Pasar el error al manejador de errores global
    }
});

// --- Ruta para listar archivos/videos desde Backblaze B2 ---
// GET /b2/videos
router.get('/videos', async (req, res, next) => {
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
        console.error('[B2 List] Error listing B2 files:', error);
        next(error);
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
        const hlsLocalOutputDir = path.join(PROCESSED_DIR_ROOT, videoId); // Directorio donde convertToHls guardará los archivos

        console.log(`[B2 HLS Upload] Video temporal recibido: ${originalTempPath}`);
        console.log(`[B2 HLS Upload] Iniciando conversión HLS para videoId: ${videoId}`);

        try {
            // 1. Convertir a HLS localmente
            await convertToHls(originalTempPath, videoId, b2.getAuthToken());
            console.log(`[B2 HLS Upload] Conversión HLS completada para videoId: ${videoId}. Archivos en: ${hlsLocalOutputDir}`);

            // 2. Listar TODOS los archivos HLS generados recursivamente
            const allLocalFiles = await listFilesInDirRecursive(hlsLocalOutputDir);
            console.log(`[B2 HLS Upload] Archivos HLS locales encontrados (${allLocalFiles.length}):`, allLocalFiles);

            // 3. Subir cada archivo HLS a B2 manteniendo la estructura de carpetas
            const bucketId = process.env.B2_BUCKET_ID;
            const uploadPromises = allLocalFiles.map(async (localFilePath) => {
                // Calcular ruta relativa al directorio base HLS
                const relativePath = path.relative(hlsLocalOutputDir, localFilePath);
                // Construir nombre de objeto B2 (prefijo + ruta relativa con /)
                const b2FileName = `${videoId}/${relativePath.replace(/\\/g, '/')}`; // Asegurar separadores /

                try {
                    const result = await b2.uploadFile(bucketId, b2FileName, localFilePath);
                    if (!result) {
                        console.warn(`[B2 HLS Upload] Falló la subida a B2 para: ${b2FileName} (desde ${localFilePath})`);
                        return { success: false, file: b2FileName };
                    }
                    console.log(`[B2 HLS Upload] Subido a B2: ${b2FileName} (desde ${localFilePath})`);
                    return { success: true, file: b2FileName, info: result };
                } catch (uploadError) {
                    console.error(`[B2 HLS Upload] Error subiendo ${b2FileName} a B2:`, uploadError);
                    return { success: false, file: b2FileName };
                }
            });

            const uploadResults = await Promise.all(uploadPromises);
            const successfulUploads = uploadResults.filter(r => r.success);
            const failedUploads = uploadResults.filter(r => !r.success);

            console.log(`[B2 HLS Upload] Subidas a B2 completadas. Éxitos: ${successfulUploads.length}, Fallos: ${failedUploads.length}`);

            // 4. Limpieza local (independientemente del éxito de la subida a B2)
            try {
                await fsPromises.unlink(originalTempPath);
                console.log(`[B2 HLS Upload] Archivo original temporal eliminado: ${originalTempPath}`);
                await fsPromises.rm(hlsLocalOutputDir, { recursive: true, force: true });
                console.log(`[B2 HLS Upload] Directorio HLS local eliminado: ${hlsLocalOutputDir}`);
            } catch (cleanupError) {
                console.error(`[B2 HLS Upload] Error durante la limpieza local:`, cleanupError);
            }

            // 5. Responder al cliente
            const mainManifestB2Path = `${videoId}/master.m3u8`;
            const mainManifestUrl = `${b2.getDownloadUrl()}/file/${process.env.B2_BUCKET_NAME}/${encodeURIComponent(mainManifestB2Path)}`;

            if (failedUploads.length > 0) {
                 res.status(207).json({ // Multi-Status
                    message: `HLS conversion complete. ${successfulUploads.length} files uploaded to B2, ${failedUploads.length} failed.`,
                    videoId: videoId,
                    b2Prefix: videoId + '/',
                    successfulUploads: successfulUploads.map(r => r.file),
                    failedUploads: failedUploads.map(r => r.file),
                    mainManifestUrl: mainManifestUrl
                });
            } else {
                 res.status(200).json({
                    message: 'HLS conversion and upload to B2 completed successfully.',
                    videoId: videoId,
                    b2Prefix: videoId + '/',
                    uploadedFiles: successfulUploads.map(r => r.file),
                    mainManifestUrl: mainManifestUrl
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
router.get('/download-url/:fileName', async (req, res) => {
    try {
      const { fileName } = req.params;
      const { bucket } = req.query; // Opcional: nombre del bucket como parámetro query
      
      if (!fileName) {
        return res.status(400).json({ error: 'Se requiere el nombre del archivo' });
      }
  
      const downloadUrl = await b2.getDownloadUrlWithToken(
        fileName, 
        bucket || "cloud-video-store" // Bucket por defecto
      );
  
      res.json({
        success: true,
        downloadUrl,
        fileName
      });
    } catch (error) {
      console.error('Error al generar URL de descarga:', error);
      res.status(500).json({ 
        error: 'Error al generar URL de descarga',
        details: error.message 
      });
    }
  });
  
  // Ruta para redireccionar directamente al archivo
router.get('/download/:fileName', async (req, res) => {
try {
    const { fileName } = req.params;
    const { bucket } = req.query; // Opcional: nombre del bucket como parámetro query
    
    if (!fileName) {
    return res.status(400).json({ error: 'Se requiere el nombre del archivo' });
    }

    const downloadUrl = await b2.getDownloadUrlWithToken(
    fileName, 
    bucket || "cloud-video-store" // Bucket por defecto
    );

    res.redirect(downloadUrl);
} catch (error) {
    console.error('Error al descargar archivo:', error);
    res.status(500).json({ 
    error: 'Error al descargar archivo',
    details: error.message 
    });
}
});
router.get('/hls-url', async (req, res) => {
    try {
      const { filePath } = req.query;
      
      if (!filePath) {
        return res.status(400).json({ 
          error: 'Se requiere el parámetro filePath' 
        });
      }
  
      // Ejemplo de filePath: "1743289534031-538902181-R_E_P_O____2025_03_23_2_10_46_a___m_/master.m3u8"
      const downloadUrl = await b2.getDownloadUrlWithToken(
        filePath,
        "cloud-video-store" // Tu bucket name
      );
  
      res.json({
        success: true,
        url: downloadUrl,
        filePath
      });
      
    } catch (error) {
      console.error('Error al generar URL HLS:', error);
      res.status(500).json({ 
        error: 'Error al generar URL',
        details: error.message 
      });
    }
  });

module.exports = router;
