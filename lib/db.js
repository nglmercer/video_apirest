// db.js
const fs = require('fs').promises;
const path = require('path');

// Define la ruta al archivo JSON donde se guardarán los metadatos
// __dirname se refiere al directorio actual de db.js
const METADATA_FILE_PATH = path.join(__dirname, '..', 'video_metadata.json'); // Guarda el archivo en la raíz del proyecto

let videoMetadataStore = {}; // Caché en memoria

/**
 * Carga los metadatos desde el archivo JSON a la memoria.
 * Se llama una vez al iniciar o cuando sea necesario recargar.
 */
async function loadMetadata() {
    try {
        // Intenta leer el archivo
        const data = await fs.readFile(METADATA_FILE_PATH, 'utf8');
        videoMetadataStore = JSON.parse(data);
        console.log('[DB] Metadatos cargados desde:', METADATA_FILE_PATH);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // El archivo no existe (primera ejecución), inicializa vacío
            console.log('[DB] Archivo de metadatos no encontrado, inicializando almacén vacío.');
            videoMetadataStore = {};
            // Opcional: Crear el archivo vacío
            await saveMetadata();
        } else {
            // Otro error de lectura o parseo
            console.error('[DB] Error al cargar metadatos:', error);
            // Decide cómo manejar esto: ¿iniciar vacío o lanzar error?
            // Por seguridad, iniciamos vacío para evitar crasheos, pero logueamos el error.
            videoMetadataStore = {};
        }
    }
}

/**
 * Guarda el estado actual del almacén de metadatos en el archivo JSON.
 * ATENCIÓN: Esta operación es de escritura y puede ser un cuello de botella.
 * Para producción, usa una DB real.
 */
async function saveMetadata() {
    try {
        // Convierte el objeto JS a string JSON formateado
        const data = JSON.stringify(videoMetadataStore, null, 2); // null, 2 para indentación
        await fs.writeFile(METADATA_FILE_PATH, data, 'utf8');
        // console.log('[DB] Metadatos guardados en:', METADATA_FILE_PATH); // Log opcional, puede ser ruidoso
    } catch (error) {
        console.error('[DB] Error al guardar metadatos:', error);
        // Considera qué hacer si falla el guardado (¿reintentar, alertar?)
    }
}

/**
 * Obtiene los metadatos para un video específico por su ID.
 * @param {string} videoId - El ID único del video.
 * @returns {Promise<object|null>} - El objeto de metadatos o null si no se encuentra.
 */
async function getVideoMetadata(videoId) {
    // Si la caché está vacía (posiblemente primer acceso después de reiniciar), carga primero
    if (Object.keys(videoMetadataStore).length === 0) {
        await loadMetadata();
    }
    return videoMetadataStore[videoId] || null; // Devuelve el objeto o null
}

/**
 * Guarda o actualiza los metadatos para un video.
 * @param {object} metadata - El objeto de metadatos a guardar. Debe incluir 'videoId'.
 * @returns {Promise<void>}
 */
async function saveVideoMetadata(metadata) {
    if (!metadata || !metadata.videoId) {
        console.error('[DB] Intento de guardar metadatos sin videoId:', metadata);
        throw new Error('Los metadatos deben incluir un videoId');
    }
    // Si la caché está vacía, carga primero
    if (Object.keys(videoMetadataStore).length === 0 && metadata.videoId !== Object.keys(videoMetadataStore)[0]) {
        await loadMetadata(); // Asegura cargar datos existentes antes de sobrescribir
    }

    videoMetadataStore[metadata.videoId] = metadata; // Agrega o actualiza en la caché
    await saveMetadata(); // Guarda el estado completo en el archivo
    console.log(`[DB] Metadatos guardados/actualizados para videoId: ${metadata.videoId}`);
}

// Carga inicial al requerir el módulo
loadMetadata().catch(err => console.error("[DB] Error en la carga inicial de metadatos:", err));

// Exporta las funciones necesarias
module.exports = {
    getVideoMetadata,
    saveVideoMetadata,
    // Podrías añadir más funciones si las necesitas (listar videos, eliminar, etc.)
};