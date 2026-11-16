import { sha256 } from '../../../lib.js';
import * as core from '../../../script.js';
import { getContext } from '../../st-context.js';
import { getRegexedString, regex_placement } from '../regex/engine.js';
import { RECOVERY_TYPES, RECOVERY_VERSION, chatFingerprintInput, markTask, planRecovery } from '../../util/generation-recovery.js';

const BASE = '/api/backends/chat-completions/recovery';
const CANCEL_KEY = 'generation-recovery-cancel-requests';
const clientId = getContext().uuidv4();
const localTasks = new Map();
const warned = new Set();
let activeId;
let timer;
let polling = false;
let restoring = false;
let internalStop = false;
let panel;

function currentChat() {
    const ctx = getContext();
    if (ctx.groupId || !ctx.chatId || !ctx.characters[ctx.characterId]) return null;
    return { avatar: ctx.characters[ctx.characterId].avatar, fileName: ctx.chatId };
}
function sameChat(left, right) {
    return Boolean(left && right && left.avatar === right.avatar && left.fileName === right.fileName);
}
function busy() {
    const stop = document.querySelector('#mes_stop');
    const editor = document.querySelector('#chat .edit_textarea');
    return Boolean(core.is_send_press || (stop && getComputedStyle(stop).display !== 'none') || (editor && editor.offsetParent !== null));
}
function notifyOnce(key, message, level = 'warning') {
    if (warned.has(key)) return;
    warned.add(key);
    toastr[level](message, '断线恢复');
}
async function jsonRequest(url, method = 'GET', body, options = {}) {
    // A stale recovery HTTP connection must not leave the polling loop permanently locked.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await fetch(url, {
            method, cache: 'no-store', headers: getContext().getRequestHeaders(),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options, signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw Object.assign(new Error(data?.error?.message || `HTTP ${response.status}`), { status: response.status });
        return data;
    } finally { clearTimeout(timeout); }
}
function pendingCancels() {
    try {
        const value = JSON.parse(getContext().accountStorage.getItem(CANCEL_KEY) || '{}');
        return value && !Array.isArray(value) && typeof value === 'object' ? value : {};
    } catch { return {}; }
}
function setCancels(value) {
    getContext().accountStorage.setItem(CANCEL_KEY, JSON.stringify(value));
}
function schedule(delay = 2000) {
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(() => void poll(), delay);
}
async function cancelTask(id) {
    const queued = pendingCancels();
    queued[id] ??= Date.now();
    setCancels(queued);
    try {
        await jsonRequest(`${BASE}/${id}/cancel`, 'POST', {}, { keepalive: true });
        const remaining = pendingCancels();
        delete remaining[id];
        setCancels(remaining);
        localTasks.delete(id);
    } catch (error) {
        if (error.status !== 404) notifyOnce(`cancel-${id}`, '停止请求暂未送达；后台可能仍在生成。恢复网络后会再次发送停止请求。');
    }
    schedule();
}
async function flushCancels() {
    for (const [id, requestedAt] of Object.entries(pendingCancels())) {
        try {
            await jsonRequest(`${BASE}/${id}/cancel`, 'POST', {});
            const queued = pendingCancels();
            delete queued[id];
            setCancels(queued);
            localTasks.delete(id);
        } catch (error) {
            // A stop can race the initial generate POST. Do not treat its first 404 as success.
            if (error.status === 404 && Date.now() - requestedAt > 10 * 60 * 1000) {
                const queued = pendingCancels();
                delete queued[id];
                setCancels(queued);
            }
        }
    }
}

async function prepareGeneration(data) {
    const ctx = getContext();
    const type = data.type || 'normal';
    const chat = currentChat();
    if (!chat || !RECOVERY_TYPES.includes(type) || data.chat_completion_source !== 'vertexai'
        || (data.vertexai_auth_mode || 'express') !== 'express' || data.tools?.length || data.request_images) return;
    if (restoring) throw new Error('A reply is being restored. Please wait for it to appear before generating.');
    // The server verifies this durable baseline before calling the model.
    await ctx.saveChat();
    if (!sameChat(chat, currentChat())) throw new Error('The chat changed before generation started.');
    const messages = getContext().chat;
    if (!messages.length) return;
    const id = ctx.uuidv4();
    const context = {
        version: RECOVERY_VERSION, type, chat,
        characterName: ctx.name2,
        baseLength: messages.length,
        baseHash: sha256(chatFingerprintInput(messages)),
        prefixHash: sha256(chatFingerprintInput(messages.slice(0, -1))),
        baseLast: ['continue', 'swipe'].includes(type) ? structuredClone(messages[messages.length - 1]) : undefined,
    };
    data.generation_recovery = { id, context };
    localTasks.set(id, { context, stream: Boolean(data.stream), lastActivity: Date.now() });
    activeId = id;
    schedule();
}

