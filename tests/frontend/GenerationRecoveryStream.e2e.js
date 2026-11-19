import { expect, test } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test('copied function JSON preserves Markdown, macros, and literal HTML inside arguments', async ({ page }) => {
    await testSetup.awaitST({ page });
    const args = { script: '```js\nlet value = "<b>&amp;</b>";\n```', story: '{{user}} 🌟', data: [false, null, 0] };
    const displayed = await page.evaluate(async args => {
        const { chat, messageFormatting } = await import('/script.js');
        const text = '```json\n' + JSON.stringify({ name: 'capture', args }, null, 2) + '\n```';
        const prefix = '**Existing reply**\n\n';
        const mes = prefix + text + '\n\n' + text;
        const id = chat.push({ mes, extra: { generation_call_blocks: [prefix.length, prefix.length + text.length + 2] } }) - 1;
        try {
            const el = document.createElement('div');
            el.innerHTML = messageFormatting(mes, 'Character', false, false, id);
            return { prefix: el.querySelector('strong')?.textContent, values: Array.from(el.querySelectorAll('pre code'), code => JSON.parse(code.textContent)) };
        } finally {
            chat.pop();
        }
    }, args);
    expect(displayed).toEqual({ prefix: 'Existing reply', values: [{ name: 'capture', args }, { name: 'capture', args }] });
});

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
