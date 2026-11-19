import process from 'node:process';
import { finished } from 'node:stream';
import { inspect } from 'node:util';
import { LOG_LEVELS } from '../../constants.js';
import { color, getConfigValue } from '../../util.js';
import { VertexResponseMetadata } from './vertex-response-metadata.js';

const live = new Set();
let nextId = 0;
let timer;
let lastRow;

function clock(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const prefix = minutes < 60 ? String(minutes) : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
    return `${prefix}:${String(seconds % 60).padStart(2, '0')}`;
}

function duration(ms) {
    return ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : clock(ms);
}

// Only reclaim our row if no other server output or terminal resize intervened.
function reclaimRow() {
    const row = lastRow;
    lastRow = undefined;
    return row && row.out === process.stdout.bytesWritten && row.err === process.stderr.bytesWritten
        && row.columns === process.stdout.columns ? '\x1b[1A\r\x1b[2K' : '';
}

function draw() {
    if (!live.size) return;
    const now = performance.now();
    const tasks = [...live];
    const index = Math.floor(now / 3000) % tasks.length;
    const task = tasks[index];
    const position = tasks.length > 1 ? `[${index + 1}/${tasks.length}] ` : '';
    // All live fields are ASCII, so one character occupies one terminal column.
    const line = (position + task.line(now)).slice(0, Math.max(1, (process.stdout.columns || 80) - 1));
    const paint = task.backoffAt === undefined ? color.cyan : color.yellow;
    process.stdout.write(reclaimRow() + paint(line) + '\n');
    lastRow = { out: process.stdout.bytesWritten, err: process.stderr.bytesWritten, columns: process.stdout.columns };
}

function print(message) {
    const erase = reclaimRow();
    if (erase) process.stdout.write(erase);
    console.info(message);
}

/** Server-observed timings for one Vertex Express request, including a detached recovery response. */
export class VertexProgress {
    constructor(response, model, stream) {
        this.id = ++nextId;
        this.started = performance.now();
        this.stream = stream;
        this.limits = 0;
        const showInfo = getConfigValue('logging.minLogLevel', LOG_LEVELS.DEBUG, 'number') <= LOG_LEVELS.INFO;
        this.interactive = showInfo && process.stdout.isTTY && process.env.TERM !== 'dumb';
        this.metadata = showInfo ? new VertexResponseMetadata() : undefined;
        this.tag = `[Vertex #${this.id}]`;
        const safeModel = String(model).replace(/[^a-zA-Z0-9._/-]/g, '').slice(0, 80);
        print(`${this.tag} ${safeModel} | ${stream ? 'stream' : 'JSON'}`);
        if (this.interactive) {
            live.add(this);
            timer ??= setInterval(draw, 1000).unref();
            draw();
        }

        const onFinish = () => this.finish(response.statusCode >= 400 ? 'failed' : 'done');
        const onClose = () => this.finish('cancelled');
        const onError = () => this.finish('failed');
        const onTerminal = record => this.finish(record.status === 'completed' ? 'done' : record.status);
        response.once('finish', onFinish);
        response.once('close', onClose);
        response.once('error', onError);
        response.once('terminal', onTerminal);
        this.cleanup = () => {
            response.off('finish', onFinish);
            response.off('close', onClose);
            response.off('error', onError);
            response.off('terminal', onTerminal);
        };
        if (response.destroyed) onClose();
    }

    attempt() {
        this.attemptAt = performance.now();
        this.firstAttempt ??= this.attemptAt;
        this.backoffAt = undefined;
        if (this.interactive) draw();
    }

    rateLimited(delay) {
        this.limits++;
        this.backoffAt = performance.now();
        this.retryAt = this.backoffAt + delay;
        if (this.interactive) draw();
        else if (this.limits === 1) console.warn(`${this.tag} HTTP 429 | retrying automatically`);
    }

