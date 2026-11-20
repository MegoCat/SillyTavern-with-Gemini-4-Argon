import { expect, test } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test('selects Neon in Vertex Express and sends maximum effort with thought summaries hidden', async ({ page }) => {
    let request;
    await page.route('**/api/backends/chat-completions/generate', route => {
        request = route.request().postDataJSON();
        return route.fulfill({ json: { responseContent: { parts: [
            { thought: true, text: 'Summary' },
            { text: 'Hello', thoughtSignature: 'text-signature' },
            { functionCall: { name: 'lookup' }, thoughtSignature: 'tool-signature' },
        ] } } });
    });
    await page.route('**/api/settings/save', route => route.fulfill({ json: { ok: true } }));
    await testSetup.awaitST({ page });
    const signature = await page.evaluate(async () => {
        const { sendOpenAIRequest } = await import('/scripts/openai.js');
        const { extractReasoningSignatureFromData } = await import('/scripts/reasoning.js');
        $('#chat_completion_source').val('vertexai').trigger('change');
        $('#vertexai_auth_mode').val('express').trigger('change');
        $('#vertexai_region').val('us-central1').trigger('input');
        $('#model_vertexai_select').val('gemini-4-neon').trigger('change');
        $('#openai_reasoning_effort').val('max').trigger('input');
        $('#openai_show_thoughts').prop('checked', false).trigger('input');

        const reply = await sendOpenAIRequest('quiet', [{ role: 'user', content: 'Hello' }], new AbortController().signal);
        return extractReasoningSignatureFromData(reply, { mainApi: 'openai' });
    });
    expect(request).toMatchObject({
        model: 'gemini-4-neon', vertexai_auth_mode: 'express', vertexai_region: 'global',
        reasoning_effort: 'max', include_reasoning: false,
    });
    expect(signature).toBe('text-signature');
});

test('tool call details omit the thought signature and keep the signed invocation for the next turn', async ({ page }) => {
    await testSetup.awaitST({ page });
    const result = await page.evaluate(async () => {
        const { ToolManager } = await import('/scripts/tool-calling.js');
        const message = ToolManager.createToolInvocationMessage([{
            name: 'verify', parameters: '{"signature":"document"}', result: '{"valid":true}',
            reasoning: 'Checked the document', signature: 'opaque-tool-signature',
        }]);
        const doc = new DOMParser().parseFromString(message.mes, 'text/html');
        return { details: JSON.parse(doc.querySelector('code').textContent), signature: message.extra.tool_invocations[0].signature };
    });
    expect(result.details).toEqual([{
        name: 'verify', parameters: { signature: 'document' }, result: { valid: true }, reasoning: 'Checked the document',
    }]);
    expect(result.signature).toBe('opaque-tool-signature');
});
