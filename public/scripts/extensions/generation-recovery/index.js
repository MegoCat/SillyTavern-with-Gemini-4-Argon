import { sha256 } from '../../../lib.js';
import * as core from '../../../script.js';
import { getContext } from '../../st-context.js';
import { accountsEnabled, currentUser, getCurrentUserHandle } from '../../user.js';
import { getRegexedString, regex_placement } from '../regex/engine.js';
import { RECOVERY_TYPES, RECOVERY_VERSION, chatFingerprintInput, markTask, planRecovery } from '../../util/generation-recovery.js';

const BASE = '/api/backends/chat-completions/recovery';
const CANCEL_KEY = 'generation-recovery-cancel-requests';
const TOOL_SETTING = 'generation-recovery-tools';
const pendingToolResults = new Map();
const pendingToolStarts = new Map();
let toolWorker;
let stoppingTool;
let followupParent;
const clientId = getContext().uuidv4();
const localTasks = new Map();
const warned = new Set();
let activeId;
let timer;
let polling = false;
let checkAgain = false;
let retryDelay = 2000;
let restoring = false;
let pendingApply;
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
        if (!response.ok) {
            const data = await response.json().catch(() => null);
            throw Object.assign(new Error(data?.error?.message || `HTTP ${response.status}`), { status: response.status });
        }
        return await response.json();
    } finally { clearTimeout(timeout); }
}
function legacyCancels() {
    try {
        const value = JSON.parse(getContext().accountStorage.getItem(CANCEL_KEY) || '{}');
        return value && !Array.isArray(value) && typeof value === 'object' ? value : {};
    } catch { return {}; }
}
function cancelPrefix() {
    if (accountsEnabled && !currentUser) throw new Error('The current account handle is unavailable.');
    return `${CANCEL_KEY}:${encodeURIComponent(getCurrentUserHandle())}:`;
}
function pendingCancels() {
    const queued = legacyCancels();
    try {
        const prefix = cancelPrefix();
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(prefix)) queued[key.slice(prefix.length)] = Number(localStorage.getItem(key));
        }
    } catch { /* Account storage is the fallback when browser storage is unavailable. */ }
    return queued;
}
function forgetCancel(id) {
    try { localStorage.removeItem(cancelPrefix() + id); } catch { /* Browser storage is unavailable. */ }
    const queued = legacyCancels();
    if (Object.hasOwn(queued, id)) {
        delete queued[id];
        getContext().accountStorage.setItem(CANCEL_KEY, JSON.stringify(queued));
    }
}
function schedule(delay = 2000) {
    clearTimeout(timer);
    timer = undefined;
    if (!document.hidden) timer = setTimeout(() => { timer = undefined; void poll(); }, delay);
}
async function deliverCancel(id, requestedAt, keepalive = false) {
    try {
        await jsonRequest(`${BASE}/${id}/cancel`, 'POST', {}, { keepalive });
        forgetCancel(id);
        forgetToolResult(id);
        pendingToolStarts.delete(id);
        localTasks.delete(id);
    } catch (error) {
        // The original generate POST can arrive after its cancel request.
        if (error.status === 404 && Date.now() - requestedAt > 10 * 60 * 1000) forgetCancel(id);
        if (keepalive && error.status !== 404) notifyOnce(`cancel-${id}`, '停止请求暂未送达；后台可能仍在生成。恢复网络后会再次发送停止请求。');
    }
}
async function cancelTask(id) {
    if (id === toolWorker || id === followupParent) stoppingTool = id;
    const requestedAt = Date.now();
    try {
        // AccountStorage saves to the server. A separate local key per task survives an offline reload and concurrent tabs.
        localStorage.setItem(cancelPrefix() + id, String(requestedAt));
    } catch {
        getContext().accountStorage.setItem(CANCEL_KEY, JSON.stringify({ ...legacyCancels(), [id]: requestedAt }));
    }
    await deliverCancel(id, requestedAt, true);
    schedule(0);
}

