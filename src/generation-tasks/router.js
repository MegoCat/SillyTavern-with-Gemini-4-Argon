import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { GenerationTaskStore, hash, taskError, writePrivateFile } from './store.js';
import { buildRecoveredMessage, chatFingerprintInput, hasCompletedTask, parseVertexReply, planRecovery } from '../../public/scripts/util/generation-recovery.js';
import { registerToolRoutes } from './tool-round.js';

const stores = new Map();
const streamEndEvent = 'generation-complete';

function checkedPlan(messages, context, id) {
    try { return planRecovery(messages, context, id, hash); } catch (error) { throw taskError(error.message, 409); }
}

function storeFor(request) {
    // Never accept an owner or a storage path from the client.
    const root = request.user?.directories?.root ?? (request.user?.directories?.chats && path.dirname(request.user.directories.chats));
    if (!root || !request.user?.profile?.handle) throw taskError('Authentication required.', 401);
    const directory = path.join(root, 'generation-tasks');
    if (!stores.has(directory)) stores.set(directory, new GenerationTaskStore(directory));
    return stores.get(directory);
}

function readTaskChat(request, record, sanitize) {
    const root = fs.realpathSync(request.user.directories.chats);
    const { avatar, fileName } = record.context.chat;
    const filename = path.resolve(root, avatar.replace('.png', ''), sanitize(`${fileName}.jsonl`));
    if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename)) throw taskError('The original chat was renamed or deleted. The reply was kept.', 409);
    if (!fs.realpathSync(filename).startsWith(root + path.sep)) throw taskError('Invalid chat path.', 400);
    const raw = fs.readFileSync(filename, 'utf8');
    const rows = raw.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    if (!rows.length || !rows[0].chat_metadata) throw taskError('The original chat header is invalid. No data was changed.', 409);
    return { filename, header: rows[0], messages: rows.slice(1), raw };
}

function writeTaskChat(request, task, saved) {
    const content = [saved.header, ...saved.messages].map(row => JSON.stringify(row)).join('\n');
    if (content === saved.raw) return;
    const directory = request.user.directories.backups;
    fs.mkdirSync(directory, { recursive: true });
    const backup = path.join(directory, `recovery-${task.id}.jsonl`);
    if (!fs.existsSync(backup)) writePrivateFile(backup, saved.raw);
    writePrivateFile(saved.filename, content);
}

