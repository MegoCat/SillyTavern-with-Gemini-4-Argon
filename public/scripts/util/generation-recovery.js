/** Pure helpers shared by the recovery server, the browser extension, and tests. */
export const RECOVERY_VERSION = 1;
export const RECOVERY_TYPES = ['normal', 'regenerate', 'continue', 'swipe'];

/** Stable serialization avoids treating object key order as a chat edit. */
export function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(x => stableStringify(x ?? null)).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/** Ignore display/timing counters, but retain content, attachments, and swipe selection. */
export function chatFingerprintInput(messages) {
    return stableStringify(messages.map(message => {
        const swipes = message.swipes?.length ? message.swipes : [message.mes ?? ''];
        return {
            name: message.name ?? '',
            text: message.mes ?? '',
            user: Boolean(message.is_user),
            system: Boolean(message.is_system),
            date: message.send_date ?? '',
            swipe: Math.max(0, Math.min(message.swipe_id ?? 0, swipes.length - 1)),
            swipes,
            reasoning: message.extra?.reasoning ?? '',
            signature: message.extra?.reasoning_signature ?? null,
            media: message.extra?.media ?? null,
            image: message.extra?.image ?? null,
            file: message.extra?.file ?? null,
            tools: message.extra?.tool_invocations ?? null,
            avatar: message.original_avatar ?? null,
        };
    }));
}

export function hasCompletedTask(message, id) {
    const extra = message?.extra;
    return Boolean(extra && ((extra.generation_task_id === id && extra.generation_task_complete === true)
        || extra.generation_task_ids?.includes(id)
        || message.swipe_info?.some(s => s?.extra?.generation_task_ids?.includes(id))));
}

export function markTask(message, id, complete) {
    message.extra ??= {};
    message.extra.generation_task_id = id;
    message.extra.generation_task_complete = complete;
    if (complete) {
        message.extra.generation_task_ids = [...new Set([...(message.extra.generation_task_ids ?? []), id])].slice(-128);
    }
    const swipe = message.swipe_info?.[message.swipe_id];
    if (swipe) {
        swipe.extra ??= {};
        swipe.extra.generation_task_id = id;
        swipe.extra.generation_task_complete = complete;
        if (complete) swipe.extra.generation_task_ids = [...message.extra.generation_task_ids];
    }
}

/** Return a narrowly-scoped edit, never replace an entire chat with a stale snapshot. */
export function planRecovery(messages, context, id, hash) {
    const existing = messages.findIndex(message => hasCompletedTask(message, id));
    if (existing >= 0) return { kind: 'already', index: existing };
    const count = context.baseLength;
    const baseMatches = messages.length === count && hash(chatFingerprintInput(messages)) === context.baseHash;
    const appending = context.type === 'normal' || context.type === 'regenerate';
    if (baseMatches) return { kind: appending ? 'append' : 'replace', index: appending ? count : count - 1 };
    const index = appending ? count : count - 1;
    const expectedLength = appending ? count + 1 : count;
    const prefixLength = appending ? count : count - 1;
    const prefixHash = appending ? context.baseHash : context.prefixHash;
    if (messages.length === expectedLength && messages[index]?.extra?.generation_task_id === id
        && messages[index]?.extra?.generation_task_complete !== true
        && !messages[index]?.extra?.generation_task_edited
        && hash(chatFingerprintInput(messages.slice(0, prefixLength))) === prefixHash) {
        return { kind: 'replace', index };
    }
    throw new Error('This chat has changed since generation started. The saved reply was kept; no messages were overwritten.');
}

/** Parse a complete Vertex response, retaining all text parts and the opaque signature. */
export function parseVertexReply(body, stream) {
    const result = { text: '', reasoning: '', signature: null, finishReason: null, hasTools: false, hasImages: false };
    let sawTerminal = !stream;
    const consumeParts = (parts) => {
        for (const part of parts ?? []) {
            if (part.functionCall) result.hasTools = true;
            if (part.inlineData || part.fileData) result.hasImages = true;
            if (typeof part.text === 'string') {
                if (part.thought) result.reasoning += part.text;
                else result.text += part.text;
            }
            if (part.thoughtSignature && !part.thought) result.signature = part.thoughtSignature;
        }
    };
    const consume = (data) => {
        if (data?.error) throw new Error(data.error.message || 'The model returned an error.');
        if (data?.promptFeedback?.blockReason) throw new Error(`Prompt blocked: ${data.promptFeedback.blockReason}`);
        const candidate = data?.candidates?.[0];
        if (candidate) {
            consumeParts(candidate.content?.parts);
            if (candidate.finishReason) {
                result.finishReason = candidate.finishReason;
                sawTerminal = true;
            }
        } else if (data?.responseContent) {
            // Non-streaming ST responses are wrapped in an OpenAI-like envelope.
            consumeParts(data.responseContent.parts);
            result.text = data.choices?.[0]?.message?.content ?? result.text;
        } else if (data?.choices) {
            result.text += data.choices[0]?.message?.content ?? '';
        }
    };
    if (stream) {
        const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        for (const event of normalized.split('\n\n')) {
            const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            if (data.trim() === '[DONE]') { sawTerminal = true; continue; }
            consume(JSON.parse(data));
        }
    } else {
        consume(JSON.parse(body));
    }
    if (!sawTerminal) throw new Error('The upstream stream ended without a final result. Partial text will not be restored automatically.');
    if (!result.text && !result.reasoning && !result.hasTools && !result.hasImages) throw new Error('The model returned no reply.');
    return result;
}

/** Build a text message without using the browser's mutable current-chat globals. */
export function buildRecoveredMessage(context, reply, task, { text = reply.text, reasoning = reply.reasoning } = {}) {
    if (reply.hasTools || reply.hasImages) throw new Error('Automatic recovery currently supports text replies without tool calls or generated media.');
    const replacing = context.type === 'continue' || context.type === 'swipe';
    const message = replacing ? structuredClone(context.baseLast) : {
        name: context.characterName,
        is_user: false,
        is_system: false,
        extra: {},
    };
    if (!message || message.is_user) throw new Error('The original assistant message is unavailable.');
    message.extra ??= {};
    const previousReasoning = context.type === 'continue' ? (message.extra.reasoning ?? '') : '';
    message.mes = text;
    message.send_date = new Date(task.updatedAt).toISOString();
    message.gen_started = new Date(task.createdAt).toISOString();
    message.gen_finished = new Date(task.updatedAt).toISOString();
    Object.assign(message.extra, {
        api: 'vertexai', model: task.model,
        reasoning: previousReasoning + reasoning,
        reasoning_signature: reply.signature ?? (context.type === 'continue' ? message.extra.reasoning_signature : null),
        reasoning_duration: null,
    });
    delete message.extra.token_count;
    if (context.type === 'swipe') {
        message.swipes ??= [context.baseLast.mes ?? ''];
        message.swipe_info ??= [];
        message.swipe_id = message.swipes.length;
        message.swipes.push(text);
    } else if (context.type === 'continue') {
        message.swipes ??= [context.baseLast.mes ?? ''];
        message.swipe_id = Math.max(0, Math.min(message.swipe_id ?? 0, message.swipes.length - 1));
        message.swipes[message.swipe_id] = text;
    } else {
        message.swipe_id = 0;
        message.swipes = [text];
        message.swipe_info = [];
    }
    markTask(message, task.id, true);
    message.swipe_info ??= [];
    message.swipe_info[message.swipe_id] = {
        send_date: message.send_date, gen_started: message.gen_started, gen_finished: message.gen_finished,
        extra: structuredClone(message.extra),
    };
    return message;
}
