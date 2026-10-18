import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const secrets = await import('../src/endpoints/secrets.js');
const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({
    ...secrets,
    readSecret: jest.fn(() => 'vertex-test-key'),
}));

describe('Vertex AI Express Gemini 4 Argon', () => {
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
        fetchMock.mockReset().mockImplementation(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            body: Readable.from(['data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n']),
            json: async () => ({ candidates: [{ content: { parts: [{ text: 'Hello' }] } }] }),
        }));
    });

    async function generate(overrides = {}) {
        return fetch(`${baseUrl}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_completion_source: 'vertexai', vertexai_auth_mode: 'express',
                model: 'gemini-4-argon', messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 8192, temperature: 0.7, top_p: 0.9, top_k: 40,
                include_reasoning: true, ...overrides,
            }),
        });
    }

    test.each([
        [false, 'auto', null], [false, 'min', 'low'],
        [true, 'medium', 'medium'], [true, 'max', 'high'],
    ])('sends thinking levels with stream=%s and effort=%s', async (stream, effort, level) => {
        const response = await generate({ stream, reasoning_effort: effort });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('Hello');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        const requestUrl = new URL(url);
        expect(requestUrl.origin).toBe('https://aiplatform.googleapis.com');
        expect(requestUrl.pathname).toBe(`/v1/publishers/google/models/gemini-4-argon:${stream ? 'streamGenerateContent' : 'generateContent'}`);
        expect(requestUrl.searchParams.get('key')).toBe('vertex-test-key');
        expect(requestUrl.searchParams.get('alt')).toBe(stream ? 'sse' : null);
        const { generationConfig } = JSON.parse(options.body);
        expect(generationConfig.thinkingConfig).toEqual({ includeThoughts: true, ...(level ? { thinkingLevel: level } : {}) });
        for (const field of ['temperature', 'topP', 'topK', 'candidateCount']) {
            expect(generationConfig).not.toHaveProperty(field);
        }
    });

    test('supports API key requests with an explicit project and location', async () => {
        const response = await generate({ vertexai_express_project_id: 'test-project', vertexai_region: 'global' });
        expect(response.status).toBe(200);
        await response.text();
        expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe('/v1/projects/test-project/locations/global/publishers/google/models/gemini-4-argon:generateContent');
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
});
