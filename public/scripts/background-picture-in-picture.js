import { t } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';

export function initBackgroundPictureInPicture() {
    const documentPip = window.top === window && typeof window.documentPictureInPicture?.requestWindow === 'function'
        ? window.documentPictureInPicture : undefined;
    const video = document.createElement('video');
    const standardVideo = document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function';
    if (!documentPip && !standardVideo && typeof video.webkitSetPresentationMode !== 'function') {
        const status = document.getElementById('background_pip_status');
        status.textContent = window.isSecureContext
            ? t`Picture-in-Picture is unavailable in this browser or is disabled for this site.`
            : t`To use Picture-in-Picture, open SillyTavern over HTTPS or use localhost on the device running it.`;
        status.hidden = false;
        return;
    }

    const automatic = /** @type {HTMLInputElement} */ (document.getElementById('background_pip_auto'));
    const openButton = /** @type {HTMLButtonElement} */ (document.getElementById('background_pip_open'));
    automatic.checked = accountStorage.getItem('autoPictureInPicture') !== 'false';
    automatic.disabled = false;
    openButton.disabled = false;

    let pipWindow = null;
    let changing = false;
    let requestedBy = null;
    let pageActive = true;
    let automaticBlocked = false;
    let hintShown = false;

    let metadataReady;
    if (!documentPip) {
        // Preload a real video track so mobile browsers can enter PiP within the click handler.
        metadataReady = new Promise(resolve => {
            video.addEventListener('loadedmetadata', resolve, { once: true });
            video.addEventListener('error', resolve, { once: true });
        });
        video.hidden = true;
        video.muted = true;
        video.playsInline = true;
        video.loop = true;
        video.preload = 'auto';
        video.src = '/img/picture-in-picture.mp4';
        document.body.append(video);
        video.addEventListener('leavepictureinpicture', () => video.pause());
        video.addEventListener('webkitpresentationmodechanged', () => {
            if (video.webkitPresentationMode !== 'picture-in-picture') video.pause();
            else if (!requestedBy) closeWindow();
        });
    }

    async function closeWindow() {
        requestedBy = null;
        if (documentPip) {
            pipWindow?.close();
            pipWindow = null;
            return;
        }
        video.pause();
        if (changing || (document.pictureInPictureElement !== video && video.webkitPresentationMode !== 'picture-in-picture')) return;
        changing = true;
        try {
            if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
            else video.webkitSetPresentationMode('inline');
        } catch (error) {
            console.debug('Could not close Picture-in-Picture', error);
        } finally {
            changing = false;
            // The user may have switched away again while the browser was closing the video.
            if (requestedBy) await openWindow(requestedBy);
        }
    }

    async function openWindow(source = 'automatic') {
        if (!pageActive || (source === 'automatic' && !automatic.checked)) return;
        requestedBy = source;
        if (changing || documentPip?.window || document.pictureInPictureElement || video.webkitPresentationMode === 'picture-in-picture') return;
        changing = true;
        try {
            if (documentPip) {
                pipWindow = await documentPip.requestWindow({ width: 320, height: 180 });
                const doc = pipWindow.document;
                doc.title = 'SillyTavern';
                doc.body.style.cssText = 'margin: 0; height: 100vh; display: grid; place-items: center; background: #202124';
                const logo = doc.createElement('img');
                logo.src = new URL('/img/logo.png', document.baseURI).href;
                logo.alt = 'SillyTavern';
                logo.style.height = '62vh';
                doc.body.append(logo);
            } else {
                // Hidden tabs may defer play() until PiP opens. Only the video metadata is required.
                video.play().catch(error => console.debug('Picture-in-Picture playback', error));
                if (video.readyState === video.HAVE_NOTHING) await metadataReady;
                if (!requestedBy) return;
                if (standardVideo) await video.requestPictureInPicture();
                else if (video.webkitSupportsPresentationMode?.('picture-in-picture') !== false) video.webkitSetPresentationMode('picture-in-picture');
                else throw new Error('Video Picture-in-Picture is unavailable');
            }
            automaticBlocked = false;
        } catch (error) {
            if (!documentPip) video.pause();
            if (!requestedBy) return;
            console.debug('Could not open Picture-in-Picture', error);
            if (requestedBy === 'manual') toastr.warning(t`Picture-in-Picture could not open. Check whether your browser allows it for this site.`);
            else automaticBlocked = true;
        } finally {
            changing = false;
            // A request may resolve after the tab was restored, the setting disabled, or the page left.
            if (!requestedBy) await closeWindow();
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
        closeWindow();
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
