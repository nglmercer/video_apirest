const express = require('express');
const router = express.Router();
const metadataUtils = require('../utils/metadata');

// Ruta para obtener todos los videos con sus metadatos
router.get('/videos', async (req, res) => {
    try {
        const videos = await metadataUtils.getAllVideos();
        res.json({
            success: true,
            count: videos.length,
            videos: videos
        });
    } catch (error) {
        console.error('Error al obtener metadatos de videos:', error);
        res.status(500).json({
            success: false,
            error: 'Error al obtener metadatos de videos',
            details: error.message
        });
    }
});

// Ruta para obtener metadatos de un video específico por ID
router.get('/videos/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const video = await metadataUtils.getVideoById(videoId);
        
        if (!video) {
            return res.status(404).json({
                success: false,
                error: 'Video no encontrado'
            });
        }
        
        res.json({
            success: true,
            video: video
        });
    } catch (error) {
        console.error('Error al obtener metadatos del video:', error);
        res.status(500).json({
            success: false,
            error: 'Error al obtener metadatos del video',
            details: error.message
        });
    }
});

// Ruta para eliminar metadatos de un video
router.delete('/videos/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const deleted = await metadataUtils.deleteVideoById(videoId);
        
        if (!deleted) {
            return res.status(404).json({
                success: false,
                error: 'Video no encontrado'
            });
        }
        
        res.json({
            success: true,
            message: 'Metadatos del video eliminados correctamente'
        });
    } catch (error) {
        console.error('Error al eliminar metadatos del video:', error);
        res.status(500).json({
            success: false,
            error: 'Error al eliminar metadatos del video',
            details: error.message
        });
    }
});

module.exports = router;