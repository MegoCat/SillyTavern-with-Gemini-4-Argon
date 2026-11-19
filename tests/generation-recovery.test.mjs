import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once, EventEmitter } from 'node:events';
import { Writable, PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { GenerationTaskStore, hash, validateContext } from '../src/generation-tasks/store.js';
import { buildGenerationRecoveryRouter } from '../src/generation-tasks/router.js';
import { stableStringify, chatFingerprintInput, parseVertexReply, planRecovery, buildRecoveredMessage, markTask, hasCompletedTask } from '../public/scripts/util/generation-recovery.js';

const userMessage = () => ({ name: 'User', is_user: true, mes: 'Hello', send_date: '2026-11-16T08:00:00Z', extra: {} });
const assistantMessage = () => ({ name: 'Character', is_user: false, mes: 'Before', send_date: '2026-11-16T08:00:01Z', extra: { reasoning: 'Old reasoning. ' }, swipe_id: 0, swipes: ['Before'], swipe_info: [{ extra: {} }] });
const replyJSON = () => JSON.stringify({ choices: [{ message: { content: 'Hello 世界' } }], responseContent: { parts: [{ thought: true, text: 'Thinking' }, { text: 'Hello 世界', thoughtSignature: 'opaque-signature==' }] } });
const sse = (text, final = true) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text, thoughtSignature: 'signature==' }] }, ...(final ? { finishReason: 'STOP' } : {}) }] })}\n\n`;
function context(messages = [userMessage()], type = 'normal', fileName = 'Chat') {
    return { version: 1, type, chat: { avatar: 'Character.png', fileName }, characterName: 'Character', baseLength: messages.length,
        baseHash: hash(chatFingerprintInput(messages)), prefixHash: hash(chatFingerprintInput(messages.slice(0, -1))),
        baseLast: ['continue', 'swipe'].includes(type) ? structuredClone(messages.at(-1)) : undefined };
}
function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-recovery-'));
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    return { root, store: new GenerationTaskStore(path.join(root, 'generation-tasks'), options) };
}
async function finish(store, id, body = replyJSON()) {
    const sink = store.makeResponse(id);
    const ended = once(sink, 'finish');
    sink.end(body);
    await ended;
    return sink;
}

test('fingerprints ignore key order/default reasoning but detect text, media and swipe edits', () => {
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
    const a = [userMessage()];
    const b = structuredClone(a); b[0].extra.reasoning = '';
    assert.equal(chatFingerprintInput(a), chatFingerprintInput(b));
    b[0].mes += '!'; assert.notEqual(chatFingerprintInput(a), chatFingerprintInput(b));
    b[0] = { ...a[0], extra: { media: [{ url: 'image.png' }] } };
    assert.notEqual(chatFingerprintInput(a), chatFingerprintInput(b));
});

test('non-streaming reply retains text, reasoning and opaque signature separately', () => {
    const result = parseVertexReply(replyJSON(), false);
    assert.equal(result.text, 'Hello 世界');
    assert.equal(result.reasoning, 'Thinking');
    assert.equal(result.signature, 'opaque-signature==');
});

test('SSE handles CRLF, multiline data, all parts and reasoning-only chunks', () => {
    const first = { candidates: [{ content: { parts: [{ thought: true, text: 'Thought' }, { text: 'A' }, { text: 'B' }] } }] };
    const body = `: heartbeat\r\n\r\ndata: ${JSON.stringify(first)}\r\n\r\n` + sse('中文') + 'data: [DONE]\n\n';
    const parsed = parseVertexReply(body, true);
    assert.equal(parsed.text, 'AB中文'); assert.equal(parsed.reasoning, 'Thought'); assert.equal(parsed.signature, 'signature==');
    assert.equal(parseVertexReply('data: {"candidates":\ndata: [{"content":{"parts":[{"text":"x"}]},"finishReason":"STOP"}]}\n\n', true).text, 'x');
});

test('truncated streams, model errors and empty responses are not treated as final replies', () => {
    assert.throws(() => parseVertexReply(sse('partial', false), true), /without a final/);
    assert.throws(() => parseVertexReply('data: {"error":{"message":"quota"}}\n\n', true), /quota/);
    assert.throws(() => parseVertexReply('{}', false), /no reply/);
    assert.throws(() => parseVertexReply('{"promptFeedback":{"blockReason":"SAFETY"}}', false), /SAFETY/);
});

test('normal restoration appends or replaces only its marked partial and deduplicates', () => {
    const id = randomUUID(); const base = [userMessage()]; const meta = context(base);
    assert.deepEqual(planRecovery(base, meta, id, hash), { kind: 'append', index: 1 });
    const partial = assistantMessage(); markTask(partial, id, false);
    assert.deepEqual(planRecovery([...base, partial], meta, id, hash), { kind: 'replace', index: 1 });
    partial.extra.generation_task_edited = true;
    assert.throws(() => planRecovery([...base, partial], meta, id, hash), /changed/);
    markTask(partial, id, true);
    assert.equal(planRecovery([...base, partial], meta, id, hash).kind, 'already');
    assert.throws(() => planRecovery([...base, assistantMessage()], meta, id, hash), /changed/);
    const edited = structuredClone(base); edited[0].mes = 'Different prompt';
    assert.throws(() => planRecovery(edited, meta, id, hash), /changed/);
});

test('continuation preserves old reasoning, swipes and metadata without duplicating the suffix', () => {
    const base = [userMessage(), assistantMessage()]; const meta = context(base, 'continue'); const id = randomUUID();
    const task = { id, model: 'model', createdAt: 1, updatedAt: 2 };
    const reply = { text: ' after', reasoning: 'New reasoning', signature: 'new-signature' };
    const message = buildRecoveredMessage(meta, reply, task, { text: 'Before after' });
    assert.equal(message.mes, 'Before after'); assert.equal(message.extra.reasoning, 'Old reasoning. New reasoning');
    assert.equal(message.extra.reasoning_signature, 'new-signature'); assert.equal(message.swipes.length, 1);
    assert.equal(planRecovery([base[0], message], meta, id, hash).kind, 'already');
});

test('swipe restoration appends one variant and retains the original variant', () => {
    const base = [userMessage(), assistantMessage()]; base[1].swipe_id = 1;
    const meta = context(base, 'swipe'); const task = { id: randomUUID(), model: 'm', createdAt: 1, updatedAt: 2 };
    const reply = { text: 'Alternative', reasoning: '', signature: null };
    const message = buildRecoveredMessage(meta, reply, task);
    assert.deepEqual(message.swipes, ['Before', 'Alternative']); assert.equal(message.swipe_id, 1);
    assert.equal(message.swipe_info[1].extra.generation_task_complete, true);
    assert.ok(hasCompletedTask(message, task.id));
});

test('metadata validation rejects traversal and unsupported operations', () => {
    for (const avatar of ['../other.png', '/tmp/a.png', 'a\\b.png', '..']) {
        const meta = context(); meta.chat.avatar = avatar;
        assert.throws(() => validateContext(meta));
    }
    assert.throws(() => validateContext({ ...context(), type: 'quiet' }));
    assert.throws(() => validateContext({ ...context(), baseHash: 'wrong' }));
});

test('task creation is idempotent and never writes the request, prompt or credentials', t => {
    const { store } = fixture(t); const id = randomUUID();
    const body = { model: 'm', stream: false, proxy_password: 'SECRET-CREDENTIAL', messages: [{ content: 'PRIVATE-PROMPT' }] };
    assert.equal(store.create(id, context(), body).created, true);
    assert.equal(store.create(id, context(), body).created, false);
    assert.throws(() => store.create(id, context(), { ...body, model: 'different' }), /different request/);
    const metadata = fs.readFileSync(store.file(id), 'utf8');
    assert.ok(!metadata.includes('SECRET-CREDENTIAL')); assert.ok(!metadata.includes('PRIVATE-PROMPT'));
    assert.equal(fs.statSync(store.file(id)).mode & 0o777, 0o600);
});

test('complete results survive restart; running jobs become interrupted without retry', async t => {
    const { store } = fixture(t); const completedId = randomUUID(); const pendingId = randomUUID();
    store.create(completedId, context(), { stream: false }); await finish(store, completedId);
    store.create(pendingId, context([userMessage()], 'normal', 'Other'), { stream: false });
    const reloaded = new GenerationTaskStore(store.directory);
    assert.equal(reloaded.get(completedId).status, 'completed');
    assert.equal(reloaded.result(completedId).toString(), replyJSON());
    assert.equal(reloaded.get(pendingId).status, 'interrupted');
    assert.equal(reloaded.create(pendingId, context([userMessage()], 'normal', 'Other'), { stream: false }).created, false);
});

test('cancellation explicitly closes the upstream socket and cannot be overwritten by a late finish', async t => {
    const { store } = fixture(t); const id = randomUUID();
    store.create(id, context(), { stream: true }); const sink = store.makeResponse(id);
    let closed = false; sink.socket.on('close', () => { closed = true; });
    sink.write(sse('partial', false)); store.cancel(id);
    assert.equal(closed, true); assert.equal(store.get(id).status, 'cancelled');
    store.finish(id, sink);
    assert.equal(store.get(id).status, 'cancelled');
});

test('UTF-8 split across chunks is durably preserved; size limits terminate oversized results', async t => {
    const { store } = fixture(t); const id = randomUUID(); store.create(id, context(), { stream: true });
    const sink = store.makeResponse(id); const data = Buffer.from(sse('你好🌟'));
    const ended = once(sink, 'finish');
    for (const byte of data) sink.write(Buffer.from([byte])); sink.end(); await ended;
    assert.deepEqual(store.result(id), data);
    const other = new GenerationTaskStore(path.join(store.directory, 'small'), { maxBytes: 5 });
    const tooBig = randomUUID(); other.create(tooBig, context(), { stream: true });
    const limited = other.makeResponse(tooBig); const terminal = once(limited, 'terminal');
    limited.write('123456'); await terminal;
    assert.equal(other.get(tooBig).status, 'failed');
});

test('quota reservations, owner isolation, acknowledgement and TTL cleanup are bounded', async t => {
    const { store, root } = fixture(t, { maxRunning: 1, maxBytes: 1024, maxStoredBytes: 2048 });
    const id = randomUUID(); store.create(id, context(), { stream: false });
    assert.throws(() => store.create(randomUUID(), context([userMessage()], 'normal', 'Other'), { stream: false }), /Too many/);
    const other = new GenerationTaskStore(path.join(root, 'another-user'));
    assert.equal(other.get(id), undefined);
    await finish(store, id); store.acknowledge(id);
    assert.equal(fs.existsSync(store.file(id, 'body')), false);
    assert.equal(store.create(id, context(), { stream: false }).created, false);
    store.get(id).updatedAt = 0; store.prune(); assert.equal(store.get(id), undefined);
});

class TestResponse extends Writable {
    constructor() { super(); this.headers = {}; this.headersSent = false; this.statusCode = 200; this.parts = []; }
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
    status(value) { this.statusCode = value; return this; }
    json(value) { this.setHeader('content-type', 'application/json'); this.end(JSON.stringify(value)); return this; }
    _write(chunk, encoding, callback) { this.headersSent = true; this.parts.push(Buffer.from(chunk)); callback(); }
    text() { return Buffer.concat(this.parts).toString('utf8'); }
    data() { return JSON.parse(this.text()); }
}
function routerFixture(t, provider) {
    const { root } = fixture(t);
    const directories = { root, chats: path.join(root, 'chats'), backups: path.join(root, 'backups') };
    fs.mkdirSync(path.join(directories.chats, 'Character'), { recursive: true });
    const filename = path.join(directories.chats, 'Character', 'Chat.jsonl');
    const header = { chat_metadata: { integrity: 'test' }, user_name: 'unused', character_name: 'unused' };
    fs.writeFileSync(filename, [header, userMessage()].map(JSON.stringify).join('\n'));
    const user = { profile: { handle: 'test-user' }, directories };
    const handlers = [];
    const factory = () => ({
        get(pattern, handler) { handlers.push({ method: 'GET', pattern, handler }); return this; },
        post(pattern, handler) { handlers.push({ method: 'POST', pattern, handler }); return this; },
        use() { return this; },
    });
    buildGenerationRecoveryRouter({ handle: provider }, factory, name => name.replace(/[<>:"|?*]/g, ''));
    const call = async (method, url, body = {}, overrideUser = user, response = new TestResponse()) => {
        const route = handlers.find(item => item.method === method && new RegExp(`^${item.pattern.replace(':id', '([^/]+)')}$`).test(url));
        assert.ok(route, `Missing route: ${method} ${url}`);
        const match = url.match(new RegExp(`^${route.pattern.replace(':id', '([^/]+)')}$`));
        const request = Object.assign(new EventEmitter(), { body, user: overrideUser, params: { id: match[1] }, headers: {}, socket: new EventEmitter() });
        let next = false;
        await route.handler(request, response, () => { next = true; });
        return { request, response, next };
    };
    const generate = (id = randomUUID(), stream = true) => ({ id, body: {
        type: 'normal', chat_completion_source: 'vertexai', vertexai_auth_mode: 'express', model: 'test-model', stream,
        messages: [{ role: 'user', content: 'Hello' }], generation_recovery: { id, context: context() },
    } });
    return { call, filename, user, generate, root };
}

test('router preserves legacy requests and rejects unauthenticated task access', async t => {
    let invoked = 0; const app = routerFixture(t, () => invoked++);
    assert.equal((await app.call('POST', '/generate', { model: 'legacy' })).next, true);
    assert.equal(invoked, 0);
    assert.equal((await app.call('GET', '/recovery', {}, null)).response.statusCode, 401);
});

test('disconnect during streaming keeps generation alive and restores exactly one final reply', async t => {
    let upstream; let upstreamClosed = false; let invocations = 0;
    const app = routerFixture(t, (req, sink) => {
        invocations++; req.socket.on('close', () => { upstreamClosed = true; });
        upstream = new PassThrough(); upstream.pipe(sink);
    });
    const job = app.generate(); const first = await app.call('POST', '/generate', job.body);
    await nextTurn(); upstream.write(sse('Hello ', false));
    first.request.socket.emit('close'); first.response.destroy();
    assert.equal(upstreamClosed, false);
    upstream.end(sse('世界')); await nextTurn();
    const detail = (await app.call('GET', `/recovery/${job.id}/result`)).response.data();
    assert.equal(detail.reply.text, 'Hello 世界'); assert.equal(detail.reply.signature, 'signature==');
    const replay = (await app.call('POST', '/generate', job.body)).response;
    assert.equal(first.response.headers['x-generation-stream-end'], 'generation-complete');
    assert.equal(replay.headers['x-generation-stream-end'], 'generation-complete');
    assert.equal(replay.text(), sse('Hello ', false) + sse('世界') + '\n\nevent: generation-complete\ndata: [DONE]\n\n');
    assert.equal(invocations, 1);
    const now = Date.now; t.mock.method(Date, 'now', () => now() + 4000);
    const claim = (await app.call('POST', `/recovery/${job.id}/claim`, { client: randomUUID() })).response.data();
    const body = { token: claim.token, text: detail.reply.text, reasoning: detail.reply.reasoning, includeMessage: true };
    const applied = await app.call('POST', `/recovery/${job.id}/apply`, body);
    assert.equal(applied.response.statusCode, 200);
    const again = await app.call('POST', `/recovery/${job.id}/apply`, body);
    assert.equal(again.response.statusCode, 200); assert.equal(again.response.data().alreadySaved, true);
    const rows = fs.readFileSync(app.filename, 'utf8').split('\n').map(JSON.parse);
    assert.equal(rows.length, 3); assert.equal(rows[2].mes, 'Hello 世界'); assert.equal(rows[2].extra.reasoning_signature, 'signature==');
    assert.deepEqual(applied.response.data().message, rows[2]);
    const confirm = () => app.call('POST', `/recovery/${job.id}/ack`, { includeMessage: true });
    assert.deepEqual((await confirm()).response.data(), { ok: true, index: 1, message: rows[2] });
    rows[1].mes = 'Edited earlier in another tab';
    fs.writeFileSync(app.filename, rows.map(JSON.stringify).join('\n'));
    assert.deepEqual((await confirm()).response.data(), { ok: true });
    assert.ok(fs.existsSync(path.join(app.user.directories.backups, `recovery-${job.id}.jsonl`)));
    assert.equal((await app.call('GET', '/recovery')).response.data().tasks.length, 0);
});

test('normal delivery carries original HTTP/JSON and ACK waits for an actual saved marker', async t => {
    const app = routerFixture(t, (req, sink) => sink.json(JSON.parse(replyJSON())));
    const job = app.generate(randomUUID(), false);
    const { response } = await app.call('POST', '/generate', job.body); await nextTurn();
    assert.deepEqual(response.data(), JSON.parse(replyJSON()));
    assert.equal(response.headers['x-generation-stream-end'], undefined);
    assert.equal((await app.call('POST', `/recovery/${job.id}/ack`)).response.statusCode, 409);
    const rows = fs.readFileSync(app.filename, 'utf8').split('\n').map(JSON.parse);
    const message = assistantMessage(); markTask(message, job.id, true); rows.push(message);
    fs.writeFileSync(app.filename, rows.map(JSON.stringify).join('\n'));
    assert.equal((await app.call('POST', `/recovery/${job.id}/ack`)).response.statusCode, 200);
});

test('explicit stop cancels a waiting upstream; immediate stop prevents dispatch entirely', async t => {
    let invoked = 0; let stopped = false;
    const app = routerFixture(t, (req) => { invoked++; req.socket.on('close', () => { stopped = true; }); });
    const job = app.generate(); await app.call('POST', '/generate', job.body); await nextTurn();
    await app.call('POST', `/recovery/${job.id}/cancel`);
    assert.equal(stopped, true); assert.equal((await app.call('GET', `/recovery/${job.id}`)).response.data().status, 'cancelled');
    await app.call('POST', `/recovery/${job.id}/discard`);
    const immediate = app.generate(); await app.call('POST', '/generate', immediate.body);
    await app.call('POST', `/recovery/${immediate.id}/cancel`); await nextTurn();
    assert.equal(invoked, 1);
});

test('changed history is never overwritten and a different user cannot read the task', async t => {
    const app = routerFixture(t, (req, sink) => sink.json(JSON.parse(replyJSON())));
    const job = app.generate(randomUUID(), false); await app.call('POST', '/generate', job.body); await nextTurn();
    const now = Date.now; t.mock.method(Date, 'now', () => now() + 4000);
    const token = (await app.call('POST', `/recovery/${job.id}/claim`, { client: randomUUID() })).response.data().token;
    fs.appendFileSync(app.filename, '\n' + JSON.stringify({ ...userMessage(), mes: 'New message' }));
    const before = fs.readFileSync(app.filename, 'utf8');
    assert.equal((await app.call('POST', `/recovery/${job.id}/apply`, { token, text: 'reply', reasoning: '' })).response.statusCode, 409);
    assert.equal(fs.readFileSync(app.filename, 'utf8'), before);
    assert.equal((await app.call('GET', `/recovery/${job.id}/result`)).response.statusCode, 200);
    const otherRoot = path.join(app.root, 'other'); fs.mkdirSync(otherRoot);
    const other = { profile: { handle: 'other' }, directories: { root: otherRoot, chats: path.join(otherRoot, 'chats') } };
    assert.equal((await app.call('GET', `/recovery/${job.id}`, {}, other)).response.statusCode, 404);
});

test('a baseline that was not saved fails before any model call', async t => {
    let invoked = 0; const app = routerFixture(t, () => invoked++);
    const job = app.generate(); job.body.generation_recovery.context.baseHash = 'a'.repeat(64);
    const result = await app.call('POST', '/generate', job.body); await nextTurn();
    assert.equal(result.response.statusCode, 409); assert.equal(invoked, 0);
});

test('upstream stream errors become failed tasks instead of uncaught server errors', async t => {
    let source;
    const app = routerFixture(t, (req, sink) => { source = new PassThrough(); source.pipe(sink); });
    const job = app.generate(); await app.call('POST', '/generate', job.body); await nextTurn();
    source.write(sse('partial', false)); source.destroy(new Error('upstream reset')); await nextTurn();
    const result = (await app.call('GET', `/recovery/${job.id}`)).response.data();
    assert.equal(result.status, 'failed'); assert.match(result.error, /upstream reset/);
});

test('an immediate next generation acknowledges the previous durably saved reply without waiting for polling', async t => {
    let calls = 0;
    const app = routerFixture(t, (req, sink) => { calls++; sink.json(JSON.parse(replyJSON())); });
    const first = app.generate(randomUUID(), false);
    await app.call('POST', '/generate', first.body); await nextTurn();
    const rows = fs.readFileSync(app.filename, 'utf8').split('\n').map(JSON.parse);
    const message = assistantMessage(); markTask(message, first.id, true); rows.push(message, userMessage());
    fs.writeFileSync(app.filename, rows.map(JSON.stringify).join('\n'));
    const second = app.generate(randomUUID(), false);
    second.body.generation_recovery.context = context(rows.slice(1));
    const result = await app.call('POST', '/generate', second.body); await nextTurn();
    assert.equal(result.response.statusCode, 200); assert.equal(calls, 2);
    assert.equal((await app.call('GET', `/recovery/${first.id}`)).response.data().acknowledged, true);
});

test('a stalled browser subscriber is detached without stopping the model', async t => {
    let source; let stopped = false;
    const app = routerFixture(t, (req, sink) => {
        req.socket.on('close', () => { stopped = true; });
        source = new PassThrough(); source.pipe(sink);
    });
    const response = new TestResponse();
    Object.defineProperty(response, 'writableLength', { get: () => 2 * 1024 * 1024 });
    const job = app.generate(); await app.call('POST', '/generate', job.body, app.user, response);
    await nextTurn(); source.end(sse('Final')); await nextTurn();
    assert.equal(response.destroyed, true); assert.equal(stopped, false);
    assert.equal((await app.call('GET', `/recovery/${job.id}/result`)).response.data().reply.text, 'Final');
});

test('recovery leases exclude another tab and expire safely', async t => {
    const { store } = fixture(t); const id = randomUUID();
    store.create(id, context(), { stream: false }); await finish(store, id);
    let now = Date.now() + 4000; t.mock.method(Date, 'now', () => now);
    const first = randomUUID(); const second = randomUUID();
    const token = store.claim(id, first);
    assert.equal(store.claim(id, first), token);
    assert.throws(() => store.claim(id, second), /Another tab/);
    now += 31000; assert.throws(() => store.checkLease(id, token), /expired/);
    assert.notEqual(store.claim(id, second), token);
});

function browserStorage() {
    const values = new Map();
    return {
        get length() { return values.size; },
        key: index => [...values.keys()][index] ?? null,
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
    };
}

const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

async function browserFixture({ handle = 'user', storage = browserStorage(), values = new Map(), respond = () => json({ ok: true }) } = {}) {
    const { runInNewContext } = await import('node:vm');
    const callbacks = new Map(); const requests = [];
    const timers = new Map(); const windowEvents = new Map(); const documentEvents = new Map();
    let nextTimer = 0;
    const core = {};
    const ctx = {
        uuidv4: randomUUID, chat: [userMessage()], chatId: 'Chat', characterId: 0,
        characters: [{ avatar: 'Character.png' }], name2: 'Character',
        saveChat: async () => {}, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        powerUserSettings: { trim_spaces: true },
        accountStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
        eventSource: { on: (event, callback) => callbacks.set(event, callback) },
        eventTypes: Object.fromEntries(['GENERATION_STARTED', 'CHAT_COMPLETION_SETTINGS_READY', 'STREAM_TOKEN_RECEIVED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'CHAT_CHANGED', 'APP_READY'].map(name => [name, name])),
    };
    const sandbox = {
        core, getContext: () => ctx, sha256: hash, RECOVERY_TYPES: ['normal', 'regenerate', 'continue', 'swipe'], RECOVERY_VERSION: 1,
        chatFingerprintInput, markTask, planRecovery, structuredClone, AbortController,
        localStorage: storage, accountsEnabled: true, currentUser: { handle }, getCurrentUserHandle: () => handle,
        getRegexedString: value => value, regex_placement: {},
        setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
        clearTimeout: id => timers.delete(id),
        document: { hidden: false, querySelector: () => null, addEventListener: (name, handler) => documentEvents.set(name, handler) },
        window: { addEventListener: (name, handler) => windowEvents.set(name, handler) }, toastr: { warning: () => {}, error: () => {}, success: () => {} },
        console, getComputedStyle: () => ({ display: 'none' }),
        fetch: async (url, options) => { requests.push({ url, options }); return respond(url, options); },
    };
    const source = fs.readFileSync(new URL('../public/scripts/extensions/generation-recovery/index.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
    runInNewContext(source, sandbox);
    async function tick() {
        const [id, timer] = [...timers].sort((a, b) => a[1].delay - b[1].delay)[0];
        timers.delete(id);
        timer.callback();
        await nextTurn();
        return timer.delay;
    }
    return { callbacks, ctx, requests, core, timers, tick, windowEvents, documentEvents, document: sandbox.document };
}

test('browser hooks opt in only eligible requests and never mark a failed stream as complete', async () => {
    const { callbacks, ctx } = await browserFixture();
    const prepare = callbacks.get('CHAT_COMPLETION_SETTINGS_READY');
    for (const data of [{ type: 'quiet', chat_completion_source: 'vertexai' }, { type: 'normal', chat_completion_source: 'openai' }, { type: 'normal', chat_completion_source: 'vertexai', tools: [{}] }]) {
        await prepare(data); assert.equal(data.generation_recovery, undefined);
    }
    const data = { type: 'normal', chat_completion_source: 'vertexai', stream: true };
    await prepare(data); assert.ok(data.generation_recovery.id);
    ctx.chat.push(assistantMessage());
    ctx.streamingProcessor = { isFinished: false, isStopped: true, abortController: new AbortController() };
    callbacks.get('MESSAGE_RECEIVED')(1);
    assert.equal(ctx.chat[1].extra.generation_task_complete, false);
    ctx.streamingProcessor.isFinished = true; ctx.streamingProcessor.isStopped = false;
    callbacks.get('MESSAGE_RECEIVED')(1);
    assert.ok(hasCompletedTask(ctx.chat[1], data.generation_recovery.id));
});

test('the explicit browser stop event sends a separate cancellable task request', async () => {
    const { callbacks, requests } = await browserFixture();
    const data = { type: 'normal', chat_completion_source: 'vertexai', stream: false };
    await callbacks.get('CHAT_COMPLETION_SETTINGS_READY')(data);
    callbacks.get('GENERATION_STOPPED')(); await nextTurn();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `/api/backends/chat-completions/recovery/${data.generation_recovery.id}/cancel`);
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.keepalive, true);
});

test('switching chats during preparation aborts an eligible request before dispatch', async () => {
    const page = await browserFixture();
    page.ctx.saveChat = async () => { page.ctx.chatId = 'Other chat'; };
    const preparation = new AbortController();
    const data = { type: 'normal', chat_completion_source: 'vertexai' };
    await page.callbacks.get('CHAT_COMPLETION_SETTINGS_READY')(data, preparation);
    assert.ok(preparation.signal.aborted);
    assert.equal(data.generation_recovery, undefined);
});

test('a continuation disconnected before the first token can replace its own placeholder', async () => {
    const page = await browserFixture();
    page.ctx.chat.push(assistantMessage());
    const stream = { messageId: -1, abortController: new AbortController() };
    page.ctx.streamingProcessor = stream;
    const data = { type: 'continue', chat_completion_source: 'vertexai', stream: true };
    await page.callbacks.get('CHAT_COMPLETION_SETTINGS_READY')(data);
    stream.messageId = 1;
    page.ctx.chat[1].mes += '...';
    stream.abortController.abort();
    const { id, context: baseline } = data.generation_recovery;
    assert.deepEqual(planRecovery(page.ctx.chat, baseline, id, hash), { kind: 'replace', index: 1 });
    assert.equal(page.ctx.chat[1].extra.generation_task_complete, false);
});

test('a fresh tab retries discovery with capped backoff and stops when the list is empty', async () => {
    let attempts = 0;
    const page = await browserFixture({ respond: () => {
        if (++attempts === 1) throw new TypeError('Network down');
        return attempts < 8 ? json({}, 503) : json({ tasks: [] });
    } });
    page.windowEvents.get('pageshow')();
    const delays = [];
    for (let i = 0; i < 8; i++) delays.push(await page.tick());
    assert.deepEqual(delays, [0, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    assert.equal(page.timers.size, 0);
    page.document.hidden = true;
    page.documentEvents.get('visibilitychange')();
    assert.equal(page.timers.size, 0);
    page.document.hidden = false;
    page.documentEvents.get('visibilitychange')();
    assert.equal(await page.tick(), 0);
});

test('a reconnect during an in-flight discovery runs one more check', async () => {
    let finish;
    const page = await browserFixture({ respond: () => finish ? json({ tasks: [] }) : new Promise(resolve => { finish = resolve; }) });
    await page.tick();
    page.windowEvents.get('online')();
    await page.tick();
    assert.equal(page.requests.length, 1);
    finish(json({ tasks: [] }));
    await nextTurn();
    assert.equal(await page.tick(), 0);
    assert.equal(page.requests.length, 2);
    assert.equal(page.timers.size, 0);
});

test('an offline stop survives a fresh page and only the originating account retries it', async () => {
    const storage = browserStorage();
    const offline = await browserFixture({ storage, respond: () => { throw new TypeError('Offline'); } });
    const data = { type: 'normal', chat_completion_source: 'vertexai', stream: true };
    await offline.callbacks.get('CHAT_COMPLETION_SETTINGS_READY')(data);
    offline.callbacks.get('GENERATION_STOPPED')();
    await nextTurn();
    assert.equal(storage.length, 1);
    const other = await browserFixture({ handle: 'other', storage, respond: () => json({ tasks: [] }) });
    await other.tick();
    assert.equal(other.requests.length, 1);
    assert.equal(storage.length, 1);
    const online = await browserFixture({ storage, respond: () => json({ tasks: [] }) });
    await online.tick();
    assert.deepEqual(online.requests.map(req => req.url.split('/').at(-1)), ['cancel', 'recovery']);
    assert.ok(online.requests[0].url.includes(data.generation_recovery.id));
    assert.equal(storage.length, 0);
});

test('stops queued by older clients are drained after upgrading', async () => {
    const key = 'generation-recovery-cancel-requests';
    const id = randomUUID();
    const values = new Map([[key, JSON.stringify({ [id]: Date.now() })]]);
    const page = await browserFixture({ values, respond: () => json({ tasks: [] }) });
    await page.tick();
    assert.ok(page.requests[0].url.endsWith(`/${id}/cancel`));
    assert.deepEqual(JSON.parse(values.get(key)), {});
});

test('a lost apply response displays the saved reply once without downloading the whole chat', async () => {
    const task = { id: randomUUID(), status: 'completed', context: context(), createdAt: 1, updatedAt: 2 };
    const reply = parseVertexReply(replyJSON(), false);
    const message = buildRecoveredMessage(task.context, reply, task);
    let writes = 0;
    const page = await browserFixture({ respond: (url, options) => {
        switch (url.split('/').at(-1)) {
            case 'recovery': return json({ tasks: writes ? [] : [task] });
            case 'claim': return json({ token: 'token' });
            case 'result': return json({ task, reply });
            case 'apply': writes++; throw new TypeError('Lost response after commit');
            case 'ack': return writes && JSON.parse(options.body).includeMessage ? json({ ok: true, index: 1, message }) : json({}, 409);
            default: throw new Error(`Unexpected request: ${url}`);
        }
    } });
    const rendered = [];
    page.core.redisplayChat = ({ startIndex }) => rendered.push(startIndex);
    await page.tick();
    assert.equal(page.ctx.chat.length, 1);
    await page.tick();
    assert.equal(writes, 1);
    assert.deepEqual(rendered, [1]);
    assert.equal(page.ctx.chat[1].mes, reply.text);
    assert.ok(hasCompletedTask(page.ctx.chat[1], task.id));
    assert.equal(page.timers.size, 0);
});

test('a local edit during the claim is preserved and prevents apply', async () => {
    const task = { id: randomUUID(), status: 'completed', context: context() };
    const page = await browserFixture({ respond: url => {
        switch (url.split('/').at(-1)) {
            case 'recovery': return json({ tasks: [task] });
            case 'ack': return json({}, 409);
            case 'claim': page.ctx.chat[0].mes = 'User edit'; return json({ token: 'token' });
            case 'result': return json({ task, reply: parseVertexReply(replyJSON(), false) });
            default: throw new Error(`Unexpected request: ${url}`);
        }
    } });
    await page.tick();
    assert.equal(page.ctx.chat[0].mes, 'User edit');
    assert.ok(!page.requests.some(req => req.url.endsWith('/apply')));
});
