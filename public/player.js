// player.js
import * as UI from './ui.js';

let player = null;
let hls = null;
let currentQualityLevelMap = {}; // Map: Plyr quality value (e.g., 720) -> HLS level index
let isUpdatingQualityInternally = false; // Prevent quality change feedback loops

export function initializePlayer() {
    console.log("[Player] Initializing Plyr...");
    player = new Plyr(UI.videoPlayerElement, {
        captions: { active: true, update: true, language: 'auto' },
        debug: false,
        settings: ['captions', 'quality', 'speed', 'loop'],
        quality: {
            default: -1, // 'Auto' (-1 HLS level index)
            options: [-1], // Initial placeholder for 'Auto'
            forced: true,
            onChange: (newQuality) => onQualityChange(newQuality),
        },
        i18n: {
            qualityLabel: {
                '-1': 'Auto', // Label for the 'Auto' option
                // Heights like 480, 720, 1080 will default to "480p", "720p", "1080p"
                // Add custom labels here if needed, e.g., 480: 'SD', 1080: 'HD'
            }
        }
    });

    player.on('error', (event) => {
        console.error('[Plyr] Error event:', event);
        const error = event.detail.plyr?.source?.error || event.detail.plyr?.error || { message: 'Unknown Plyr error' };
        UI.setStatus(UI.playerStatus, 'error', `Player error: ${error.message || 'Could not load video.'}`);
    });
    player.on('ready', () => {
        console.log("[Plyr] Ready event fired.");
        updatePlyrQualityUIState([]); // Initially disable/reset quality button
    });
    player.on('playing', () => console.log('[Plyr] Playing event fired.'));

    console.log("[Player] Plyr initialized.");
    return player;
}