function markCurrentMessage(messageId, final = false) {
    const task = localTasks.get(activeId);
    if (!task || !sameChat(task.context.chat, currentChat())) return;
    const ctx = getContext();
    const target = task.context.type === 'normal' || task.context.type === 'regenerate' ? task.context.baseLength : task.context.baseLength - 1;
    const index = messageId ?? target;
    if (index !== target || !ctx.chat[index] || ctx.chat[index].is_user) return;
    const stream = ctx.streamingProcessor;
    const complete = final && (!task.stream || (stream?.isFinished && !stream?.isStopped && !stream?.abortController?.signal.aborted));
    markTask(ctx.chat[index], activeId, Boolean(complete));
    task.lastActivity = Date.now();
    if (final) schedule();
}

async function restoreTask(task, automatic = false) {
    if (restoring || busy() || !sameChat(task.context.chat, currentChat())) return;
    if (pendingCancels()[task.id]) return;
    restoring = true;
    const chat = currentChat();
    try {
        // Verify BOTH local and disk history. Do not overwrite unsaved edits or another tab's new messages.
        const { task: detail, reply } = await jsonRequest(`${BASE}/${task.id}/result`);
        const disk = await jsonRequest('/api/chats/get', 'POST', { avatar_url: chat.avatar, file_name: chat.fileName });
        if (!sameChat(chat, currentChat()) || busy()) return;
        planRecovery(getContext().chat, detail.context, task.id, sha256);
        planRecovery(disk.slice(1), detail.context, task.id, sha256);
        if (reply.hasTools || reply.hasImages) throw new Error('这条结果含工具调用或生成媒体，不能自动恢复；可先查看保存的正文。');
        const { token } = await jsonRequest(`${BASE}/${task.id}/claim`, 'POST', { client: clientId });
        if (!sameChat(chat, currentChat()) || busy()) return;
        const isContinue = detail.context.type === 'continue';
        let text = isContinue ? (detail.context.baseLast.mes ?? '') + reply.text : reply.text;
        let reasoning = getRegexedString(reply.reasoning, regex_placement.REASONING);
        // Use ST's output cleanup where exported, with a conservative regex fallback.
        if (typeof core.cleanUpMessage === 'function') {
            text = core.cleanUpMessage({ getMessage: text, isImpersonate: false, isContinue, displayIncompleteSentences: false });
        } else {
            text = getRegexedString(text, regex_placement.AI_OUTPUT);
        }
        if (getContext().powerUserSettings.trim_spaces) { text = text.trim(); reasoning = reasoning.trim(); }
        await jsonRequest(`${BASE}/${task.id}/apply`, 'POST', { token, text, reasoning });
        localTasks.delete(task.id);
        if (activeId === task.id) activeId = undefined;
        if (sameChat(chat, currentChat())) await getContext().reloadCurrentChat();
        toastr.success('已将最终回复恢复到原聊天，未重新调用模型。', '断线恢复');
    } catch (error) {
        // A short server-side lease/grace period is expected during normal delivery.
        if (error.status === 410 || (error.status === 409 && /original client|Another tab|lease expired/.test(error.message))) return;
        if (!automatic || !warned.has(task.id)) notifyOnce(task.id, error.message);
    } finally { restoring = false; }
}

async function poll() {
    if (polling || document.hidden) return;
    polling = true;
    let tasks = [];
    try {
        await flushCancels();
        ({ tasks } = await jsonRequest(BASE));
        renderTasks(tasks);
        const knownIds = new Set(tasks.map(task => task.id));
        if (!busy()) {
            for (const [id, local] of localTasks) {
                if (!knownIds.has(id) && Date.now() - local.lastActivity > 60000) localTasks.delete(id);
            }
        }
        for (const task of tasks) {
            if (task.status !== 'completed' || pendingCancels()[task.id]) continue;
            // ACK is accepted only if the server finds the completed task marker in the originating JSONL.
            try {
                await jsonRequest(`${BASE}/${task.id}/ack`, 'POST', {});
                localTasks.delete(task.id);
                if (activeId === task.id) activeId = undefined;
                continue;
            } catch (error) { if (error.status !== 409 && error.status !== 404) throw error; }
            const local = localTasks.get(task.id);
            if (busy() && activeId === task.id && Date.now() - task.updatedAt > 15000
                && Date.now() - (local?.lastActivity ?? 0) > 15000 && sameChat(task.context.chat, currentChat())) {
                // Only abort the stale browser reader, not the already-completed server task.
                activeId = undefined;
                internalStop = true;
                try { getContext().stopGeneration(); } finally { internalStop = false; }
                schedule();
                continue;
            }
            await restoreTask(task, true);
        }
    } catch (error) {
        console.debug('Generation recovery is waiting for the server:', error.message);
    } finally {
        polling = false;
        if (tasks.length || localTasks.size || Object.keys(pendingCancels()).length) schedule(tasks.some(t => t.status === 'running') ? 5000 : 15000);
    }
}

