import { t } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';

export function initBackgroundPictureInPicture() {
    const documentPip = window.top === window && typeof window.documentPictureInPicture?.requestWindow === 'function'
        ? window.documentPictureInPicture : undefined;
    let video = document.createElement('video');
    const standardVideo = document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function';
    const status = document.getElementById('background_pip_status');
    function showStatus(message) {
        status.textContent = message;
        status.hidden = false;
    }
    if (!documentPip && !standardVideo && typeof video.webkitSetPresentationMode !== 'function') {
        showStatus(window.isSecureContext
            ? t`Picture-in-Picture is unavailable in this browser or is disabled for this site.`
            : t`To use Picture-in-Picture, open SillyTavern over HTTPS or use localhost on the device running it.`);
        return;
    }

    const automatic = /** @type {HTMLInputElement} */ (document.getElementById('background_pip_auto'));
    const openButton = /** @type {HTMLButtonElement} */ (document.getElementById('background_pip_open'));
    automatic.checked = accountStorage.getItem('autoPictureInPicture') !== 'false';
    automatic.disabled = false;
    openButton.disabled = false;

    let pipWindow = null;
    let opening = null;
    let videoExit = null;
    let requestedBy = null;
    let pageActive = true;
    let automaticBlocked = false;
    let hintShown = false;

    let metadataReady;
    let nextVideo = null;
    if (!documentPip) {
        metadataReady = prepareVideo(video);
        document.body.append(video);
    }

    function prepareVideo(player) {
        const ready = new Promise(resolve => {
            player.addEventListener('loadedmetadata', resolve, { once: true });
            player.addEventListener('error', resolve, { once: true });
            player.addEventListener('abort', resolve, { once: true });
        });
        player.hidden = true;
        player.muted = true;
        player.playsInline = true;
        player.loop = true;
        player.preload = 'metadata';
        player.src = '/img/picture-in-picture.mp4';
        player.addEventListener('leavepictureinpicture', () => {
            if (player === video) onVideoLeave();
        });
        player.addEventListener('webkitpresentationmodechanged', () => {
            if (player !== video) return;
            if (player.webkitPresentationMode !== 'picture-in-picture') onVideoLeave();
            else {
                if (opening?.waitingForVideoMode) opening = null;
                if (!requestedBy) closeWindow();
            }
        });
        return ready;
    }

    function replaceVideo() {
        const previous = video;
        const needsExit = document.pictureInPictureElement === previous && !videoExit;
        video = nextVideo.player;
        metadataReady = nextVideo.ready;
        nextVideo = null;
        opening = null;
        videoExit = null;
        if (needsExit) document.exitPictureInPicture().catch(error => console.debug('Could not close previous Picture-in-Picture', error));
        previous.replaceWith(video);
        previous.pause();
        previous.removeAttribute('src');
        previous.load();
    }

    function videoIsOpen() {
        return document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture';
    }

    function finishVideoExit(exit) {
        if (videoExit !== exit) return;
        videoExit = null;
        if (requestedBy) openWindow(requestedBy);
    }

    function onVideoLeave() {
        // A late leave event can belong to the previous session on this same video element.
        if (videoIsOpen()) return;
        if (videoExit) finishVideoExit(videoExit);
        else if (!opening) {
            requestedBy = null;
            status.hidden = true;
            video.pause();
            if (nextVideo) replaceVideo();
        }
    }

    async function closeWindow() {
        requestedBy = null;
        opening = null;
        status.hidden = true;
        if (documentPip) {
            const win = pipWindow;
            pipWindow = null;
            win?.close();
            return;
        }
        video.pause();
        if (videoExit || !videoIsOpen()) return;
        const exit = {};
        videoExit = exit;
        try {
            if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
            else {
                video.webkitSetPresentationMode('inline');
                // WebKit can keep reporting PiP until its presentation mode change event.
                if (videoIsOpen()) return;
            }
        } catch (error) {
            console.debug('Could not close Picture-in-Picture', error);
        }
        finishVideoExit(exit);
    }

    async function openWindow(source = 'automatic') {
        if (source === 'automatic' && (!pageActive || !automatic.checked)) return;
        if (source === 'manual') {
            if (documentPip && (opening || pipWindow)) closeWindow();
            // Chrome can keep the old player as its PiP element after Android has dismissed the activity.
            // Requesting PiP for that same element only returns the old session.
            if (nextVideo) replaceVideo();
            showStatus(t`Requesting Picture-in-Picture. If no window appears, tap again to retry.`);
        }
        if (source === 'manual' || !requestedBy) requestedBy = source;
        if (opening && (source === 'automatic' || !opening.waitingForVideoMode)) return;
        // Chromium can keep returning the previous window after close(). Only our live window satisfies a click.
        if ((pipWindow && !pipWindow.closed) || videoIsOpen()) {
            if (source === 'manual' && !videoExit) showStatus(t`The browser accepted the Picture-in-Picture request.`);
            return;
        }
        if (source === 'automatic' && (document.pictureInPictureElement?.isConnected || (documentPip?.window && !documentPip.window.closed))) return;
        // Once the old video has left PiP, use this click's activation even if exitPictureInPicture() is still pending.
        videoExit = null;
        const attempt = { waitingForVideoMode: false };
        opening = attempt;
        try {
            if (documentPip) {
                const win = await documentPip.requestWindow({ width: 320, height: 180 });
                if (opening !== attempt) {
                    if (win !== pipWindow) win.close();
                    return;
                }
                pipWindow = win;
                win.addEventListener('pagehide', () => {
                    if (pipWindow === win) {
                        pipWindow = null;
                        requestedBy = null;
                        status.hidden = true;
                    }
                }, { once: true });
                const doc = win.document;
                doc.title = 'SillyTavern';
                doc.body.style.cssText = 'margin: 0; height: 100vh; display: grid; place-items: center; background: #202124';
                const logo = doc.createElement('img');
                logo.src = new URL('/img/logo.png', document.baseURI).href;
                logo.alt = 'SillyTavern';
                logo.style.height = '62vh';
                doc.body.append(logo);
            } else {
                const player = video;
                if (standardVideo && !nextVideo) {
                    // Keep one paused player with metadata ready for the next tap's user activation.
                    const next = document.createElement('video');
                    nextVideo = { player: next, ready: prepareVideo(next) };
                }
                // Hidden tabs may defer play() until PiP opens. Only the video metadata is required.
                player.play().catch(error => console.debug('Picture-in-Picture playback', error));
                if (player.readyState === player.HAVE_NOTHING) await metadataReady;
                if (opening !== attempt) return;
                if (standardVideo) {
                    await player.requestPictureInPicture();
                    if (player !== video) {
                        if (document.pictureInPictureElement === player) await document.exitPictureInPicture();
                        return;
                    }
                } else if (video.webkitSupportsPresentationMode?.('picture-in-picture') !== false) {
                    video.webkitSetPresentationMode('picture-in-picture');
                    attempt.waitingForVideoMode = !videoIsOpen();
                } else {
                    throw new Error('Video Picture-in-Picture is unavailable');
                }
                if (!requestedBy) await closeWindow();
            }
            if (opening === attempt) {
                automaticBlocked = false;
                if (source === 'manual') showStatus(t`The browser accepted the Picture-in-Picture request.`);
            }
        } catch (error) {
            if (opening !== attempt) return;
            if (!documentPip) video.pause();
            console.debug('Could not open Picture-in-Picture', error);
            if (requestedBy === 'manual') {
                showStatus(t`Picture-in-Picture could not open. Check whether your browser allows it for this site.`);
            } else {
                automaticBlocked = true;
            }
            requestedBy = null;
        } finally {
            if (opening === attempt && !attempt.waitingForVideoMode) opening = null;
        }
    }

    function setMediaAction() {
        try {
            navigator.mediaSession?.setActionHandler('enterpictureinpicture', automatic.checked ? () => openWindow() : null);
        } catch {
            // Some browsers implement Media Session without the PiP action.
        }
    }

    if (automatic.checked) setMediaAction();
    automatic.addEventListener('change', () => {
        accountStorage.setItem('autoPictureInPicture', String(automatic.checked));
        setMediaAction();
        automaticBlocked = false;
        if (!automatic.checked) closeWindow();
    });
    openButton.addEventListener('click', () => openWindow('manual'));
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            openWindow();
            return;
        }
        if (automaticBlocked && !hintShown) {
            hintShown = true;
            toastr.info(t`Your browser blocked automatic Picture-in-Picture. Before switching away, use “Open Picture-in-Picture now” in User Settings → Miscellaneous.`);
        }
    });
    window.addEventListener('pagehide', () => {
        pageActive = false;
        automaticBlocked = false;
        closeWindow();
    });
    window.addEventListener('pageshow', () => { pageActive = true; });
}