export function loadVideo(hlsUrl, videoId) {
    if (!player) {
        console.error("[Player] Plyr player not initialized yet!");
        UI.setStatus(UI.playerStatus, 'error', 'Player not ready.');
        return;
    }

    UI.setStatus(UI.playerStatus, 'info', `Loading video: ${videoId}...`);
    console.log(`[Player] Attempting to load HLS stream: ${hlsUrl}`);

    if (hls) {
        console.log("[Player] Destroying previous HLS instance");
        hls.destroy();
        hls = null;
    }
    currentQualityLevelMap = {};
    isUpdatingQualityInternally = false;

    updatePlyrQualityUIState([]); // Reset Plyr's quality UI

    if (Hls.isSupported()) {
        console.log("[Player] HLS.js is supported. Initializing HLS.js.");
        hls = new Hls({
            debug: false,
            startLevel: -1, // Start with automatic quality selection
            // capLevelToPlayerSize: true, // Optional: Limit quality based on player size
        });

        console.log("[Player] Attaching HLS.js to video element...");
        hls.attachMedia(UI.videoPlayerElement);

        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
            console.log('[HLS.js] Event: MEDIA_ATTACHED. Loading source:', hlsUrl);
            hls.loadSource(hlsUrl);
        });

        hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
            console.log(`[HLS.js] Event: MANIFEST_PARSED. Levels available: ${data.levels.length}`,data);
            UI.setStatus(UI.playerStatus, 'success', `Playing: ${videoId}`);

            if (data.levels && data.levels.length > 0) {
                currentQualityLevelMap = {};
                const plyrQualityOptions = data.levels.map((level, index) => {
                    const height = level.height;
                    currentQualityLevelMap[height] = index;
                    return height;
                });

                plyrQualityOptions.unshift(-1); // Add 'Auto' option
                currentQualityLevelMap[-1] = -1; // Map 'Auto'

                console.log('[Player] Detected Plyr quality options:', plyrQualityOptions);
                console.log('[Player] Quality to HLS Level Map:', currentQualityLevelMap);

                updatePlyrQualityUIState(plyrQualityOptions);

                // Set initial quality in Plyr UI to reflect HLS startLevel (usually Auto)
                // Use setTimeout to allow Plyr's UI to potentially render first
                setTimeout(() => {
                    if (player && hls) {
                         const initialHlsLevel = hls.startLevel === -1 ? -1 : hls.levels[hls.startLevel]?.height;
                         player.quality = initialHlsLevel !== undefined ? initialHlsLevel : -1;
                         console.log(`[Player] Initial quality set in Plyr UI to: ${player.quality}`);
                         updateQualityButtonLabel(player.quality);
                    }
                }, 0);

            } else {
                updatePlyrQualityUIState([]); // No specific levels found
            }
        });

        hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
            if (!hls || !player) return;
            const newLevelIndex = data.level;
            console.log(`[HLS.js] Event: LEVEL_SWITCHED - Switched to HLS level index: ${newLevelIndex}`);

            const currentPlyrQuality = newLevelIndex >= 0 && hls.levels[newLevelIndex]
                ? hls.levels[newLevelIndex].height
                : -1; // -1 represents 'Auto'

             // Update Plyr's UI if the change wasn't triggered by the user selecting 'Auto' via UI
             // and the quality value actually changed from Plyr's perspective.
            if (!isUpdatingQualityInternally && player.quality !== currentPlyrQuality) {
                 console.log(`[Player] HLS automatically switched quality. Updating Plyr UI to: ${currentPlyrQuality}`);
                player.quality = currentPlyrQuality; // Update Plyr's internal state
                updateQualityButtonLabel(currentPlyrQuality); // Explicitly update the button label
            }
            isUpdatingQualityInternally = false; // Reset flag after handling
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
            console.error('[HLS.js] Event: ERROR - Data:', data);
            let errorMsg = `HLS Error: ${data.type} - ${data.details}`;
            if (data.fatal) {
                errorMsg += " (Fatal)";
                console.log('[Player] Stopping Plyr due to fatal HLS error.');
                if (player) player.stop();
                // Consider destroying HLS on fatal errors: if(hls) hls.destroy(); hls = null;
            } else {
                console.warn(`[HLS.js] Non-fatal error: ${data.type} - ${data.details}`);
                // Recovery logic could be added here for specific non-fatal errors
            }
            UI.setStatus(UI.playerStatus, 'error', errorMsg);
        });

        console.log('[Player] HLS.js is managing the source.');

    } else if (UI.videoPlayerElement.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS Support (Safari, iOS)
        console.log("[Player] Native HLS supported by browser.");
        updatePlyrQualityUIState([]); // Native browser handles quality switching

        console.log('[Player] Setting Plyr source for native HLS.');
        player.source = {
            type: 'video',
            sources: [{
                src: hlsUrl,
                type: 'application/vnd.apple.mpegurl'
            }]
        };
        player.once('ready', () => {
            console.log("[Player] Plyr ready for native HLS source.");
            UI.setStatus(UI.playerStatus, 'success', `Playing: ${videoId}`);
        });

    } else {
        // HLS Not Supported
        console.error('[Player] HLS is not supported in this browser.');
        UI.setStatus(UI.playerStatus, 'error', 'HLS playback is not supported in this browser.');
        if (player) {
            player.stop();
            player.source = { type: 'video', sources: [] }; // Clear source
        }
        updatePlyrQualityUIState([]);
    }
}

/**
 * Callback when user changes quality via Plyr UI. Tells HLS.js to switch.
 */
