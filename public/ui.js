// ui.js

// Selección de elementos DOM
export const uploadForm = document.getElementById('uploadForm');
export const videoFile = document.getElementById('videoFile');
export const uploadStatus = document.getElementById('uploadStatus');
export const videoList = document.getElementById('videoList');
export const refreshListBtn = document.getElementById('refreshListBtn');
export const videoPlayerElement = document.getElementById('videoPlayer');
export const playerStatus = document.getElementById('playerStatus');

/**
 * Establece un mensaje de estado en un elemento de alerta (estilo DaisyUI).
 * @param {HTMLElement} element El elemento contenedor de la alerta.
 * @param {'info'|'success'|'error'|'warning'|''} type El tipo de alerta.
 * @param {string} message El mensaje a mostrar.
 * @param {boolean} [show=true] Si se debe mostrar u ocultar el elemento.
 */
export function setStatus(element, type, message, show = true) {
    const span = element.querySelector('span');
    if (!span) {
        console.error("No se encontró el span dentro del elemento de estado:", element);
        return;
    }

    // Resetear clases - específico para alertas DaisyUI
    element.classList.remove('alert-info', 'alert-success', 'alert-error', 'alert-warning');

    if (show) {
        if (type) {
            element.classList.add(`alert-${type}`); // 'alert-info', 'alert-success', etc.
        }
        span.textContent = message;
        element.style.display = 'flex'; // Usar flex para alertas DaisyUI
    } else {
        span.textContent = ''; // Limpiar texto
        element.style.display = 'none';
    }
}

/**
 * Renderiza la lista de videos en el elemento UL proporcionado.
 * @param {Array} videos Array de objetos de video {id, masterPlaylistUrl}.
 * @param {function} onPlayCallback Callback a ejecutar cuando se pulsa 'Play'.
 */
export function renderVideoList(videos, onPlayCallback) {
    videoList.innerHTML = ''; // Limpiar estado de carga o lista anterior

    if (!videos || videos.length === 0) {
        videoList.innerHTML = '<li><a>No hay videos procesados aún.</a></li>';
        return;
    }
    if (Array.isArray(videos)){
        videos.forEach(video => {
            if (!video.id || !video.masterPlaylistUrl) {
                console.warn("[UI] Omitiendo video con datos faltantes:", video);
                return; // Omitir esta entrada de video
            }
            createVideoElement(video)

        });
    }else
    {
        videos.files.forEach(video => {
            if (video && video.contentType === "application/vnd.apple.mpegurl"){
                createVideoElement(video,onPlayCallback)
            }
        })
    }
}

async function getDownloadUrl(fileName, bucketName = "cloud-video-store") {
    try {
        //`/b2/hls-url/?filePath=${encodeURIComponent()}`
        //
      const response = await fetch(`/b2/download-url/${encodeURIComponent(fileName)}?bucket=${bucketName}`);
      
      if (!response.ok) {
        throw new Error(`Error HTTP: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Error al obtener URL de descarga');
      }
      
      return data.downloadUrl;
      
    } catch (error) {
      console.error('Error al obtener URL de descarga:', error);
      throw error;
    }
  }
function createVideoElement(video,onPlayCallback){
    const li = document.createElement('li');
    const a = document.createElement('a'); // Usar ancla para ítem de menú
    a.className = "flex justify-between items-center";
    a.href = "#"; // Prevenir salto de página
    const videoID = video.id || video.fileId;
    const mastervideo = video.masterPlaylistUrl || video.downloadUrl;
    const span = document.createElement('span');
    span.textContent = `ID: ${mastervideo}`

    const playButton = document.createElement('button');
    playButton.textContent = 'Play';
    playButton.className = "btn btn-success btn-xs"; // Estilo botón DaisyUI
    playButton.onclick = async (e) => {
        e.preventDefault(); // Prevenir comportamiento del enlace ancla
        e.stopPropagation();
        console.log("[UI] Botón Play pulsado para video:", video);
        if (onPlayCallback) {
        const urlTodownload = await getDownloadUrl(video.fileName)
        console.log(urlTodownload)
            
            onPlayCallback(urlTodownload, videoID);

        }
    };

    a.appendChild(span);
    a.appendChild(playButton);
    li.appendChild(a);
    videoList.appendChild(li);
}
/**
 * Muestra un estado de carga en la lista de videos.
 */
export function showVideoListLoading() {
     videoList.innerHTML = '<li><a><span class="loading loading-spinner loading-xs"></span> Cargando...</a></li>';
}

/**
 * Muestra un error en la lista de videos.
 * @param {string} errorMessage
 */
export function showVideoListError(errorMessage) {
    videoList.innerHTML = `<li><a>Error cargando videos: ${errorMessage}</a></li>`;
}