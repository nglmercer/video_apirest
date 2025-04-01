const path = require('path');
const fs = require('fs').promises;
const ffmpeg = require('fluent-ffmpeg');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const metadataUtils = require('./metadata'); // Importar utilidades de metadatos

// Explicitly set the ffprobe path for fluent-ffmpeg
ffmpeg.setFfprobePath(ffprobePath);

// Define paths relative to the project root (assuming utils is one level down)
const PROJECT_ROOT = path.join(__dirname, '..');
const PROCESSED_DIR_UTILS = path.join(PROJECT_ROOT, 'processed_videos');
const VIDEOS_DIR_UTILS = path.join(PROJECT_ROOT, 'videos');


// --- Ensure Directories Exist ---
const ensureDirExists = async (dirPath) => {
    try {
        await fs.access(dirPath);
        // console.log(`Directory already exists: ${dirPath}`); // Less verbose
    } catch (error) {
        if (error.code === 'ENOENT') {
            try {
                await fs.mkdir(dirPath, { recursive: true });
                console.log(`Directory created: ${dirPath}`);
            } catch (mkdirError) {
                console.error(`Error creating directory ${dirPath}:`, mkdirError);
                throw mkdirError;
            }
        } else {
            console.error(`Error accessing directory ${dirPath}:`, error);
            throw error;
        }
    }
};

