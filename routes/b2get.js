const express = require('express');
const router = express.Router();
const b2 = require('../back.js'); // Importar módulo de Backblaze B2

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

// --- Ruta para buscar archivos por prefijo ---
// GET /b2/search/prefix?prefix=folder/
router.get('/search/prefix', async (req, res, next) => {
  try {
    const { prefix } = req.query;
    const { maxCount } = req.query;
    
    if (!prefix) {
      return res.status(400).json({ error: 'Se requiere el parámetro prefix' });
    }

    const bucketId = process.env.B2_BUCKET_ID;
    const maxFileCount = maxCount ? parseInt(maxCount) : 100;
    
    const files = await b2.searchFilesByPrefix(bucketId, prefix, maxFileCount);
    
    // Mapear los resultados para incluir la URL de descarga directa
    const filesWithUrls = files.map(file => ({
      ...file,
      downloadUrl: `${b2.getDownloadUrl()}/file/${process.env.B2_BUCKET_NAME}/${encodeURIComponent(file.fileName)}`
    }));

    res.status(200).json({
      prefix,
      count: filesWithUrls.length,
      files: filesWithUrls
    });
  } catch (error) {
    console.error(`[B2 Search] Error buscando archivos con prefijo:`, error);
    next(error);
  }
});

// --- Ruta para buscar archivos por nombre ---
// GET /b2/search/name?name=video
router.get('/search/name', async (req, res, next) => {
  try {
    const { name } = req.query;
    
    if (!name) {
      return res.status(400).json({ error: 'Se requiere el parámetro name' });
    }

    const bucketId = process.env.B2_BUCKET_ID;
    const files = await b2.searchFilesByName(bucketId, name);
    
    // Mapear los resultados para incluir la URL de descarga directa
    const filesWithUrls = files.map(file => ({
      ...file,
      downloadUrl: `${b2.getDownloadUrl()}/file/${process.env.B2_BUCKET_NAME}/${encodeURIComponent(file.fileName)}`
    }));

    res.status(200).json({
      searchTerm: name,
      count: filesWithUrls.length,
      files: filesWithUrls
    });
  } catch (error) {
    console.error(`[B2 Search] Error buscando archivos por nombre:`, error);
    next(error);
  }
});

// --- Ruta para listar carpetas virtuales ---
// GET /b2/folder?path=videos/
router.get('/folder', async (req, res, next) => {
  try {
    const { path } = req.query;
    const folderPath = path || ''; // Si no se proporciona, listar la raíz
    
    const bucketId = process.env.B2_BUCKET_ID;
    const result = await b2.listFolder(bucketId, folderPath);
    
    // Mapear los archivos para incluir URLs de descarga
    const filesWithUrls = result.files.map(file => ({
      ...file,
      downloadUrl: `${b2.getDownloadUrl()}/file/${process.env.B2_BUCKET_NAME}/${encodeURIComponent(file.fileName)}`
    }));

    res.status(200).json({
      path: folderPath,
      folders: result.folders,
      files: filesWithUrls
    });
  } catch (error) {
    console.error(`[B2 Folder] Error listando carpeta:`, error);
    next(error);
  }
});
router.get('/videos', async (req, res, next) => {
    try {
        const bucketId = process.env.B2_BUCKET_ID;
        // Filtrar solo archivos master.m3u8
        const listResult = await b2.listVideoFiles(bucketId, null, 500, 'master.m3u8');
        if (listResult && listResult.files) {
            // Mapear los resultados para incluir la URL de descarga directa
            const filesWithUrls = listResult.files.map(file => ({
                ...file,
                downloadUrl: `${b2.getDownloadUrl()}/file/${process.env.B2_BUCKET_NAME}/${encodeURIComponent(file.fileName)}`
            }));

            res.status(200).json({
                files: filesWithUrls,
                nextFileName: listResult.nextFileName, // Para paginación futura
                totalVideoFiles: filesWithUrls.length
            });
        } else {
            res.status(500).send('Failed to list master.m3u8 files from B2.');
        }
    } catch (error) {
        console.error('[B2 List] Error listing master.m3u8 files:', error);
        next(error);
    }
});
module.exports = router;
