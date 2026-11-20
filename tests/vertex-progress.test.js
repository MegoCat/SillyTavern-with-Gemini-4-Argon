import { afterEach, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { VertexProgress } from '../src/endpoints/backends/vertex-progress.js';
import { VertexResponseMetadata } from '../src/endpoints/backends/vertex-response-metadata.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

test('a narrow terminal shows the live countdown and accounts for each phase exactly once', () => {
    jest.useFakeTimers();
    const frames = [];
    const terminal = {
        isTTY: true, columns: 37, bytesWritten: 0,
        write(text) {
            frames.push(text);
            this.bytesWritten += Buffer.byteLength(text);
            return true;
        },
    };
    jest.spyOn(process, 'stdout', 'get').mockReturnValue(terminal);
    jest.replaceProperty(process, 'env', { ...process.env, TERM: 'xterm' });
    const logs = jest.spyOn(console, 'info').mockImplementation(() => {});
    const response = new EventEmitter();
    const source = new PassThrough();
    const progress = new VertexProgress(response, 'gemini-4-neon', true);
    jest.advanceTimersByTime(1000);
    progress.attempt();
    jest.advanceTimersByTime(1000);
    progress.rateLimited(5000);
    jest.advanceTimersByTime(2000);
    expect(frames.at(-1)).toContain('0:04 | 429 x1 | retry in 3s');
    expect(frames.at(-1)).toContain('\x1b[1A');

    // A normal log has taken the last row. Redrawing must leave it intact.
    terminal.write('another server log\n');
    jest.advanceTimersByTime(1000);
    expect(frames.at(-1)).not.toContain('\x1b[1A');
    jest.advanceTimersByTime(2000);
    progress.attempt();
    jest.advanceTimersByTime(4000);
    progress.headers({ ok: true, status: 200, body: source });
    expect(logs.mock.calls.at(-1)[0]).toContain('HTTP 200 | 429 x1 6.0s | wait 4.0s');
    progress.observeStream(source, response, new AbortController().signal);
    jest.advanceTimersByTime(2000);
    expect(frames.at(-1)).toContain('first byte 0:02');
    source.write('data: {"modelSpecific":{"tier":"custom"},"candidates":[{"content":{"parts":[{"thoughtSignature":"opaque-signature"}]}}]}\n\n');
    jest.advanceTimersByTime(3000);
    expect(frames.at(-1)).toContain('receive 0:03');
    source.end();
    response.emit('finish');
    response.emit('close');
    const summary = logs.mock.calls.at(-1)[0];
    expect(summary).toContain('done | total 16.0s');
    expect(summary).toContain('API metadata');
    expect(summary).toContain('modelSpecific');
    expect(summary).toContain('custom');
    expect(summary).not.toContain('thoughtSignature');
    expect(summary).not.toContain('opaque-signature');
    for (const phase of ['prep 1.0s', '429 x1 6.0s', 'wait 4.0s', 'first byte 2.0s', 'receive 3.0s']) expect(summary).toContain(phase);
    expect(logs).toHaveBeenCalledTimes(3);
    const writes = frames.length;
    jest.advanceTimersByTime(10000);
    expect(frames).toHaveLength(writes);
});

test('keeps sparse metadata per candidate without assuming what any model returns', () => {
    const meta = new VertexResponseMetadata();
    meta.add({ custom: { text: 'provider annotation', snapshots: ['old'] }, candidates: [
        { index: 2, output: { parts: [{ text: 'chat', vendorTag: 'a', thoughtSignature: 'sig-a' }] } },
        { index: 0, content: 'other chat text' },
    ] });
    meta.add({ candidates: [{ index: 2, output: { parts: [
        { thoughtSignature: 'sig-b', vendorTag: 'a' }, { thought_signature: 'sig-c' },
        { functionCall: { name: 'verify', args: { signature: 'input' } }, thoughtSignature: 'tool-sig' },
    ] } }] });
    meta.add({ custom: { snapshots: [], newFlag: false }, candidates: [{ index: 0, newReason: null }] });
    expect(meta.snapshot()).toEqual({
        custom: { text: 'provider annotation', snapshots: [], newFlag: false },
        candidates: [
            { index: 2, output: { parts: [{ vendorTag: 'a' }, { functionCall: { name: 'verify', args: { signature: 'input' } } }] } },
            { index: 0, newReason: null },
        ],
    });
});
