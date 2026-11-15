import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { getEventListeners, once } from 'node:events';
import http from 'node:http';
import { Readable } from 'node:stream';
import { generateKeyPairSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import nodeFetch from 'node-fetch';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const secrets = await import('../src/endpoints/secrets.js');
const fetchMock = jest.fn();
const retryDelayMock = jest.fn();
const readSecretMock = jest.fn(() => 'vertex-test-key');
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
jest.unstable_mockModule('node:timers/promises', () => ({ setTimeout: retryDelayMock }));
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({
    ...secrets,
    readSecret: readSecretMock,
}));

describe.each(['gemini-4-argon', 'gemini-4-carbon'])('Vertex AI Express %s', (model) => {
    let server;
    let baseUrl;

    beforeAll(async () => {
        const { default: express } = await import('express');
        const { router } = await import('../src/endpoints/backends/chat-completions.js');
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories: {} };
            next();
        });
        app.use(router);
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        if (server) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    beforeEach(() => {
        retryDelayMock.mockReset().mockImplementation((_ms, value, options) => delay(1, value, options));
        readSecretMock.mockReset().mockReturnValue('vertex-test-key');
        fetchMock.mockReset().mockImplementation(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            body: Readable.from(['data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n']),
            json: async () => ({ candidates: [{ content: { parts: [{ text: 'Hello' }] } }] }),
        }));
    });

    afterEach(() => jest.restoreAllMocks());

    async function generate(overrides = {}, signal) {
        return fetch(`${baseUrl}/generate`, {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'vertexai', vertexai_auth_mode: 'express',
                vertexai_express_project_id: 'test-project',
                model, messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 8192, temperature: 0.7, top_p: 0.9, top_k: 40,
                include_reasoning: true, ...overrides,
            }),
        });
    }

    function errorResponse(status = 429) {
        const text = JSON.stringify({ error: { code: status, message: 'Upstream error' } });
        return {
            ok: false, status, statusText: 'Upstream error',
            body: Readable.from([text]),
            text: async () => text,
        };
    }

    test.each([false, true])('retries repeated 429s with fresh 1-3 second delays and stream=%s', async (stream) => {
        jest.spyOn(Math, 'random')
            .mockReturnValueOnce(0).mockReturnValueOnce(0.5).mockReturnValueOnce(0.999999)
            .mockReturnValue(0.25);
        const errors = Array.from({ length: 12 }, () => errorResponse());
        errors.forEach(error => fetchMock.mockResolvedValueOnce(error));

        const response = await generate({ stream });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('Hello');
        expect(fetchMock).toHaveBeenCalledTimes(13);
        expect(retryDelayMock.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 3000, ...Array(9).fill(1500)]);
        for (const error of errors) expect(error.body.destroyed).toBe(true);
        for (const call of fetchMock.mock.calls) {
            expect(call).toEqual([fetchMock.mock.calls[0][0], {
                ...fetchMock.mock.calls[0][1], signal: expect.any(AbortSignal),
            }]);
        }
    });

    test('closes unfinished 429 responses before retrying through a proxy', async () => {
        let attempts = 0;
        const upstream = http.createServer((req, res) => {
            req.resume();
            if (++attempts <= 12) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.write('{"error":'); // Deliberately never finish the rate-limit body.
            } else {
                res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Recovered' }] } }] }));
            }
        });
        upstream.listen(0, '127.0.0.1');
        await once(upstream, 'listening');
        fetchMock.mockImplementation(nodeFetch);
        try {
            const response = await generate({ reverse_proxy: `http://127.0.0.1:${upstream.address().port}` });
            expect(await response.text()).toContain('Recovered');
            expect(attempts).toBe(13);
            for (const [, { signal }] of fetchMock.mock.calls.slice(0, 12)) {
                expect(signal.aborted).toBe(true);
                expect(getEventListeners(signal, 'abort')).toHaveLength(0);
            }
        } finally {
            upstream.closeAllConnections();
            await new Promise(resolve => upstream.close(resolve));
        }
    });

    test('retries when the auth mode defaults to Express', async () => {
        fetchMock.mockResolvedValueOnce(errorResponse());
        const response = await generate({ vertexai_auth_mode: undefined });
        expect(await response.text()).toContain('Hello');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(retryDelayMock).toHaveBeenCalledTimes(1);
    });

    test.each([false, true])('stops retrying when a different error follows a 429 with stream=%s', async (stream) => {
        fetchMock.mockResolvedValueOnce(errorResponse()).mockResolvedValueOnce(errorResponse(503));
        const response = await generate({ stream });
        expect(response.ok).toBe(false);
        expect((await response.json()).error.code).toBe(503);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(retryDelayMock).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['makersuite', 'express', false], ['makersuite', 'express', true],
        ['vertexai', 'full', false], ['vertexai', 'full', true],
    ])('does not retry 429 in %s/%s with stream=%s', async (source, mode, stream) => {
        let authRequests = 0;
        if (mode === 'full') {
            const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
            readSecretMock.mockReturnValue(JSON.stringify({
                project_id: 'service-project', client_email: 'test@example.com',
                private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
            }));
            fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'service-token' }) });
            authRequests = 1;
        }
        fetchMock.mockResolvedValueOnce(errorResponse());
        const response = await generate({ chat_completion_source: source, vertexai_auth_mode: mode, stream });
        expect(response.ok).toBe(false);
        expect((await response.json()).error.code).toBe(429);
        expect(fetchMock).toHaveBeenCalledTimes(authRequests + 1);
        expect(retryDelayMock).not.toHaveBeenCalled();
    });

    test.each([false, true])('cancels the retry wait immediately with stream=%s', async (stream) => {
        let notifyWaiting;
        const waiting = new Promise(resolve => { notifyWaiting = resolve; });
        retryDelayMock.mockImplementationOnce((ms, value, options) => {
            notifyWaiting(options.signal);
            return delay(ms, value, options);
        });
        fetchMock.mockResolvedValue(errorResponse());
        const controller = new AbortController();
        const pending = generate({ stream }, controller.signal).catch(error => error);
        const upstreamSignal = await waiting;
        const aborted = once(upstreamSignal, 'abort');
        controller.abort();

        const [error] = await Promise.all([pending, aborted]);
        expect(error).toMatchObject({ name: 'AbortError' });
        await expect(retryDelayMock.mock.results[0].value).rejects.toMatchObject({ name: 'AbortError' });
        expect(upstreamSignal.aborted).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(retryDelayMock).toHaveBeenCalledTimes(1);
    });

    test.each([false, true])('cancels an in-flight retry with stream=%s', async (stream) => {
        let notifyStarted;
        const started = new Promise(resolve => { notifyStarted = resolve; });
        fetchMock.mockResolvedValueOnce(errorResponse()).mockImplementationOnce((_url, { signal }) => {
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                notifyStarted(signal);
            });
        });
        const controller = new AbortController();
        const pending = generate({ stream }, controller.signal).catch(error => error);
        const upstreamSignal = await started;
        const aborted = once(upstreamSignal, 'abort');
        controller.abort();

        const [error] = await Promise.all([pending, aborted]);
        expect(error).toMatchObject({ name: 'AbortError' });
        await expect(fetchMock.mock.results[1].value).rejects.toMatchObject({ name: 'AbortError' });
        expect(upstreamSignal.aborted).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(retryDelayMock).toHaveBeenCalledTimes(1);
    });

    test.each([
        [false, 'auto', null], [false, 'min', 'LOW'], [false, 'low', 'LOW'],
        [true, 'medium', 'MEDIUM'], [true, 'high', 'HIGH'], [true, 'max', 'HIGH'],
    ])('sends thinking levels with stream=%s and effort=%s', async (stream, effort, level) => {
        const response = await generate({ stream, reasoning_effort: effort });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('Hello');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        const requestUrl = new URL(url);
        expect(requestUrl.origin).toBe('https://aiplatform.googleapis.com');
        expect(requestUrl.pathname).toBe(`/v1/projects/test-project/locations/global/publishers/google/models/${model}:${stream ? 'streamGenerateContent' : 'generateContent'}`);
        expect(options.headers['x-goog-api-key']).toBe('vertex-test-key');
        expect(requestUrl.searchParams.has('key')).toBe(false);
        expect(requestUrl.searchParams.get('alt')).toBe(stream ? 'sse' : null);
        const { generationConfig } = JSON.parse(options.body);
        expect(generationConfig.maxOutputTokens).toBe(8192);
        expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: true, ...(level ? { thinkingLevel: level } : {}) });
        for (const field of ['temperature', 'topP', 'topK', 'candidateCount']) {
            expect(generationConfig).not.toHaveProperty(field);
        }
    });

    test.each([
        [false, 'global'], [true, 'global'],
        [false, ' GLOBAL '], [true, ' GLOBAL '],
        [false, 'us-central1'], [true, 'us-central1'],
        [false, ''], [true, ''],
    ])('encodes the global resource location with stream=%s and region=%s', async (stream, region) => {
        const response = await generate({ stream, vertexai_region: region, vertexai_express_project_id: ' test-project ' });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('Hello');
        const requestUrl = new URL(fetchMock.mock.calls[0][0]);
        expect(requestUrl.origin).toBe('https://aiplatform.googleapis.com');
        expect(requestUrl.pathname).toBe(`/v1/projects/test-project/locations/global/publishers/google/models/${model}:${stream ? 'streamGenerateContent' : 'generateContent'}`);
        expect(requestUrl.searchParams.get('alt')).toBe(stream ? 'sse' : null);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test.each([undefined, '', '   '])('rejects missing project %s before an implicit-location request', async (projectId) => {
        const response = await generate({ vertexai_region: 'global', vertexai_express_project_id: projectId });
        expect(response.status).toBe(400);
        expect((await response.json()).error.message).toContain('Project ID is required');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test.each(['us', 'eu'])('preserves the explicit %s location', async (region) => {
        const response = await generate({ vertexai_region: region, vertexai_express_project_id: 'test-project' });
        expect(response.status).toBe(200);
        await response.text();
        const url = new URL(fetchMock.mock.calls[0][0]);
        expect(url.origin).toBe(`https://${region}-aiplatform.googleapis.com`);
        expect(url.pathname).toBe(`/v1/projects/test-project/locations/${region}/publishers/google/models/${model}:generateContent`);
    });

    test.each([
        [false, 100000, 32768], [true, 100000, 65536],
        [false, undefined, undefined], [true, undefined, undefined],
    ])('respects single-request output limits with stream=%s and max_tokens=%s', async (stream, maxTokens, expected) => {
        const response = await generate({ stream, max_tokens: maxTokens });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('Hello');
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).generationConfig.maxOutputTokens).toBe(expected);
    });

    test('preserves upstream model-access error details', async () => {
        const error = { code: 404, status: 'NOT_FOUND', message: `Publisher model ${model} is not available for this project.` };
        fetchMock.mockResolvedValueOnce({
            ok: false, status: 404, statusText: 'Not Found',
            text: async () => JSON.stringify({ error }),
        });
        const response = await generate();
        expect(response.ok).toBe(false);
        expect(await response.json()).toEqual({ error });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('keeps legacy model sampling and default region', async () => {
        const response = await generate({ model: 'gemini-2.5-pro', reasoning_effort: 'medium' });
        expect(response.status).toBe(200);
        await response.text();
        const [url, options] = fetchMock.mock.calls[0];
        expect(new URL(url).hostname).toBe('us-central1-aiplatform.googleapis.com');
        expect(JSON.parse(options.body).generationConfig).toEqual(expect.objectContaining({
            temperature: 0.7, topP: 0.9, topK: 40, candidateCount: 1,
            thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 },
        }));
    });

    test('keeps publisher-only Express requests for legacy models', async () => {
        const response = await generate({ model: 'gemini-2.5-pro', vertexai_express_project_id: '' });
        expect(response.status).toBe(200);
        await response.text();
        expect(fetchMock.mock.calls[0][0]).toBe('https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:generateContent');
    });

    test.each([false, true])('preserves an explicit reverse proxy with stream=%s', async (stream) => {
        const response = await generate({ stream, reverse_proxy: 'https://vertex-proxy.example/', proxy_password: 'proxy-key', vertexai_express_project_id: '' });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('Hello');
        const [url, options] = fetchMock.mock.calls[0];
        expect(new URL(url).origin).toBe('https://vertex-proxy.example');
        expect(options.headers.Authorization).toBe('Bearer proxy-key');
        expect(new URL(url).searchParams.get('alt')).toBe(stream ? 'sse' : null);
    });

    test.each([false, true])('uses the global project location in service-account mode with stream=%s', async (stream) => {
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        readSecretMock.mockReturnValue(JSON.stringify({
            project_id: 'service-project', client_email: 'test@example.com',
            private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        }));
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'service-token' }) });
        const response = await generate({ stream, vertexai_auth_mode: 'full', vertexai_region: ' GLOBAL ' });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('Hello');
        const [url, options] = fetchMock.mock.calls[1];
        expect(new URL(url).origin).toBe('https://aiplatform.googleapis.com');
        expect(new URL(url).pathname).toBe(`/v1/projects/service-project/locations/global/publishers/google/models/${model}:${stream ? 'streamGenerateContent' : 'generateContent'}`);
        expect(options.headers.Authorization).toBe('Bearer service-token');
    });
});