function onQualityChange(newQuality) {
    if (!hls) {
        console.warn("[QualityChange] HLS instance not available.");
        return;
    }
    // Prevent immediate feedback loop if HLS just switched and updated the UI
    if (isUpdatingQualityInternally) {
        console.log("[QualityChange] Skipping update, likely triggered internally by HLS level switch.");
        return;
    }

    const newLevelIndex = currentQualityLevelMap[newQuality];

    if (newLevelIndex !== undefined) {
        console.log(`[Player] User requested quality change via Plyr UI to: ${newQuality === -1 ? 'Auto' : newQuality + 'p'}`);
        console.log(`[HLS.js] Setting HLS currentLevel to index: ${newLevelIndex}`);

        // If user selects 'Auto', HLS might switch level immediately. Set flag to prevent
        // the LEVEL_SWITCHED handler from overriding the user's 'Auto' choice instantly.
        if (newLevelIndex === -1) {
            isUpdatingQualityInternally = true;
            // Reset flag shortly after, allowing HLS auto-switch logic to resume normally
            setTimeout(() => { isUpdatingQualityInternally = false; }, 500);
        }

        // Tell HLS.js to switch quality for future segments.
        hls.currentLevel = newLevelIndex;

        // Update button label immediately for responsiveness.
        updateQualityButtonLabel(newQuality);

    } else {
        console.warn(`[Player] Could not find corresponding HLS level index for quality value: ${newQuality}`);
    }
}

/**
 * Updates the Plyr quality settings menu items and button state.
 */
function updatePlyrQualityUIState(qualityOptions) {
    if (!player || !player.elements.settings?.menu) {
        // console.warn("[Player] Cannot update quality menu: Plyr not ready or menu not found.");
        return;
    }

    const qualityMenu = player.elements.settings.menu.querySelector('[data-plyr="quality"]');
    const qualityList = qualityMenu?.querySelector('ul');
    const qualityButton = player.elements.settings.buttons.quality;

    if (!qualityMenu || !qualityList || !qualityButton) {
        console.warn("[Player] Quality menu elements (container, list, or button) not found in DOM.");
        return;
    }

    qualityList.innerHTML = ''; // Clear existing options

    qualityOptions.forEach(quality => {
        const listItem = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.classList.add('plyr__control', 'plyr__control--forward');
        button.setAttribute('role', 'menuitemradio');
        button.setAttribute('value', quality); // Value Plyr uses and passes to onChange

        const label = player.config.i18n.qualityLabel[quality]
                     || (quality === -1 ? (player.config.i18n.qualityLabel['-1'] || 'Auto') : `${quality}p`);
        button.textContent = label;

        // Plyr automatically handles clicks on these buttons and triggers 'onChange'
        listItem.appendChild(button);
        qualityList.appendChild(listItem);
    });

    // Disable the quality button if only 'Auto' or no options exist.
    qualityButton.disabled = qualityOptions.length <= 1;

    console.log(`[Player] Plyr quality menu updated. Button disabled: ${qualityButton.disabled}`);
}

/**
 * Updates the text label of the main quality settings button.
 */
 function updateQualityButtonLabel(currentQuality) {
     if (!player || !player.elements.settings?.buttons?.quality) {
         // console.warn("[Player] Cannot update quality button label: Button not found.");
         return;
     }

     const qualityButton = player.elements.settings.buttons.quality;
     const labelSpan = qualityButton.querySelector('.plyr__menu__value'); // Plyr's standard span for the value

     if (labelSpan) {
         const label = player.config.i18n.qualityLabel[currentQuality]
                     || (currentQuality === -1 ? (player.config.i18n.qualityLabel['-1'] || 'Auto') : `${currentQuality}p`);
         labelSpan.textContent = label;
        // console.log(`[Player] Quality button label updated to: ${label}`);
     } else {
         // console.warn("[Player] Span (.plyr__menu__value) for quality button label not found.");
     }
 }

/**
 * Destroys Plyr and HLS.js instances.
 */
export function destroyPlayer() {
    console.log("[Player] Attempting to destroy player instances...");
    if (hls) {
        hls.destroy();
        hls = null;
        console.log("[Player] HLS instance destroyed.");
    }
    if (player) {
        player.destroy();
        player = null;
        console.log("[Player] Plyr instance destroyed.");
    }
    currentQualityLevelMap = {};
    isUpdatingQualityInternally = false;
}