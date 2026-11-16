import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { parseVertexReply, RECOVERY_TYPES, RECOVERY_VERSION, stableStringify } from '../../public/scripts/util/generation-recovery.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DAY = 24 * 60 * 60 * 1000;

export function taskError(message, status = 400) {
    return Object.assign(new Error(message), { status });
}

export function validateId(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw taskError('Invalid generation task ID.');
    return id;
}

/** Atomic, private files. Prompts, API credentials and request headers are never persisted. */
export function writePrivateFile(filename, content) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, filename);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

export function validateContext(context) {
    if (!context || context.version !== RECOVERY_VERSION || !RECOVERY_TYPES.includes(context.type)) throw taskError('Unsupported recovery context.');
    const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 512
        && value !== '.' && value !== '..' && !/[\\/\x00]/.test(value);
    if (!safeName(context.chat?.avatar) || !safeName(context.chat?.fileName)) throw taskError('Invalid recovery chat.');
    if (!Number.isSafeInteger(context.baseLength) || context.baseLength < 1 || context.baseLength > 1000000) throw taskError('Invalid recovery history length.');
    if (![context.baseHash, context.prefixHash].every(value => /^[a-f0-9]{64}$/.test(value))) throw taskError('Invalid recovery history fingerprint.');
    if (typeof context.characterName !== 'string' || context.characterName.length > 512) throw taskError('Invalid recovery character name.');
    if (['continue', 'swipe'].includes(context.type) && (!context.baseLast || context.baseLast.is_user)) throw taskError('Recovery needs an assistant message to continue or swipe.');
    if (Buffer.byteLength(JSON.stringify(context)) > 1024 * 1024) throw taskError('Recovery metadata is too large.', 413);
    // Whitelist fields; do not accidentally persist request secrets added by an extension.
    return {
        version: RECOVERY_VERSION, type: context.type,
        chat: { avatar: context.chat.avatar, fileName: context.chat.fileName },
        baseLength: context.baseLength, baseHash: context.baseHash, prefixHash: context.prefixHash,
        characterName: context.characterName,
        baseLast: ['continue', 'swipe'].includes(context.type) ? structuredClone(context.baseLast) : undefined,
    };
}

/** A bounded per-user spool. Only final results survive a server restart. */
export class GenerationTaskStore {
    constructor(directory, options = {}) {
        this.directory = directory;
        this.options = { retention: DAY, maxRunning: 4, maxPending: 64, maxBytes: 16 * 1024 * 1024, maxStoredBytes: 128 * 1024 * 1024, ...options };
        this.records = new Map();
        this.live = new Map();
        this.leases = new Map();
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        for (const file of fs.readdirSync(directory)) {
            if (!file.endsWith('.json') || !UUID.test(file.slice(0, -5))) continue;
            try {
                const record = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
                if (record.id !== file.slice(0, -5)) continue;
                if (record.status === 'running') {
                    record.status = 'interrupted';
                    record.error = 'The SillyTavern server restarted while generating. No automatic model retry was made.';
                    record.updatedAt = Date.now();
                    this.persist(record);
                }
                this.records.set(record.id, record);
            } catch (error) {
                console.warn(`Could not load recovery task ${file}: ${error.message}`);
            }
        }
        this.prune();
    }

