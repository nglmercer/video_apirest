const fs = require('fs').promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

// Ruta al archivo JSON que almacenará los metadatos de los videos
const DATA_DIR = path.join(__dirname, '..', 'data');
const VIDEOS_METADATA_FILE = path.join(DATA_DIR, 'videos.json');

// Función para asegurar que el directorio de datos existe
async function ensureDataDirExists() {
    try {
        await fs.access(DATA_DIR);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.mkdir(DATA_DIR, { recursive: true });
            console.log(`Directorio de datos creado: ${DATA_DIR}`);
        } else {
            throw error;
        }
    }
}

// Función para leer los metadatos de todos los videos
async function readVideosMetadata() {
    await ensureDataDirExists();
    
    try {
        const data = await fs.readFile(VIDEOS_METADATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // Si el archivo no existe, crear uno nuevo con un array vacío
            const initialData = { videos: [] };
            await fs.writeFile(VIDEOS_METADATA_FILE, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        throw error;
    }
}

// Función para guardar los metadatos de todos los videos
async function saveVideosMetadata(data) {
    await ensureDataDirExists();
    await fs.writeFile(VIDEOS_METADATA_FILE, JSON.stringify(data, null, 2));
}

// Función para extraer metadatos de un archivo de video
async function extractVideoMetadata(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                return reject(err);
            }
            
            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
            
            if (!videoStream) {
                return reject(new Error('No se encontró stream de video'));
            }
            
            // Calcular duración en formato legible
            const durationSecs = parseFloat(metadata.format.duration || 0);
            const hours = Math.floor(durationSecs / 3600);
            const minutes = Math.floor((durationSecs % 3600) / 60);
            const seconds = Math.floor(durationSecs % 60);
            const formattedDuration = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            
            // Calcular tamaño en formato legible
            const sizeBytes = parseInt(metadata.format.size || 0);
            const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
            
            const videoInfo = {
                duration: durationSecs,
                durationFormatted: formattedDuration,
                size: sizeBytes,
                sizeFormatted: `${sizeMB} MB`,
                width: videoStream.width,
                height: videoStream.height,
                bitrate: parseInt(videoStream.bit_rate || metadata.format.bit_rate || 0),
                codec: videoStream.codec_name,
                fps: eval(videoStream.r_frame_rate || '0'),
                hasAudio: !!audioStream,
                audioCodec: audioStream ? audioStream.codec_name : null,
                audioChannels: audioStream ? audioStream.channels : null,
                format: metadata.format.format_name,
                quality: `${videoStream.height}p`
            };
            
            resolve(videoInfo);
        });
    });
}

// Función para añadir un nuevo video a los metadatos
async function addVideoMetadata(videoId, originalFilename, metadataInfo, b2Info = {}) {
    const data = await readVideosMetadata();
    
    // Verificar si ya existe un video con este ID
    const existingIndex = data.videos.findIndex(v => v.videoId === videoId);
    
    const videoEntry = {
        videoId,
        index: existingIndex >= 0 ? data.videos[existingIndex].index : data.videos.length,
        originalFilename,
        uploadDate: new Date().toISOString(),
        ...metadataInfo,
        b2Info
    };
    
    if (existingIndex >= 0) {
        // Actualizar video existente
        data.videos[existingIndex] = videoEntry;
    } else {
        // Añadir nuevo video
        data.videos.push(videoEntry);
    }
    
    await saveVideosMetadata(data);
    return videoEntry;
}

// Función para obtener un video por su ID
async function getVideoById(videoId) {
    const data = await readVideosMetadata();
    return data.videos.find(v => v.videoId === videoId) || null;
}

// Función para obtener todos los videos
async function getAllVideos() {
    const data = await readVideosMetadata();
    return data.videos;
}

// Función para eliminar un video por su ID
async function deleteVideoById(videoId) {
    const data = await readVideosMetadata();
    const initialLength = data.videos.length;
    data.videos = data.videos.filter(v => v.videoId !== videoId);
    
    // Si se eliminó algún video, actualizar los índices
    if (data.videos.length < initialLength) {
        data.videos = data.videos.map((video, index) => ({
            ...video,
            index
        }));
        await saveVideosMetadata(data);
        return true;
    }
    
    return false;
}

module.exports = {
    extractVideoMetadata,
    addVideoMetadata,
    getVideoById,
    getAllVideos,
    deleteVideoById,
    readVideosMetadata,
    saveVideosMetadata
};