/** Client disconnection only detaches this subscriber; it never closes the virtual upstream socket. */
export function attachTaskResponse(store, record, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Generation-Task-Id', record.id);
    const sink = store.live.get(record.id);
    const headers = () => {
        if (response.headersSent || response.destroyed) return;
        response.statusCode = sink?.statusCode ?? record.responseStatus;
        const streaming = record.stream && response.statusCode < 400;
        response.setHeader('Content-Type', streaming ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8');
        if (streaming) response.setHeader('X-Generation-Stream-End', streamEndEvent);
        response.setHeader('X-Accel-Buffering', 'no');
    };
    // A proxy can close a partial HTTP stream cleanly. Only signal success after the final result is stored.
    const end = () => response.end(record.stream && record.status === 'completed' ? `\n\nevent: ${streamEndEvent}\ndata: [DONE]\n\n` : undefined);
    if (!sink) {
        if (record.acknowledged || record.status !== 'completed') return response.status(409).json({ error: { message: record.error || `Task is ${record.status}.` } });
        headers();
        response.write(store.result(record.id));
        return end();
    }
    const cleanup = () => {
        sink.off('chunk', onChunk);
        sink.off('terminal', onTerminal);
        response.off('close', cleanup);
        response.off('error', cleanup);
    };
    const onChunk = (chunk) => {
        if (response.destroyed) { cleanup(); return; }
        // A suspended phone must not backpressure the model or grow an unbounded outgoing queue.
        if (response.writableLength > 1024 * 1024) { cleanup(); response.destroy(); return; }
        headers();
        response.write(chunk);
        response.flush?.();
    };
    const onTerminal = (result) => {
        cleanup();
        if (response.destroyed) return;
        if (result.status === 'cancelled' || (result.status === 'failed' && sink.statusCode < 400)) { response.destroy(); return; }
        headers();
        end();
    };
    sink.on('chunk', onChunk);
    sink.once('terminal', onTerminal);
    response.on('close', cleanup);
    response.on('error', cleanup);
    for (const chunk of sink.chunks) onChunk(chunk);
}

/** Register before the original router; all non-opted-in requests retain their original behavior. */
export function buildGenerationRecoveryRouter(backendRouter, makeRouter, sanitize) {
    const router = makeRouter();
    const route = handler => async (request, response, next) => {
        try {
            response.setHeader('Cache-Control', 'no-store');
            await handler(request, response, next);
        } catch (error) {
            if (response.headersSent) { response.destroy(); return; }
            const status = Number.isInteger(error.status) ? error.status : 500;
            if (status === 500) console.error('Generation recovery:', error);
            response.status(status).json({ error: { message: error.message || 'Generation recovery failed.' } });
        }
    };

    registerToolRoutes(router, route, storeFor, (req, task) => readTaskChat(req, task, sanitize), writeTaskChat);

    router.get('/recovery', route((req, res) => res.json({ tasks: storeFor(req).list() })));
    router.get('/recovery/:id', route((req, res) => {
        const store = storeFor(req);
        res.json(store.summary(store.require(req.params.id), true));
    }));
    router.get('/recovery/:id/result', route((req, res) => {
        const store = storeFor(req);
        const task = store.require(req.params.id);
        if (task.status !== 'completed') throw taskError(task.error || 'No final reply is available.', 409);
        res.json({ task: store.summary(task, true), reply: parseVertexReply(store.result(task.id).toString('utf8'), task.stream, task.context) });
    }));
    router.post('/recovery/:id/cancel', route((req, res) => {
        const store = storeFor(req);
        res.json(store.summary(store.cancel(req.params.id)));
    }));
    router.post('/recovery/:id/claim', route((req, res) => {
        res.json({ token: storeFor(req).claim(req.params.id, req.body?.client) });
    }));
    router.post('/recovery/:id/ack', route((req, res) => {
        const store = storeFor(req);
        const task = store.require(req.params.id);
        const { messages } = readTaskChat(req, task, sanitize);
        const index = messages.findIndex(message => hasCompletedTask(message, task.id));
        if (index < 0) throw taskError('The reply has not been saved to the original chat yet.', 409);
        if (task.toolRound) throw taskError('A tool round must finish before acknowledgement.', 409);
        if (!task.acknowledged) store.acknowledge(task.id);
        if (req.body?.includeMessage && index === messages.length - 1) {
            const prefixHash = task.context.baseLast ? task.context.prefixHash : task.context.baseHash;
            if (hash(chatFingerprintInput(messages.slice(0, index))) === prefixHash) {
                return res.json({ ok: true, index, message: messages[index] });
            }
        }
        res.json({ ok: true });
    }));
    router.post('/recovery/:id/discard', route((req, res) => {
        storeFor(req).acknowledge(req.params.id);
        res.json({ ok: true });
    }));
    router.post('/recovery/:id/apply', route((req, res) => {
        const store = storeFor(req);
        const task = store.require(req.params.id);
        if (task.toolRound || task.status !== 'completed') throw taskError('Only a completed result can be restored.', 409);
        const saved = readTaskChat(req, task, sanitize);
        const edit = checkedPlan(saved.messages, task.context, task.id);
        if (edit.kind === 'already') {
            store.acknowledge(task.id);
            return res.json({ ok: true, alreadySaved: true });
        }
        store.checkLease(task.id, req.body?.token);
        const reply = parseVertexReply(store.result(task.id).toString('utf8'), task.stream, task.context);
        const { text, reasoning } = req.body ?? {};
        if (!reply.firstToolCall && (typeof text !== 'string' || typeof reasoning !== 'string'
            || Buffer.byteLength(text + reasoning) > store.options.maxBytes)) throw taskError('Invalid restored message.');
        const context = { ...task.context };
        if (context.baseLast && saved.messages[edit.index]) {
            const original = context.baseLast;
            const current = saved.messages[edit.index];
            context.baseLast = {
                ...original, ...current,
                mes: original.mes, swipes: original.swipes, swipe_id: original.swipe_id,
                swipe_info: original.swipe_info,
                extra: { ...original.extra, ...current.extra, reasoning: original.extra?.reasoning, reasoning_signature: original.extra?.reasoning_signature },
            };
        }
        const message = buildRecoveredMessage(context, reply, task, reply.firstToolCall ? undefined : { text, reasoning });
        if (edit.kind === 'append') saved.messages.push(message);
        else saved.messages[edit.index] = message;
        // No await between reading/checking and replacing the file: the operation is atomic in this server process.
        writeTaskChat(req, task, saved);
        // If acknowledgement fails, the message marker makes a retry idempotent.
        store.acknowledge(task.id);
        res.json({ ok: true, index: edit.index, ...(req.body.includeMessage ? { message } : {}) });
    }));

    router.post('/generate', route((req, res, next) => {
        const recovery = req.body?.generation_recovery;
        if (!recovery) return next();
        if (req.body.chat_completion_source !== 'vertexai' || (req.body.vertexai_auth_mode || 'express') !== 'express'
            || req.body.request_images) throw taskError('Recovery requires a Vertex AI Express text request.');
        if (req.body.tools != null && !Array.isArray(req.body.tools)) throw taskError('Invalid function tool declarations.');
        if (recovery.context?.captureFirstToolCall && (!req.body.tools?.length || recovery.parentId)) throw taskError('First function call recovery requires an initial request with tools.');
        if (req.body.tools?.length && recovery.context?.toolDepth === undefined && !recovery.context?.captureFirstToolCall) throw taskError('Tool recovery was not enabled for this request.');
        const body = { ...req.body };
        delete body.generation_recovery;
        if ((body.type || 'normal') !== recovery.context?.type) throw taskError('Recovery generation type does not match the request.');
        if (Buffer.byteLength(JSON.stringify(body)) > 32 * 1024 * 1024) throw taskError('This request is too large for background recovery.', 413);
        const store = storeFor(req);
        const existing = store.get(recovery.id);
        const parent = recovery.parentId && store.require(recovery.parentId);
        if (!existing) {
            if (parent && (parent.status !== 'completed' || parent.acknowledged || parent.toolRound?.nextId !== recovery.id
                || parent.toolRound.committedHash !== recovery.context?.baseHash || parent.context.chat.avatar !== recovery.context?.chat?.avatar
                || parent.context.chat.fileName !== recovery.context?.chat?.fileName || parent.model !== body.model
                || body.type !== 'normal' || recovery.context.toolDepth !== parent.context.toolDepth + 1)) {
                throw taskError('The tool follow-up no longer matches the saved conversation.', 409);
            }
            // Normal delivery may already be saved before the browser's acknowledgement poll runs.
            // Do not make immediate follow-up/auto-continue requests wait for that poll.
            for (const previous of store.records.values()) {
                if (previous.status !== 'completed' || previous.acknowledged || previous.toolRound
                    || previous.context.chat.avatar !== recovery.context?.chat?.avatar
                    || previous.context.chat.fileName !== recovery.context?.chat?.fileName) continue;
                const saved = readTaskChat(req, previous, sanitize);
                if (saved.messages.some(message => hasCompletedTask(message, previous.id))) store.acknowledge(previous.id);
            }
            const running = [...stores.values()].reduce((sum, item) => sum + item.live.size, 0);
            if (running >= 16) throw taskError('The background generation limit was reached.', 429);
        }
        if (parent && !existing) {
            const saved = readTaskChat(req, parent, sanitize);
            if (saved.messages.at(-1)?.extra?.generation_tool_parent !== parent.id
                || hash(chatFingerprintInput(saved.messages)) !== parent.toolRound.committedHash) throw taskError('The saved tool transcript has changed.', 409);
        }
        // create validates metadata and writes it before an upstream request can incur charges.
        const { record, created } = store.create(recovery.id, recovery.context, body, parent);
        if (!created) return attachTaskResponse(store, record, res);
        try {
            const saved = readTaskChat(req, record, sanitize);
            checkedPlan(saved.messages, record.context, record.id);
        } catch (error) {
            store.cancel(record.id);
            store.acknowledge(record.id);
            throw error;
        }
        if (parent) store.acknowledge(parent.id);
        const sink = store.makeResponse(record.id);
        const detached = Object.assign(new EventEmitter(), {
            method: 'POST', url: '/generate', originalUrl: '/generate', baseUrl: '',
            body, user: req.user, headers: { ...req.headers }, app: req.app,
            query: {}, params: {}, socket: sink.socket, connection: sink.socket,
            get(name) { return this.headers[name.toLowerCase()]; },
        });
        sink.req = detached;
        sink.locals = {};
        detached.res = sink;
        attachTaskResponse(store, record, res);
        setImmediate(() => {
            if (record.status !== 'running') return;
            try {
                backendRouter.handle(detached, sink, error => {
                    if (record.status === 'running') sink.destroy(error || new Error('The generation handler did not produce a response.'));
                });
            } catch (error) { sink.destroy(error); }
        });
    }));
    router.use(backendRouter);
    return router;
}