// --- HLS Conversion Function ---
const convertToHls = (inputPath, videoId, originalFilename = null, authToken = null) => {
    return new Promise(async (resolve, reject) => {
        let outputDir = path.join(PROCESSED_DIR_UTILS, videoId); // Inicialmente definimos la ruta básica
        await ensureDirExists(outputDir);

        // --- Get Original Video Info ---
        let originalWidth, originalHeight, originalBitrate;
        let videoMetadata = null;
        try {
            // Extraer metadatos completos del video
            videoMetadata = await metadataUtils.extractVideoMetadata(inputPath);
            console.log(`[${videoId}] Metadatos extraídos:`, JSON.stringify(videoMetadata, null, 2));
            
            originalWidth = videoMetadata.width;
            originalHeight = videoMetadata.height;
            originalBitrate = videoMetadata.bitrate || '5000k';
            console.log(`[${videoId}] Original resolution: ${originalWidth}x${originalHeight}, Bitrate: ${originalBitrate}`);

            if (!originalWidth || !originalHeight) {
                throw new Error('Could not determine original video dimensions.');
            }
            
            // Asegurar que tenemos un ID de carpeta único basado en el índice
            const allVideos = await metadataUtils.getAllVideos();
            const folderIndex = allVideos.length;
            console.log(`[${videoId}] Asignando índice de carpeta: ${folderIndex}`);
            
            // Guardar los metadatos en el archivo JSON con el índice de carpeta
            const filename = originalFilename || path.basename(inputPath);
            await metadataUtils.addVideoMetadata(videoId, filename, videoMetadata, {
                folderIndex,
                authToken
            });
            
            // Crear un directorio específico para este video basado en su índice
            const indexedOutputDir = path.join(PROCESSED_DIR_UTILS, `${folderIndex}_${videoId}`);
            // Actualizar la ruta de salida para usar el directorio indexado
            const outputDir = indexedOutputDir;
            await ensureDirExists(outputDir);
            console.log(`[${videoId}] Directorio indexado creado: ${outputDir}`);
        } catch (err) {
            console.error(`[${videoId}] Error probing video metadata:`, err);
            return reject(new Error(`Failed to get video metadata: ${err.message}`));
        }

        // --- Define Resolutions ---
        const targetResolutions = [
            { name: '480p', size: '854x480', bitrate: '800k' },
            { name: '720p', size: '1280x720', bitrate: '1500k' }
        ];

        const originalResName = `${originalHeight}p`;
        if (originalHeight !== 480 && originalHeight !== 720 && originalWidth && originalHeight) {
            targetResolutions.push({
                name: originalResName,
                size: `${originalWidth}x${originalHeight}`,
                bitrate: originalBitrate,
                isOriginal: true
            });
            targetResolutions.sort((a, b) => parseInt(a.name) - parseInt(b.name));
        }

        // Usa la ruta del proxy en lugar de la estructura de Backblaze directamente
        const proxyBaseUrl = `http://localhost:3000/stream-resource/${videoId}/`; // Ajusta a tu dominio real
        let masterPlaylistContent = '#EXTM3U\n#EXT-X-VERSION:3\n';
        const processingPromises = [];

        // --- Process Each Resolution ---
        targetResolutions.forEach(res => {
            const resOutputDir = path.join(outputDir, res.name);
            const playlistPath = path.join(resOutputDir, 'playlist.m3u8');
            const bandwidth = parseInt(String(res.bitrate).replace('k', '')) * 1000 || 500000;
            // Usa la ruta del proxy en el master.m3u8
            masterPlaylistContent += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${res.size}\n${proxyBaseUrl}${res.name}/playlist.m3u8\n`;

            const promise = new Promise(async (resResolve, resReject) => {
                await ensureDirExists(resOutputDir);

                let command = ffmpeg(inputPath);

                if (res.isOriginal) {
                    console.log(`[${videoId}] Segmenting original resolution (${res.name}) by copying streams.`);
                    command = command.outputOptions([
                        '-c:v copy',
                        '-c:a copy',
                        '-hls_time 10',
                        '-hls_playlist_type vod',
                        `-hls_segment_filename ${path.join(resOutputDir, 'segment%03d.ts')}`
                    ]);
                } else {
                    console.log(`[${videoId}] Re-encoding to ${res.name}.`);
                    command = command.outputOptions([
                        `-vf scale=${res.size}`,
                        `-c:a aac`, `-ar 48000`, `-b:a 128k`,
                        `-c:v h264`, `-profile:v main`, `-crf 20`, `-sc_threshold 0`,
                        `-g 48`, `-keyint_min 48`,
                        `-hls_time 10`, `-hls_playlist_type vod`,
                        `-b:v ${res.bitrate}`,
                        `-maxrate ${Math.floor(bandwidth * 1.2 / 1000)}k`,
                        `-bufsize ${Math.floor(bandwidth * 1.5 / 1000)}k`,
                        `-hls_segment_filename ${path.join(resOutputDir, 'segment%03d.ts')}`
                    ]);
                }

                command
                    .output(playlistPath)
                    .on('start', (commandLine) => console.log(`[${videoId}] Started processing ${res.name}: ${commandLine}`))
                    .on('progress', (progress) => {
                        const percent = progress.percent === undefined ? 0 : progress.percent;
                        console.log(`[${videoId}] Processing ${res.name}: ${percent.toFixed(2)}% done`);
                    })
                    .on('end', () => {
                        console.log(`[${videoId}] Finished processing ${res.name}`);
                        resResolve();
                    })
                    .on('error', (err) => {
                        console.error(`[${videoId}] Error processing ${res.name}:`, err);
                        resReject(err);
                    })
                    .run();
            });
            processingPromises.push(promise);
        });

        try {
            const results = await Promise.allSettled(processingPromises);
            const errors = results.filter(result => result.status === 'rejected');

            if (errors.length > 0) {
                errors.forEach(errorResult => {
                    console.error(`[${videoId}] A resolution processing step failed:`, errorResult.reason);
                });
                throw new Error(`HLS conversion failed for one or more resolutions.`);
            }

            const masterPlaylistPath = path.join(outputDir, 'master.m3u8');
            const finalMasterPlaylistContent = masterPlaylistContent.endsWith('\n') ? masterPlaylistContent : masterPlaylistContent + '\n';
            await fs.writeFile(masterPlaylistPath, finalMasterPlaylistContent);
            console.log(`[${videoId}] Master playlist created successfully: ${masterPlaylistPath}`);

            // Devuelve la URL del proxy en lugar de la URL directa de Backblaze
            const proxyMasterUrl = `http://localhost:3000/stream/${videoId}`; // Ajusta a tu dominio real

            resolve({
                message: 'HLS conversion successful',
                masterPlaylistUrl: proxyMasterUrl
            });
        } catch (error) {
            console.error(`[${videoId}] Error during HLS conversion:`, error);
            reject(error);
        }
    });
};
module.exports = {
    ensureDirExists,
    convertToHls,
    // No longer exporting PROCESSED_DIR from here
    VIDEOS_DIR: VIDEOS_DIR_UTILS // Export the correctly defined path
};
