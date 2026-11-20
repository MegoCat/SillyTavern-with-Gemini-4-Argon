import { expect, test } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

async function setHidden(page, hidden) {
    await page.evaluate(value => {
        Object.defineProperty(document, 'hidden', { configurable: true, value });
        document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
}

async function openSettingsDrawer(page, selector) {
    const onboarding = page.locator('dialog[open]').filter({ has: page.locator('.onboarding') });
    await page.addLocatorHandler(onboarding, dialog => dialog.locator('.popup-button-ok').click());
    await testSetup.awaitST({ page });
    const drawer = page.locator(selector);
    if (!await drawer.locator(':scope > .drawer-content').isVisible()) {
        await drawer.locator(':scope > .drawer-toggle').click();
    }
}

test.beforeEach(async ({ page }) => {
    await page.route('**/api/settings/save', route => route.fulfill({ json: { ok: true } }));
});

test('coalesces tab and media requests and closes a window granted after returning', async ({ page }) => {
    await page.addInitScript(() => {
        const pip = {
            window: null,
            requests: 0,
            requestWindow() {
                this.requests++;
                return new Promise(resolve => {
                    this.grant = () => {
                        this.window = Object.assign(new EventTarget(), {
                            document: document.implementation.createHTMLDocument(),
                            close: () => { this.window = null; },
                        });
                        resolve(this.window);
                    };
                });
            },
        };
        Object.defineProperty(window, 'documentPictureInPicture', { value: pip });
        Object.defineProperty(navigator, 'mediaSession', { value: {
            setActionHandler(action, callback) {
                if (action === 'enterpictureinpicture') this.enter = callback;
            },
        } });
    });
    await openSettingsDrawer(page, '#user-settings-button');
    await page.locator('#background_pip_auto').check();
    await setHidden(page, true);
    await page.evaluate(() => navigator.mediaSession.enter());
    expect(await page.evaluate(() => window.documentPictureInPicture.requests)).toBe(1);
    await setHidden(page, false);
    await page.evaluate(() => window.documentPictureInPicture.grant());
    expect(await page.evaluate(() => window.documentPictureInPicture.window)).toBeNull();

    await setHidden(page, true);
    await page.evaluate(() => window.documentPictureInPicture.grant());
    expect(await page.evaluate(() => window.documentPictureInPicture.window.document.title)).toBe('SillyTavern');
    await setHidden(page, false);
    expect(await page.evaluate(() => window.documentPictureInPicture.window)).toBeNull();

    await page.evaluate(() => document.getElementById('background_pip_auto').click());
    await setHidden(page, true);
    expect(await page.evaluate(() => window.documentPictureInPicture.requests)).toBe(2);
    expect(await page.evaluate(() => navigator.mediaSession.enter)).toBeNull();

    await setHidden(page, false);
    await page.locator('#background_pip_auto').check();
    await setHidden(page, true);
    const grantPrevious = await page.evaluateHandle(() => window.documentPictureInPicture.grant);
    await setHidden(page, false);
    await page.locator('#background_pip_open').click();
    await grantPrevious.evaluate(grant => grant());
    expect(await page.evaluate(() => window.documentPictureInPicture.window)).toBeNull();
    await page.evaluate(() => window.documentPictureInPicture.grant());
    expect(await page.evaluate(() => window.documentPictureInPicture.window.document.title)).toBe('SillyTavern');
});

test('a foreground click reopens document PiP while the browser still reports the closed window', async ({ page }) => {
    await page.addInitScript(() => {
        const pip = {
            window: null,
            requests: 0,
            async requestWindow() {
                this.requests++;
                const win = Object.assign(new EventTarget(), {
                    document: document.implementation.createHTMLDocument(),
                    closed: false,
                    close() { this.closed = true; },
                });
                this.window = win;
                return win;
            },
        };
        Object.defineProperty(window, 'documentPictureInPicture', { value: pip });
    });
    await openSettingsDrawer(page, '#user-settings-button');
    const button = page.locator('#background_pip_open');
    await button.click();
    await setHidden(page, true);
    await setHidden(page, false);
    const oldWindow = await page.evaluateHandle(() => window.documentPictureInPicture.window);
    expect(await oldWindow.evaluate(win => win.closed)).toBe(true);
    await button.click();
    expect(await page.evaluate(() => window.documentPictureInPicture.requests)).toBe(2);
    await oldWindow.evaluate(win => win.dispatchEvent(new Event('pagehide')));
    await setHidden(page, true);
    await setHidden(page, false);
    expect(await page.evaluate(() => window.documentPictureInPicture.window.closed)).toBe(true);
    await button.click();
    expect(await page.evaluate(() => window.documentPictureInPicture.requests)).toBe(3);
});

test('a denied background video request can be opened by a click, and pauses on return', async ({ page }) => {
    await page.addInitScript(() => {
        let active = null;
        let needsClick = true;
        Object.defineProperty(window, 'documentPictureInPicture', { value: undefined });
        Object.defineProperty(document, 'pictureInPictureEnabled', { value: true });
        Object.defineProperty(document, 'pictureInPictureElement', { get: () => active });
        HTMLVideoElement.prototype.requestPictureInPicture = async function () {
            if (needsClick && document.hidden) throw new DOMException('Click required', 'NotAllowedError');
            needsClick = false;
            active = this;
        };
        document.exitPictureInPicture = () => new Promise(resolve => {
            window.finishVideoExit = () => { active = null; resolve(); };
        });
    });
    await openSettingsDrawer(page, '#user-settings-button');
    await page.locator('#background_pip_auto').check();
    const video = page.locator('video[src="/img/picture-in-picture.mp4"]');
    await expect.poll(() => video.evaluate(el => el.readyState)).toBeGreaterThan(0);
    await setHidden(page, true);
    await setHidden(page, false);
    const buttonLabel = await page.locator('#background_pip_open small').textContent();
    await expect(page.locator('.toast-info').filter({ hasText: buttonLabel })).toHaveCount(1);
    await page.locator('#background_pip_open').click();
    expect(await video.evaluate(el => document.pictureInPictureElement === el)).toBe(true);
    await setHidden(page, true);
    await setHidden(page, false);
    await setHidden(page, true);
    await page.evaluate(() => window.finishVideoExit());
    await expect.poll(() => video.evaluate(el => document.pictureInPictureElement === el && !el.paused)).toBe(true);
    await setHidden(page, false);
    await page.evaluate(() => window.finishVideoExit());
    expect(await video.evaluate(el => el.paused && !document.pictureInPictureElement)).toBe(true);
});

for (const { api, requestsBeforeExit } of [{ api: 'standard', requestsBeforeExit: 2 }, { api: 'webkit', requestsBeforeExit: 1 }]) {
    test(`reopens ${api} video PiP across a delayed exit on return`, async ({ page }) => {
        await page.addInitScript(api => {
            let active = null;
            const state = { opens: 0, finishExit: null };
            window.pipTest = state;
            Object.defineProperty(window, 'documentPictureInPicture', { value: undefined });
            Object.defineProperty(document, 'pictureInPictureEnabled', { value: api === 'standard' });
            const proto = HTMLVideoElement.prototype;
            if (api === 'standard') {
                Object.defineProperty(document, 'pictureInPictureElement', { get: () => active });
                proto.requestPictureInPicture = async function () {
                    active = this;
                    state.opens++;
                };
                document.exitPictureInPicture = () => new Promise(resolve => {
                    const leaving = active;
                    active = null;
                    state.finishExit = () => {
                        leaving.dispatchEvent(new Event('leavepictureinpicture'));
                        resolve();
                    };
                });
            } else {
                Object.defineProperty(proto, 'webkitPresentationMode', { get() { return active === this ? 'picture-in-picture' : 'inline'; } });
                proto.webkitSetPresentationMode = function (mode) {
                    const changed = () => this.dispatchEvent(new Event('webkitpresentationmodechanged'));
                    if (mode === 'inline') {
                        state.finishExit = () => {
                            active = null;
                            changed();
                            changed(); // The previous inline notification can arrive again before the next entry.
                        };
                        return;
                    }
                    state.opens++;
                    queueMicrotask(() => { active = this; changed(); });
                };
            }
        }, api);
        await openSettingsDrawer(page, '#user-settings-button');
        const button = page.locator('#background_pip_open');
        await button.click();
        await expect.poll(() => page.evaluate(() => window.pipTest.opens)).toBe(1);
        await setHidden(page, true);
        await setHidden(page, false);
        await button.click();
        expect(await page.evaluate(() => window.pipTest.opens)).toBe(requestsBeforeExit);
        await page.evaluate(() => window.pipTest.finishExit());
        await expect.poll(() => page.evaluate(() => window.pipTest.opens)).toBe(2);
        await expect.poll(() => page.locator('video[src="/img/picture-in-picture.mp4"]').evaluate(el => el.paused)).toBe(false);
    });
}

for (const { secure, reason } of [
    { secure: true, reason: 'Picture-in-Picture is unavailable in this browser or is disabled for this site.' },
    { secure: false, reason: 'To use Picture-in-Picture, open SillyTavern over HTTPS or use localhost on the device running it.' },
]) {
    test(`keeps the PiP settings visible without a browser API (secure context: ${secure})`, async ({ page }) => {
        await page.addInitScript(isSecure => {
            Object.defineProperty(window, 'isSecureContext', { value: isSecure });
            Object.defineProperty(window, 'documentPictureInPicture', { value: undefined });
            Object.defineProperty(document, 'pictureInPictureEnabled', { value: false });
            Object.defineProperty(HTMLVideoElement.prototype, 'webkitSetPresentationMode', { value: undefined });
        }, secure);
        await openSettingsDrawer(page, '#user-settings-button');
        const controls = page.locator('[name="MiscellaneousToggles"] #background_pip_controls');
        await expect(controls).toBeVisible();
        await expect(controls.getByRole('checkbox')).toBeDisabled();
        await expect(controls.getByRole('button')).toBeDisabled();
        const localized = await page.evaluate(async key => (await import('/scripts/i18n.js')).translate(key), reason);
        await expect(controls.getByRole('status')).toHaveText(localized);
        await expect(page.locator('video[src="/img/picture-in-picture.mp4"]')).toHaveCount(0);
    });
}

test('a stale discovery response cannot load the retired recovery panel', async ({ page }) => {
    const legacyRequests = [];
    page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (path.includes('/generation-recovery/') || path.startsWith('/api/backends/chat-completions/recovery')) legacyRequests.push(path);
    });
    await page.route('**/api/extensions/discover', async route => {
        const response = await route.fetch();
        const extensions = await response.json();
        await route.fulfill({ response, json: [...extensions, { name: 'generation-recovery', type: 'system' }] });
    });
    await openSettingsDrawer(page, '#extensions-settings-button');
    await expect(page.locator('#rm_extensions_block .generation-recovery-tools')).toHaveCount(0);
    await page.locator('#extensions_details').click();
    const manager = page.locator('.extensions_info');
    await expect(manager).toContainText('Regex');
    await expect(manager).not.toContainText('Generation recovery');
    expect(legacyRequests).toEqual([]);
});