async function prepareGeneration(data, toolTurn) {
    const ctx = getContext();
    const type = data.type || 'normal';
    const chat = currentChat();
    const parent = toolTurn?.parent;
    const trackTools = toolsEnabled() && toolTurn && (toolTurn.allowed || parent);
    if (parent && (stoppingTool === parent.id || pendingCancels()[parent.id] || !trackTools || !sameChat(parent.chat, chat) || parent.history !== historyHash(ctx.chat)
        || parent.model !== data.model || data.chat_completion_source !== 'vertexai' || (data.vertexai_auth_mode || 'express') !== 'express' || data.request_images)) {
        throw new Error('请在原聊天使用原来的 Vertex AI 快速模式和模型继续工具调用。');
    }
    if (!chat || !RECOVERY_TYPES.includes(type) || data.chat_completion_source !== 'vertexai'
        || (data.vertexai_auth_mode || 'express') !== 'express' || (data.tools?.length && !trackTools) || data.request_images) return;
    if (restoring || sameChat(pendingApply?.context.chat, chat)) throw new Error('上一条回复正在恢复，请等它显示后再生成。');
    // The server verifies the baseline. For a follow-up it already wrote the tool transcript itself.
    if (!parent) await ctx.saveChat();
    if (!sameChat(chat, currentChat())) throw new Error('聊天已切换，本次生成已取消。');
    const messages = getContext().chat;
    if (!messages.length) return;
    if (parent && parent.history !== historyHash(messages)) throw new Error('工具记录已改变。');
    const id = parent?.nextId ?? ctx.uuidv4();
    const context = {
        version: RECOVERY_VERSION, type, chat,
        ...(trackTools ? { toolDepth: toolTurn.depth } : {}),
        characterName: ctx.name2,
        baseLength: messages.length,
        baseHash: sha256(chatFingerprintInput(messages)),
        prefixHash: sha256(chatFingerprintInput(messages.slice(0, -1))),
        baseLast: ['continue', 'swipe'].includes(type) ? structuredClone(messages[messages.length - 1]) : undefined,
    };
    data.generation_recovery = { id, context, ...(parent ? { parentId: parent.id } : {}) };
    if (trackTools) toolTurn.handle = () => runToolRound({ id, context, model: data.model });
    localTasks.set(id, { context, parentId: parent?.id, stream: Boolean(data.stream), lastActivity: Date.now() });
    activeId = id;
    const stream = ctx.streamingProcessor;
    if (data.stream && stream) {
        // A continuation or swipe can create its placeholder and disconnect before the first token.
        stream.abortController.signal.addEventListener('abort', () => {
            if (activeId === id) markCurrentMessage(stream.messageId);
        }, { once: true });
    }
    schedule();
}

