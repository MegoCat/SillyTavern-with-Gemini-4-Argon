import childProcess from 'node:child_process';
import { createInterface } from 'node:readline';
import { CHAT_COMPLETION_SOURCES } from './constants.js';

const messages = {
    completed: 'AI 回复已就绪。',
    failed: 'AI 回复生成失败，请打开酒馆查看。',
};

function sendTermuxNotification(status) {
    if (!Object.hasOwn(messages, status)) return;
    childProcess.execFile('termux-notification', ['--title', 'SillyTavern', '--content', messages[status]], { timeout: 5000 }, (error) => {
        if (error) {
            console.warn('Termux notification failed:', error.code === 'ENOENT'
                ? 'Install the Termux:API app and the termux-api package.'
                : error.message);
        }
    }).stdin?.end();
}

/** Only interactive generation requests from a user who enabled the setting opt in. */
export function getTermuxNotifier(request) {
    return request.headers['x-st-termux-notify'] === '1' ? sendTermuxNotification : undefined;
}

function isErrorPayload(data) {
    return !data || data.error || data.type === 'error' || data.promptFeedback?.blockReason
        || data.choices?.[0]?.finish_reason === 'error';
}

/** Observe one SSE event at a time. Ollama supplies one JSON object per line. */
function observeStream(source, jsonLines, onPayload, onError) {
    const lines = createInterface({ input: source, crlfDelay: Infinity });
    let data = [];
    let firstLine = true;
    const consume = (value) => {
        if (!value.trim()) return;
        if (value.trim() === '[DONE]') return onPayload('[DONE]');
        try {
            onPayload(JSON.parse(value));
        } catch {
            onPayload(null);
        }
    };
    const dispatch = () => {
        if (data.length) consume(data.join('\n'));
        data = [];
    };
    lines.on('line', line => {
        if (firstLine) {
            line = line.replace(/^\uFEFF/, '');
            firstLine = false;
        }
        if (jsonLines) {
            if (line) consume(line);
        } else if (!line) {
            dispatch();
        } else if (line.startsWith('data:')) {
            data.push(line.slice(5).trimStart());
        } else if (line.startsWith('event:') && line.slice(6).trim() === 'error') {
            onPayload(null);
        }
    });
    lines.once('close', dispatch);
    lines.once('error', onError);
    source.once('close', () => {
        if (!source.readableEnded) onError();
    });
}

/** Watch the final response, after any upstream retries. A disconnected client may have cancelled it. */
export function observeGenerationResponse(request, response, next) {
    const notify = getTermuxNotifier(request);
    if (!notify) return next();

    const geminiStream = request.body?.stream && [CHAT_COMPLETION_SOURCES.VERTEXAI, CHAT_COMPLETION_SOURCES.MAKERSUITE].includes(request.body.chat_completion_source);
    let received = false;
    let failed = false;
    let notified = false;
    // Gemini may close cleanly after partial text or send a finish reason with no reply.
    let waitingForFinishReason = geminiStream;
    const report = (status) => {
        if (notified || request.socket.destroyed) return;
        notified = true;
        notify(status);
    };
    const onPayload = (data) => {
        if (data === '[DONE]') {
            waitingForFinishReason = false;
            return;
        }
        if (geminiStream) {
            const candidate = data?.candidates?.[0];
            if (candidate?.finishReason) waitingForFinishReason = false;
            received ||= Boolean(candidate?.content?.parts?.length || candidate?.output);
        } else {
            received = true;
        }
        if (isErrorPayload(data)) failed = true;
    };
    const json = response.json;
    response.json = function (body) {
        onPayload(body);
        return json.call(this, body);
    };
    response.locals.observeGenerationStream = (upstream, jsonLines = false) => {
        if (!upstream.ok) {
            failed = true;
            return;
        }
        observeStream(upstream.body, jsonLines, onPayload, () => report('failed'));
    };
    response.once('finish', () => {
        const completed = received && !failed && !waitingForFinishReason && response.statusCode < 400;
        report(completed ? 'completed' : 'failed');
    });
    next();
}
