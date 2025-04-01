// main.js
import * as UI from './ui.js';
import * as API from './api.js';
import * as Player from './player.js';

// --- Inicialización ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("[Main] DOM listo.");
    Player.initializePlayer(); // Inicializar Plyr
    setupEventListeners();     // Configurar listeners de eventos de UI
    handleFetchVideoList();    // Cargar la lista inicial de videos
});

// --- Configuración de Event Listeners ---
function setupEventListeners() {
    console.log("[Main] Configurando event listeners...");

    // Listener para el formulario de subida
    UI.uploadForm.addEventListener('submit', handleUploadSubmit);

    // Listener para el botón de refrescar lista
    UI.refreshListBtn.addEventListener('click', handleFetchVideoList);

    console.log("[Main] Event listeners configurados.");
}

// --- Manejadores de Eventos ---

/**
 * Maneja el envío del formulario de subida.
 */
async function handleUploadSubmit(event) {
    event.preventDefault();
    UI.setStatus(UI.uploadStatus, 'info', 'Subiendo...');
    console.log('[Main] Envío de formulario detectado.');

    const formData = new FormData();
    if (!UI.videoFile.files || UI.videoFile.files.length === 0) {
        UI.setStatus(UI.uploadStatus, 'error', 'No se seleccionó ningún archivo.');
        console.error('[Main] No hay archivo seleccionado.');
        return;
    }
    formData.append('video', UI.videoFile.files[0]);

    try {
        const result = await API.uploadVideo(formData);
        // El resultado puede variar (éxito directo o aceptación 202)
        if (result.accepted) {
            UI.setStatus(UI.uploadStatus, 'success', result.message);
             // Refrescar lista después de un tiempo
            console.log('[Main] Programando refresco de lista tras subida aceptada.');
            setTimeout(handleFetchVideoList, 7000); // Aumentar un poco el tiempo
        } else {
            // Manejar otros posibles éxitos si los hubiera
             UI.setStatus(UI.uploadStatus, 'success', 'Subida completada (respuesta inesperada).');
        }
        UI.uploadForm.reset(); // Limpiar formulario

    } catch (error) {
        console.error('[Main] Error durante la subida:', error);
        UI.setStatus(UI.uploadStatus, 'error', error.message); // Mostrar error de API
    }
}

/**
 * Maneja la obtención y renderizado de la lista de videos.
 */
async function handleFetchVideoList() {
    UI.setStatus(UI.uploadStatus, 'info', 'Obteniendo lista de videos...');
    UI.showVideoListLoading(); // Mostrar estado de carga en la lista
    console.log('[Main] Obteniendo lista de videos...');

    try {
        const videos = await API.fetchVideos();
        console.log('[Main] Lista de videos obtenida:', videos);
        // Pasar el callback `Player.loadVideo` a la función de renderizado
        UI.renderVideoList(videos, Player.loadVideo);
        // Limpiar estado solo si no hubo error al obtener la lista
        UI.setStatus(UI.uploadStatus, '', '', false);
    } catch (error) {
        console.error('[Main] Error obteniendo la lista de videos:', error);
        UI.showVideoListError(error.message); // Mostrar error en la lista
        // Mostrar error también en el área de estado de subida/general
        UI.setStatus(UI.uploadStatus, 'error', `Fallo al obtener lista: ${error.message}`);
    }
}

// Opcional: Limpieza al descargar la página (puede no ser necesario en SPAs)
// window.addEventListener('beforeunload', () => {
//     Player.destroyPlayer();
// });