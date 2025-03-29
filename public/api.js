// api.js
import { API_BASE_URL } from './config.js';

/**
 * Sube un archivo de video al backend.
 * @param {FormData} formData Datos del formulario con el archivo de video.
 * @returns {Promise<object>} Promesa que resuelve con el resultado del servidor.
 * @throws {Error} Si la subida falla o el servidor devuelve un error.
 */
export async function uploadVideo(formData) {
    console.log('[API] Enviando archivo...');
    try {
        const response = await fetch(`${API_BASE_URL}/upload`, {
            method: 'POST',
            body: formData,
        });
        console.log('[API] Respuesta de subida status:', response.status);

        const result = await response.json();
        console.log('[API] Respuesta de subida body:', result);

        if (!response.ok) {
             // Intenta usar el mensaje de error del backend si existe
            throw new Error(result.error || `Error del servidor: ${response.status}`);
        }
        // Específicamente para 202 Accepted
        if (response.status === 202) {
             return { accepted: true, message: `Subida aceptada! Procesamiento iniciado para video ID: ${result.videoId}. Refresca la lista más tarde.`, videoId: result.videoId };
        }
        // Otros códigos 2xx (si los hubiera)
        return result;

    } catch (error) {
        console.error('[API] Error en uploadVideo:', error);
        // Re-lanzar para que el llamador lo maneje
        throw new Error(`Fallo en la subida: ${error.message}`);
    }
}

/**
 * Obtiene la lista de videos procesados desde el backend.
 * @returns {Promise<Array>} Promesa que resuelve con un array de objetos de video.
 * @throws {Error} Si la obtención falla o el servidor devuelve un error.
 */
export async function fetchVideos() {
    console.log('[API] Obteniendo lista de videos...');
    try {
        const response = await fetch(`${API_BASE_URL}/videos`);
        console.log('[API] Respuesta de lista status:', response.status);

        if (!response.ok) {
            let errorData = {};
            try {
                 errorData = await response.json();
            } catch(e) {
                // Si el cuerpo no es JSON o está vacío
                console.warn("[API] No se pudo parsear el cuerpo del error JSON");
            }
            console.error('[API] Datos del error al obtener lista:', errorData);
            throw new Error(errorData.error?.message || errorData.error || `Fallo al obtener videos: ${response.status}`);
        }
        const videos = await response.json();
        console.log('[API] Videos recibidos:', videos);
        return videos;

    } catch (error) {
        console.error('[API] Error en fetchVideos:', error);
         // Re-lanzar para que el llamador lo maneje
        throw new Error(`Fallo al obtener la lista: ${error.message}`);
    }
}