function button(label, handler) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'menu_button';
    element.textContent = label;
    element.addEventListener('click', () => void Promise.resolve().then(handler).catch(error => toastr.error(error.message, '断线恢复')));
    return element;
}
function renderTasks(tasks) {
    if (!panel) return;
    const list = panel.querySelector('.generation-recovery-list');
    list.replaceChildren();
    if (!tasks.length) { list.textContent = '没有待恢复的任务。'; return; }
    for (const task of tasks) {
        const row = document.createElement('div');
        row.style.marginBottom = '0.75em';
        const title = document.createElement('div');
        title.textContent = `${task.context.chat.fileName} · ${task.status}`;
        row.append(title);
        if (task.error) {
            const error = document.createElement('small');
            error.textContent = task.error;
            row.append(error);
        }
        if (task.status === 'running') row.append(button('停止后台生成', () => cancelTask(task.id)));
        if (task.status === 'completed') {
            const restore = button('恢复到当前聊天', () => restoreTask(task));
            restore.disabled = !sameChat(task.context.chat, currentChat());
            row.append(restore, button('查看保存的正文', async () => {
                const { reply } = await jsonRequest(`${BASE}/${task.id}/result`);
                const preview = document.createElement('textarea');
                preview.readOnly = true;
                preview.value = reply.text;
                preview.rows = 12;
                preview.style.width = '100%';
                row.append(preview);
            }));
        }
        if (task.status !== 'running') row.append(button('丢弃缓存', async () => {
            if (!window.confirm('只删除这条后台任务的缓存，不删除聊天记录。确定继续？')) return;
            await jsonRequest(`${BASE}/${task.id}/discard`, 'POST', {});
            localTasks.delete(task.id);
            schedule(0);
        }));
        list.append(row);
    }
}
function mountPanel() {
    if (panel) return;
    const parent = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!parent) return;
    panel = document.createElement('div');
    panel.className = 'inline-drawer';
    panel.innerHTML = '<div class="inline-drawer-toggle inline-drawer-header"><b>断线恢复 / Generation recovery</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><small>Vertex AI 快速模式：浏览器断线后继续生成，回到原聊天时恢复最终文本。支持普通回复、重生成、续写、滑动重抽；不接管群聊、后台 quiet 请求、工具调用或生成媒体。完成结果缓存 24 小时。</small><div class="generation-recovery-controls"></div><div class="generation-recovery-list"></div></div>';
    panel.querySelector('.generation-recovery-controls').append(button('立即检查', () => poll()));
    parent.append(panel);
}

const { eventSource, eventTypes } = getContext();
eventSource.on(eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
    if (!dryRun && type !== 'quiet') activeId = undefined;
});
eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, prepareGeneration);
eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, () => markCurrentMessage());
eventSource.on(eventTypes.MESSAGE_RECEIVED, id => markCurrentMessage(Number(id), true));
eventSource.on(eventTypes.MESSAGE_EDITED, id => {
    const message = getContext().chat[Number(id)];
    if (message?.extra?.generation_task_id && !message.extra.generation_task_complete) message.extra.generation_task_edited = true;
});
eventSource.on(eventTypes.GENERATION_STOPPED, () => {
    if (!internalStop && activeId && localTasks.has(activeId)) void cancelTask(activeId);
});
eventSource.on(eventTypes.GENERATION_ENDED, () => schedule());
eventSource.on(eventTypes.CHAT_CHANGED, () => schedule());
eventSource.on(eventTypes.APP_READY, () => { mountPanel(); schedule(); });
window.addEventListener('online', () => schedule());
window.addEventListener('focus', () => schedule());
document.addEventListener('visibilitychange', () => schedule());
mountPanel();
schedule();