    headers(upstream) {
        this.headersAt = performance.now();
        this.waitForBody = this.stream && upstream.ok && Boolean(upstream.body);
        if (!this.waitForBody) this.bodyAt = this.headersAt;
        if (upstream.ok) {
            const limited = this.limits ? ` | 429 x${this.limits} ${duration(this.attemptAt - this.firstAttempt)}` : '';
            print(`${this.tag} HTTP ${upstream.status}${limited} | wait ${duration(this.headersAt - this.attemptAt)}`);
        }
        if (this.interactive) draw();
    }

    observeStream(source, response, signal) {
        source.once('data', () => {
            this.bodyAt = performance.now();
            if (this.interactive) draw();
        });
        this.metadata?.observeStream(source);
        const cleanup = finished(source, { readable: true, writable: false }, error => {
            cleanup();
            if (error && !signal.aborted) {
                this.finish('failed');
                response.destroy(error);
            }
        });
    }

    line(now) {
        const prefix = `#${this.id} ${clock(now - this.started)} | `;
        if (this.backoffAt !== undefined) {
            const remaining = Math.max(0, Math.ceil((this.retryAt - now) / 1000));
            return `${prefix}429 x${this.limits} | retry in ${remaining}s | ${clock(now - this.backoffAt)}`;
        }
        let stage = 'prepare';
        if (this.bodyAt !== undefined) stage = 'receive';
        else if (this.headersAt !== undefined) stage = 'first byte';
        else if (this.attemptAt !== undefined) stage = 'wait';
        const since = this.bodyAt ?? this.headersAt ?? this.attemptAt ?? this.started;
        const limits = this.limits ? ` | 429 x${this.limits} ${clock(this.attemptAt - this.firstAttempt)}` : '';
        return `${prefix}${stage} ${clock(now - since)}${limits}`;
    }

    finish(outcome) {
        if (!this.cleanup) return;
        this.cleanup();
        this.cleanup = undefined;
        const end = performance.now();
        const first = this.firstAttempt ?? end;
        // Rejected attempts and their sleeps belong to rate limiting, even if stopped mid-sleep.
        const attempt = this.backoffAt === undefined ? (this.attemptAt ?? end) : end;
        const headers = this.headersAt ?? end;
        const body = this.bodyAt ?? end;
        const parts = [`prep ${duration(first - this.started)}`];
        if (this.limits) parts.push(`429 x${this.limits} ${duration(attempt - first)}`);
        if (this.attemptAt !== undefined && this.backoffAt === undefined) parts.push(`wait ${duration(headers - attempt)}`);
        if (this.waitForBody) parts.push(`first byte ${duration(body - headers)}`);
        if (this.bodyAt !== undefined) parts.push(`receive ${duration(end - body)}`);
        live.delete(this);
        if (!live.size) {
            clearInterval(timer);
            timer = undefined;
        }
        const title = `${this.tag} ${outcome} | total ${duration(end - this.started)}`;
        const paint = { done: color.green, failed: color.red, cancelled: color.yellow }[outcome] ?? color.yellow;
        let summary;
        if (this.interactive) {
            const lines = [''];
            for (const part of parts) {
                const last = lines.length - 1;
                const joined = lines[last] ? lines[last] + ' | ' + part : part;
                if (lines[last] && joined.length + 2 >= (process.stdout.columns || 80)) lines.push(part);
                else lines[last] = joined;
            }
            summary = paint(title) + '\n  ' + lines.join('\n  ');
        } else {
            summary = [title, ...parts].join(' | ');
        }
        const metadata = this.metadata?.snapshot();
        this.metadata = undefined;
        if (metadata && Object.keys(metadata).length) {
            const detail = this.interactive ? inspect(metadata, {
                colors: color.level > 0, depth: null, maxArrayLength: null, maxStringLength: null,
                breakLength: process.stdout.columns || 80, compact: 3,
            }) : JSON.stringify(metadata);
            summary += `\n  API metadata ${detail}`;
        }
        print(summary);
        draw();
    }
}