function markCurrentMessage(messageId, final = false) {
    const task = localTasks.get(activeId);
    if (!task || (toolWorker && task.context.toolDepth !== undefined) || !sameChat(task.context.chat, currentChat())) return;
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

async function showSavedReply(task, saved) {
    if (sameChat(task.context.chat, currentChat())) {
        if (busy()) return;
        // A user may have edited the chat while the apply request was in flight.
        let edit;
        try {
            edit = planRecovery(getContext().chat, task.context, task.id, sha256);
        } catch {
            pendingApply = undefined;
            notifyOnce(`reload-${task.id}`, '最终回复已写入原聊天。当前页面有其他修改，已保留编辑现场。');
            return;
        }
        if (edit.kind !== 'already') {
            if (saved.message && saved.index === edit.index) {
                const viewport = document.querySelector('#chat');
                const atBottom = viewport && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 5;
                getContext().chat[edit.index] = saved.message;
                await core.redisplayChat({ startIndex: edit.index, fade: false });
                if (atBottom) core.scrollChatToBottom({ waitForFrame: true });
            } else {
                // A different tab may already have added more messages. Load its complete saved history.
                await getContext().reloadCurrentChat();
            }
        }
        toastr.success('已将最终回复恢复到原聊天，未重新调用模型。', '断线恢复');
    }
    pendingApply = undefined;
}

function cleanReply(context, reply) {
    const isContinue = context.type === 'continue';
    let text = isContinue ? (context.baseLast.mes ?? '') + reply.text : reply.text;
    let reasoning = getRegexedString(reply.reasoning, regex_placement.REASONING);
    // Use ST's output cleanup where exported, with a conservative regex fallback.
    if (typeof core.cleanUpMessage === 'function') {
        text = core.cleanUpMessage({ getMessage: text, isImpersonate: false, isContinue, displayIncompleteSentences: false });
    } else {
        text = getRegexedString(text, regex_placement.AI_OUTPUT);
    }
    if (getContext().powerUserSettings.trim_spaces) { text = text.trim(); reasoning = reasoning.trim(); }
    return { text, reasoning };
}

function toolsEnabled() {
    return getContext().accountStorage.getItem(TOOL_SETTING) === 'true';
}

const historyHash = messages => sha256(chatFingerprintInput(messages));
function toolResultPrefix() {
    if (accountsEnabled && !currentUser) throw new Error('The current account handle is unavailable.');
    return `generation-recovery-result:${encodeURIComponent(getCurrentUserHandle())}:`;
}
const toolResultKey = id => toolResultPrefix() + id;

function loadToolResult(id) {
    try {
        return pendingToolResults.get(id) || JSON.parse(localStorage.getItem(toolResultKey(id)));
    } catch { return pendingToolResults.get(id); }
}
function rememberToolResult(id, value) {
    pendingToolResults.set(id, value);
    try { localStorage.setItem(toolResultKey(id), JSON.stringify(value)); } catch { /* A large result can still be delivered from this tab. */ }
}
function forgetToolResult(id) {
    pendingToolResults.delete(id);
    try { localStorage.removeItem(toolResultKey(id)); } catch { /* Storage is optional. */ }
}

/** Align only this turn's own streaming placeholder and transcript with the durable chat. */
async function alignToolChat(task, state) {
    const ctx = getContext();
    const hash = historyHash(ctx.chat);
    if (hash === state.history) return;
    if (state.committed && ctx.chat.at(-1)?.extra?.generation_tool_parent === task.id
        && historyHash(ctx.chat.slice(0, -1)) === state.history && historyHash(ctx.chat.slice(-1)) === historyHash([state.committed])) return;
    const edit = planRecovery(ctx.chat, task.context, task.id, sha256);
    const replacement = state.intermediate ? [state.intermediate] : [];
    if (edit.kind === 'already' || edit.index !== state.index || historyHash([...ctx.chat.slice(0, edit.index), ...replacement]) !== state.history) {
        throw new Error('聊天记录已改变，请打开保存了工具结果的原聊天。');
    }
    ctx.chat.splice(edit.index, ctx.chat.length - edit.index, ...replacement);
    await core.redisplayChat({ startIndex: edit.index, fade: false });
}

async function runToolRound(task) {
    if (toolWorker) return;
    const id = task.id;
    toolWorker = id;
    const post = (action, body) => jsonRequest(`${BASE}/${id}/tools/${action}`, 'POST', body);
    const checkCurrent = () => {
        const ctx = getContext();
        if (stoppingTool === id) throw new Error('工具任务已停止。');
        if (!sameChat(task.context.chat, currentChat()) || !toolsEnabled() || pendingCancels()[id]) throw new Error('工具恢复已暂停，请回到原聊天并启用恢复工具调用。');
        if (ctx.mainApi !== 'openai' || !ctx.canPerformToolCalls('normal') || ctx.chatCompletionSettings.chat_completion_source !== 'vertexai'
            || (ctx.chatCompletionSettings.vertexai_auth_mode || 'express') !== 'express' || ctx.getChatCompletionModel() !== task.model) {
            throw new Error('请切回原来的 Vertex AI 快速模式、模型及函数调用设置。');
        }
    };
    try {
        const previous = loadToolResult(id);
        if (previous) {
            try { await post('finish', previous); } catch (error) { if (error.status !== 409) throw error; }
            forgetToolResult(id);
        }
        checkCurrent();
        const { task: detail, reply } = await jsonRequest(`${BASE}/${id}/result`);
        if (!detail.tools || !reply.hasTools) throw new Error('没有待恢复的工具调用。');
        const output = cleanReply(detail.context, reply);
        checkCurrent();
        let state = await post('prepare', output);
        checkCurrent();
        await alignToolChat(detail, state);
        for (let index = state.completed; index < reply.toolCalls.length; index++) {
            const pendingStart = pendingToolStarts.get(id);
            if (state.running && pendingStart?.index !== index) return;
            checkCurrent();
            const call = reply.toolCalls[index];
            const manager = getContext().ToolManager;
            if (!await manager.isToolAvailable(call.name)) throw new Error(`请启用提供 ${call.name} 的扩展，然后恢复此任务。`);
            checkCurrent();
            if (historyHash(getContext().chat) !== state.history) throw new Error('聊天记录已改变，工具恢复已暂停。');
            const ticket = pendingStart?.index === index ? pendingStart.ticket : getContext().uuidv4();
            pendingToolStarts.set(id, { index, ticket });
            try {
                await post('start', { index, ticket, stealth: manager.isStealthTool(call.name) });
            } catch (error) {
                if (!isTransient(error)) pendingToolStarts.delete(id);
                throw error;
            }
            // Only a lost permission response is retriable. From here the action may have taken effect.
            pendingToolStarts.delete(id);
            checkCurrent();
            if (historyHash(getContext().chat) !== state.history) throw new Error('聊天记录已改变，工具恢复已暂停。');
            const data = [[{ id: call.id || `${id}-${index}`, function: { name: call.name, arguments: call.args }, signature: call.signature }]];
            const result = await manager.invokeFunctionTools(data, { reasoningText: output.reasoning });
            const invocation = result.invocations[0];
            if (result.stealthCalls.length && result.errors.length) manager.showToolCallError(result.errors);
            const stillInChat = sameChat(task.context.chat, currentChat());
            const receipt = {
                index, ticket, displayName: invocation?.displayName ?? call.name, result: invocation?.result ?? '',
                error: Boolean(result.errors.length), history: stillInChat ? historyHash(getContext().chat) : state.history,
            };
            rememberToolResult(id, receipt);
            // Some tools append their own message (for example, an image) before returning.
            if (stillInChat && receipt.history !== state.history) await getContext().saveChat();
            try {
                await post('finish', receipt);
            } catch (error) {
                if (error.status === 409) forgetToolResult(id);
                throw error;
            }
            forgetToolResult(id);
            state.history = receipt.history;
            state.running = null;
        }
        checkCurrent();
        pendingToolStarts.delete(id);
        state = await post('prepare', output);
        checkCurrent();
        await alignToolChat(detail, state);
        const ctx = getContext();
        const message = state.invocations.length ? ctx.ToolManager.createToolInvocationMessage(state.invocations) : undefined;
        const saved = await post('commit', { message: message && { name: message.name, force_avatar: message.force_avatar, mes: message.mes } });
        if (saved.stop) return;
        checkCurrent();
        const current = historyHash(ctx.chat);
        if (current !== saved.history) {
            if (current !== state.history) throw new Error('工具记录已保存，请回到原聊天继续。');
            ctx.chat.push(saved.message);
            await ctx.eventSource.emit(ctx.eventTypes.TOOL_CALLS_PERFORMED, saved.message.extra.tool_invocations);
            checkCurrent();
            ctx.addOneMessage(saved.message);
            await ctx.eventSource.emit(ctx.eventTypes.TOOL_CALLS_RENDERED, saved.message.extra.tool_invocations);
        }
        checkCurrent();
        if (historyHash(ctx.chat) !== saved.history) throw new Error('工具记录已改变。');
        return { id, nextId: saved.nextId, chat: task.context.chat, model: task.model, history: saved.history };
    } finally {
        toolWorker = undefined;
        schedule();
    }
}

async function restoreTask(task, automatic = false) {
    if (restoring || toolWorker || pendingApply || busy() || !sameChat(task.context.chat, currentChat())) return;
    if (pendingCancels()[task.id] || stoppingTool === task.id) return;
    if (task.tools) {
        if (task.tools.running && pendingToolStarts.get(task.id)?.index !== task.tools.running.index) pendingToolStarts.delete(task.id);
        if (!toolsEnabled() || getContext().onlineStatus === 'no_connection') return;
        if (task.tools.running && !loadToolResult(task.id) && !pendingToolStarts.has(task.id)) {
            if (Date.now() - task.updatedAt > 15000) notifyOnce(`tool-pending-${task.id}-${task.tools.running.index}`, `正在等待工具 ${task.tools.running.name} 的结果。若执行页面已关闭，可在扩展设置的「断线恢复」中跳过此工具。`);
            return;
        }
        followupParent = task.id;
        core.deactivateSendButtons();
        try {
            const parent = await runToolRound(task);
            if (parent) await core.Generate('normal', { automatic_trigger: true, depth: task.context.toolDepth + 1, toolRecoveryParent: parent });
        } catch (error) {
            if (!isTransient(error)) notifyOnce(`${task.id}-${error.message}`, error.message);
        } finally {
            followupParent = undefined;
            core.activateSendButtons();
            schedule(5000);
        }
        return;
    }
    restoring = true;
    const chat = currentChat();
    try {
        planRecovery(getContext().chat, task.context, task.id, sha256);
        const { token } = await jsonRequest(`${BASE}/${task.id}/claim`, 'POST', { client: clientId });
        const { task: detail, reply } = await jsonRequest(`${BASE}/${task.id}/result`);
        if (!sameChat(chat, currentChat()) || busy() || pendingCancels()[task.id]) return;
        // Recheck local edits after the network waits. /apply checks the on-disk history immediately before writing.
        planRecovery(getContext().chat, detail.context, task.id, sha256);
        if (reply.hasTools || reply.hasImages) throw new Error('这条结果含工具调用或生成媒体，不能自动恢复；可先查看保存的正文。');
        const { text, reasoning } = cleanReply(detail.context, reply);
        pendingApply = task;
        const saved = await jsonRequest(`${BASE}/${task.id}/apply`, 'POST', { token, text, reasoning, includeMessage: true });
        localTasks.delete(task.id);
        if (activeId === task.id) activeId = undefined;
        await showSavedReply(task, saved);
        schedule(0);
    } catch (error) {
        // A short server-side lease/grace period is expected during normal delivery.
        if (error.status === 409 && /original client/.test(error.message)) { schedule(3000); return; }
        if (error.status === 410 || (error.status === 409 && /Another tab|lease expired/.test(error.message))) return;
        if (!automatic || !isTransient(error)) notifyOnce(task.id, error.message);
    } finally { restoring = false; }
}

function isTransient(error) {
    return !error.status ? error.name === 'TypeError' || error.name === 'AbortError' || error.name === 'SyntaxError'
        : error.status >= 500 || [408, 429].includes(error.status);
}

async function confirmPendingApply() {
    const task = pendingApply;
    if (!task || restoring || busy()) return;
    if (!sameChat(task.context.chat, currentChat())) {
        pendingApply = undefined;
        return;
    }
    // /apply can commit even if its response never reaches this tab. Ask for the durably saved message.
    try {
        const saved = await jsonRequest(`${BASE}/${task.id}/ack`, 'POST', { includeMessage: true });
        await showSavedReply(task, saved);
    } catch (error) {
        if (error.status !== 404 && error.status !== 409) throw error;
        pendingApply = undefined;
    }
}

async function poll() {
    if (document.hidden) return;
    if (polling) { checkAgain = true; return; }
    polling = true;
    let nextDelay;
    try {
        for (const [id, requestedAt] of Object.entries(pendingCancels())) await deliverCancel(id, requestedAt);
        const { tasks } = await jsonRequest(BASE);
        renderTasks(tasks);
        await confirmPendingApply();
        const knownIds = new Set(tasks.map(task => task.id));
        for (const id of pendingToolStarts.keys()) if (!knownIds.has(id)) pendingToolStarts.delete(id);
        // Remove browser receipts after another tab discards a task or its server cache expires.
        try {
            const prefix = toolResultPrefix();
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const key = localStorage.key(i);
                if (key?.startsWith(prefix) && !knownIds.has(key.slice(prefix.length))) forgetToolResult(key.slice(prefix.length));
            }
        } catch { /* Storage is optional. */ }
        if (!busy()) {
            for (const [id, local] of localTasks) {
                if (!knownIds.has(id) && Date.now() - local.lastActivity > 60000) localTasks.delete(id);
            }
        }
        for (const task of tasks) {
            if (task.status !== 'running' && task.status !== 'completed') {
                localTasks.delete(task.id);
                continue;
            }
            if (task.status !== 'completed' || pendingCancels()[task.id]) continue;
            if (!task.tools) {
                // A text reply is acknowledged only after the marker reaches the original JSONL.
                try {
                    await jsonRequest(`${BASE}/${task.id}/ack`, 'POST', {});
                    localTasks.delete(task.id);
                    if (activeId === task.id) activeId = undefined;
                    schedule(0);
                    continue;
                } catch (error) { if (error.status !== 409 && error.status !== 404) throw error; }
            }
            if (toolWorker || followupParent === task.id) continue;
            const local = localTasks.get(task.id);
            if (busy() && activeId === task.id && Date.now() - task.updatedAt > 15000
                && Date.now() - (local?.lastActivity ?? 0) > 15000 && sameChat(task.context.chat, currentChat())) {
                // Only abort the stale browser reader, not the already-completed server task.
                const stream = getContext().streamingProcessor;
                if (local?.stream && stream) markCurrentMessage(stream.messageId);
                activeId = undefined;
                internalStop = true;
                try { getContext().stopGeneration(); } finally { internalStop = false; }
                schedule();
                continue;
            }
            if (task.tools) void restoreTask(task, true);
            else await restoreTask(task, true);
        }
        const awaitingRegistration = [...localTasks.keys()].some(id => !knownIds.has(id));
        if (pendingApply || awaitingRegistration || Object.keys(pendingCancels()).length || tasks.some(task => task.status === 'running')) nextDelay = 5000;
        else if (tasks.some(task => task.status === 'completed' && sameChat(task.context.chat, currentChat()))) nextDelay = 15000;
        retryDelay = 2000;
    } catch (error) {
        console.debug('Generation recovery is waiting for the server:', error.message);
        if (isTransient(error)) {
            nextDelay = retryDelay;
            retryDelay = Math.min(30000, retryDelay * 2);
        }
    } finally {
        polling = false;
        if (checkAgain) {
            checkAgain = false;
            schedule(0);
        } else if (timer === undefined && nextDelay !== undefined) schedule(nextDelay);
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
        const status = task.tools ? `工具已完成 ${task.tools.completed}/${task.tools.count}` : task.status;
        title.textContent = `${task.context.chat.fileName} · ${status}`;
        row.append(title);
        if (task.error) {
            const error = document.createElement('small');
            error.textContent = task.error;
            row.append(error);
        }
        if (task.status === 'running') row.append(button('停止后台生成', () => cancelTask(task.id)));
        if (task.status === 'completed') {
            const restore = button('恢复到当前聊天', () => restoreTask(task));
            restore.disabled = !sameChat(task.context.chat, currentChat()) || Boolean(task.tools && (!toolsEnabled() || (task.tools.running && !loadToolResult(task.id))));
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
        if (task.tools?.running) {
            const { index, name } = task.tools.running;
            const status = document.createElement('small');
            status.textContent = `正在等待工具 ${name} 的结果。`;
            row.append(status, button('跳过此工具并继续', async () => {
                if (!window.confirm(`请先确认执行 ${name} 的页面已经关闭。跳过后会告诉模型结果未知，迟到的结果会被忽略。继续吗？`)) return;
                await jsonRequest(`${BASE}/${task.id}/tools/skip`, 'POST', { index });
                forgetToolResult(task.id);
                pendingToolStarts.delete(task.id);
                schedule(0);
            }));
        }
        if (task.tools && task.status === 'completed') row.append(button('停止工具任务', () => cancelTask(task.id)));
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
    panel.innerHTML = '<div class="inline-drawer-toggle inline-drawer-header"><b>断线恢复 / Generation recovery</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><small>Vertex AI 快速模式：浏览器断线后继续生成，回到原聊天时恢复最终文本。支持普通回复、重生成、续写、滑动重抽；完成结果缓存 24 小时。</small><label class="checkbox_label"><input class="generation-recovery-tools" type="checkbox"><span>恢复工具调用</span></label><small>回到原聊天后继续执行待处理工具。已开始但结果未知的工具会暂停，等你处理。</small><div class="generation-recovery-controls"></div><div class="generation-recovery-list"></div></div>';
    const checkbox = panel.querySelector('.generation-recovery-tools');
    checkbox.checked = toolsEnabled();
    checkbox.addEventListener('change', () => {
        getContext().accountStorage.setItem(TOOL_SETTING, String(checkbox.checked));
        schedule(0);
    });
    panel.querySelector('.generation-recovery-controls').append(button('立即检查', () => poll()));
    parent.append(panel);
}

const { eventSource, eventTypes } = getContext();
eventSource.on(eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
    if (!dryRun && type !== 'quiet') activeId = options?.toolRecoveryParent?.id;
});
eventSource.on(eventTypes.CHAT_COMPLETION_REQUEST_READY, async (data, preparation, toolTurn) => {
    try {
        await prepareGeneration(data, toolTurn);
    } catch (error) {
        // EventEmitter logs listener exceptions and continues. Explicitly cancel before the model request is sent.
        preparation?.abort(error);
        toastr.error(error.message, '断线恢复');
    }
});
eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, () => markCurrentMessage());
eventSource.on(eventTypes.MESSAGE_RECEIVED, id => markCurrentMessage(Number(id), true));
eventSource.on(eventTypes.MESSAGE_EDITED, id => {
    const message = getContext().chat[Number(id)];
    if (message?.extra?.generation_task_id && !message.extra.generation_task_complete) message.extra.generation_task_edited = true;
});
eventSource.on(eventTypes.GENERATION_STOPPED, () => {
    if (internalStop) return;
    const task = localTasks.get(activeId);
    const id = toolWorker || (task && activeId) || followupParent;
    if (id) void cancelTask(id);
    if (task?.parentId && task.parentId !== id) void cancelTask(task.parentId);
});
eventSource.on(eventTypes.GENERATION_ENDED, () => schedule());
eventSource.on(eventTypes.CHAT_CHANGED, () => schedule(0));
eventSource.on(eventTypes.APP_READY, () => {
    mountPanel();
    if (panel) panel.querySelector('.generation-recovery-tools').checked = toolsEnabled();
    schedule();
});
window.addEventListener('online', () => schedule(0));
window.addEventListener('pageshow', () => schedule(0));
window.addEventListener('focus', () => schedule(0));
document.addEventListener('visibilitychange', () => schedule(0));
mountPanel();
schedule();