    file(id, suffix = 'json') { return path.join(this.directory, `${validateId(id)}.${suffix}`); }
    persist(record) { writePrivateFile(this.file(record.id), JSON.stringify(record)); }
    get(id) { return this.records.get(validateId(id)); }
    require(id) {
        const record = this.get(id);
        if (!record) throw taskError('Generation task not found.', 404);
        return record;
    }
    summary(record, full = false) {
        const summary = { ...record };
        delete summary.fingerprint;
        if (!full) {
            summary.context = { ...summary.context };
            delete summary.context.baseLast;
        }
        return summary;
    }
    list() {
        this.prune();
        return [...this.records.values()].filter(record => !record.acknowledged).map(record => this.summary(record));
    }
    prune() {
        const now = Date.now();
        const tombstones = [...this.records.values()].filter(record => record.acknowledged).sort((a, b) => b.updatedAt - a.updatedAt);
        const excess = new Set(tombstones.slice(512).map(record => record.id));
        for (const record of this.records.values()) {
            if (record.status === 'running' || (now - record.updatedAt < this.options.retention && !excess.has(record.id))) continue;
            for (const suffix of ['body', 'json']) fs.rmSync(this.file(record.id, suffix), { force: true });
            this.records.delete(record.id);
            this.leases.delete(record.id);
        }
    }
    create(id, context, requestBody) {
        validateId(id);
        context = validateContext(context);
        const fingerprint = hash(stableStringify({ context, requestBody }));
        const existing = this.get(id);
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw taskError('This task ID was already used for a different request.', 409);
            return { record: existing, created: false };
        }
        this.prune();
        const pending = [...this.records.values()].filter(record => !record.acknowledged);
        const running = pending.filter(record => record.status === 'running');
        if (running.length >= this.options.maxRunning) throw taskError('Too many background generations. Stop an existing task first.', 429);
        if (pending.length >= this.options.maxPending || pending.reduce((sum, record) => sum + (record.status === 'running' ? this.options.maxBytes : (record.bytes ?? 0)), 0) + this.options.maxBytes > this.options.maxStoredBytes) {
            throw taskError('Recovery storage is full. Restore or discard pending replies before generating again.', 507);
        }
        if (pending.some(record => ['running', 'completed'].includes(record.status)
            && record.context.chat.avatar === context.chat.avatar && record.context.chat.fileName === context.chat.fileName)) {
            throw taskError('This chat already has an unfinished or unrecovered generation. Recover or stop it before generating again.', 409);
        }
        const record = {
            id, context, fingerprint, status: 'running', stream: Boolean(requestBody.stream),
            model: String(requestBody.model ?? ''), createdAt: Date.now(), updatedAt: Date.now(),
            bytes: 0, responseStatus: 200, acknowledged: false,
        };
        this.persist(record);
        this.records.set(id, record);
        return { record, created: true };
    }
    makeResponse(id) {
        const record = this.require(id);
        const sink = new TaskResponse(record, this);
        this.live.set(id, sink);
        return sink;
    }
    finish(id, sink, error = null) {
        const record = this.require(id);
        if (record.status !== 'running') return;
        const body = Buffer.concat(sink.chunks);
        record.responseStatus = sink.statusCode;
        record.bytes = body.length;
        try {
            if (!error && sink.statusCode >= 400) error = new Error(`The model request failed (HTTP ${sink.statusCode}).`);
            if (!error) parseVertexReply(body.toString('utf8'), record.stream);
        } catch (parseError) { error = parseError; }
        record.status = error ? 'failed' : 'completed';
        record.updatedAt = Date.now();
        if (error) record.error = String(error.message || error).slice(0, 1000);
        try {
            writePrivateFile(this.file(id, 'body'), body);
            this.persist(record);
        } catch (storageError) {
            record.status = 'failed';
            record.error = `Could not persist the generated reply: ${storageError.message}`;
            console.error(record.error);
        }
        this.live.delete(id);
        sink.emit('terminal', record);
        sink.chunks = [];
        if (error) sink.socket.emit('close');
    }
    result(id) {
        const record = this.require(id);
        if (record.status === 'running') throw taskError('Generation is still running.', 409);
        if (record.acknowledged) throw taskError('This result was already acknowledged.', 410);
        return fs.readFileSync(this.file(id, 'body'));
    }
    cancel(id) {
        const record = this.require(id);
        if (record.acknowledged || record.status === 'cancelled') return record;
        record.status = 'cancelled';
        record.updatedAt = Date.now();
        this.persist(record);
        const sink = this.live.get(id);
        this.live.delete(id);
        if (sink) {
            sink.socket.emit('close');
            sink.emit('terminal', record);
            sink.destroy();
            sink.chunks = [];
        }
        this.leases.delete(id);
        return record;
    }
    acknowledge(id) {
        const record = this.require(id);
        if (record.status === 'running') throw taskError('Stop a running task before discarding it.', 409);
        record.acknowledged = true;
        record.updatedAt = Date.now();
        this.persist(record);
        fs.rmSync(this.file(id, 'body'), { force: true });
        this.leases.delete(id);
    }
    claim(id, client) {
        validateId(client);
        const record = this.require(id);
        if (record.status !== 'completed' || record.acknowledged) throw taskError('No completed result is available.', 409);
        // Give the original response handler a chance to save before another tab restores it.
        if (Date.now() - record.updatedAt < 3000) throw taskError('The original client may still be saving this reply.', 409);
        const existing = this.leases.get(id);
        if (existing && existing.expires > Date.now() && existing.client !== client) throw taskError('Another tab is restoring this reply.', 409);
        const lease = { client, token: existing?.client === client ? existing.token : randomUUID(), expires: Date.now() + 30000 };
        this.leases.set(id, lease);
        return lease.token;
    }
    checkLease(id, token) {
        const lease = this.leases.get(id);
        if (!lease || lease.token !== token || lease.expires < Date.now()) throw taskError('Recovery lease expired. Please retry.', 409);
    }
}

/** An independent writable response; a browser socket is never used by the upstream request. */
export class TaskResponse extends Writable {
    constructor(record, store) {
        super({ autoDestroy: false });
        this.record = record;
        this.store = store;
        this.socket = new EventEmitter();
        this.chunks = [];
        this.bytes = 0;
        this.statusCode = 200;
        this.headersSent = false;
        this.headers = new Map();
        this.once('finish', () => store.finish(record.id, this));
        this.on('error', error => store.finish(record.id, this, error));
        this.on('pipe', source => {
            source.once('error', error => this.destroy(error));
            source.once('close', () => {
                if (!source.readableEnded && record.status === 'running') this.destroy(new Error('The upstream connection closed before the response finished.'));
            });
        });
    }
    status(code) { this.statusCode = code; return this; }
    setHeader(name, value) { this.headers.set(name.toLowerCase(), value); return this; }
    getHeader(name) { return this.headers.get(name.toLowerCase()); }
    set(name, value) { return this.setHeader(name, value); }
    json(body) { this.setHeader('content-type', 'application/json'); this.end(JSON.stringify(body)); return this; }
    send(body) { return typeof body === 'object' && !Buffer.isBuffer(body) ? this.json(body) : (this.end(body), this); }
    sendStatus(code) { return this.status(code).send(String(code)); }
    _write(chunk, encoding, callback) {
        if (this.record.status !== 'running') { callback(); return; }
        const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding);
        if (this.bytes + bytes.length > this.store.options.maxBytes) { callback(new Error('The recovery response size limit was exceeded.')); return; }
        this.headersSent = true;
        this.bytes += bytes.length;
        this.chunks.push(bytes);
        this.emit('chunk', bytes);
        callback();
    }
}
