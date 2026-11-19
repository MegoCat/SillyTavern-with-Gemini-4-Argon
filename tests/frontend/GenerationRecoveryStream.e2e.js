import { expect, test } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test('chat completions distinguishes a truncated recovery stream from legacy EOF', async ({ page }) => {
    const chunk = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n';
    const tracked = { 'X-Generation-Stream-End': 'generation-complete' };
    const responses = [
        { headers: tracked, body: chunk + 'data: [DONE]\n\n' },
        { headers: tracked, body: chunk + 'event: generation-complete\ndata: [DONE]\n\n' },
        { body: chunk },
    ];
    let requests = 0;
    await page.route('**/api/backends/chat-completions/generate', route =>
        route.fulfill({ contentType: 'text/event-stream', ...responses[requests++] }));
    await testSetup.awaitST({ page });
    const results = await page.evaluate(async () => {
        const { oai_settings, sendOpenAIRequest } = await import('/scripts/openai.js');
        const { eventSource, event_types } = await import('/scripts/events.js');
        const { chat_completion_source, stream_openai, reverse_proxy } = oai_settings;
        const read = async () => {
            Object.assign(oai_settings, { chat_completion_source: 'vertexai', stream_openai: true, reverse_proxy: '' });
            let text = '';
            try {
                const stream = await sendOpenAIRequest('impersonate', [{ role: 'user', content: 'Test' }], new AbortController().signal);
                for await (const part of stream()) text = part.text;
                return { text };
            } catch (error) {
                return { text, error: error.message };
            }
        };
        try {
            const truncated = await read();
            const complete = await read();
            const legacy = await read();
            eventSource.once(event_types.CHAT_COMPLETION_SETTINGS_READY, (_data, preparation) => preparation.abort(new Error('Chat changed')));
            const cancelled = await read();
            return { truncated, complete, legacy, cancelled };
        } finally {
            Object.assign(oai_settings, { chat_completion_source, stream_openai, reverse_proxy });
        }
    });
    expect(results.truncated.text).toBe('Hello');
    expect(results.truncated.error).toContain('before the final reply');
    expect(results.complete).toEqual({ text: 'Hello' });
    expect(results.legacy).toEqual({ text: 'Hello' });
    expect(results.cancelled).toEqual({ text: '', error: 'Chat changed' });
    expect(requests).toBe(3);
});
