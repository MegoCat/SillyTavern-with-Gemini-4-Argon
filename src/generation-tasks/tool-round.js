import { buildRecoveredMessage, chatFingerprintInput, parseVertexReply, planRecovery } from '../../public/scripts/util/generation-recovery.js';
import { hash, taskError, validateId } from './store.js';

const historyHash = messages => hash(chatFingerprintInput(messages));
const changed = () => taskError('原聊天记录已改变，工具恢复已暂停。', 409);

function checkHistory(messages, round) {
    if (historyHash(messages) !== round.history || historyHash(messages.slice(0, round.baseLength)) !== round.baseHash) throw changed();
}

function invocations(task, reply) {
    return task.toolRound.steps.map((step, index) => {
        const call = reply.toolCalls[index];
        return {
            id: call.id || `${task.id}-${index}`, name: call.name, displayName: step.displayName,
            parameters: JSON.stringify(call.args), result: step.result, error: step.error,
            signature: call.signature, reasoning: reply.reasoning || null,
        };
    });
}

/** Each dispatch is recorded before the browser receives permission to invoke the extension. */
export function registerToolRoutes(router, route, getStore, readChat, writeChat) {
    function post(action, handler) {
        router.post(`/recovery/:id/tools/${action}`, route((req, res) => {
            const store = getStore(req);
            const task = store.require(req.params.id);
            if (task.status !== 'completed' || !task.toolRound || task.acknowledged) throw taskError('工具任务已结束或已取消。', 409);
            const round = task.toolRound;
            const reply = () => parseVertexReply(store.result(task.id).toString('utf8'), task.stream);
            // Publish a checkpoint in memory only after its file has been replaced successfully.
            const save = (fields, bytes = 0) => {
                const next = { ...task, updatedAt: Date.now(), bytes: task.bytes + bytes, toolRound: { ...round, ...fields } };
                store.persist(next);
                Object.assign(task, next);
            };
            res.json(handler({ req, task, round, store, reply, save, body: req.body ?? {} }));
        }));
    }

    post('prepare', ({ req, task, round, store, reply, save, body }) => {
        const saved = readChat(req, task);
        if (!round.baseHash) {
            let edit;
            try { edit = planRecovery(saved.messages, task.context, task.id, hash); } catch { throw changed(); }
            if (edit.kind === 'already') throw changed();
            const result = reply();
            if (typeof body.text !== 'string' || typeof body.reasoning !== 'string' || Buffer.byteLength(body.text + body.reasoning) > store.options.maxBytes) throw taskError('Invalid intermediate reply.');
            const keep = Boolean(body.text.trim() || body.reasoning.trim() || task.context.type === 'swipe');
            const replacement = keep ? [buildRecoveredMessage(task.context, result, task,
                { text: body.text, reasoning: body.reasoning, intermediate: true })] : [];
            saved.messages.splice(edit.index, saved.messages.length - edit.index, ...replacement);
            const baseHash = historyHash(saved.messages);
            writeChat(req, task, saved);
            save({ index: edit.index, keep, baseLength: saved.messages.length, baseHash, history: baseHash });
        }
        const state = task.toolRound;
        const tail = saved.messages.at(-1);
        // A committed transcript is itself a receipt if its HTTP response or metadata write was lost.
        const committed = tail?.extra?.generation_tool_parent === task.id;
        if (committed) {
            checkHistory(saved.messages.slice(0, -1), state);
        } else {
            checkHistory(saved.messages, state);
        }
        const done = state.steps.length === state.count;
        return {
            index: state.index, intermediate: state.keep ? saved.messages[state.index] : null,
            history: state.history, committed: committed ? tail : null,
            completed: state.steps.length, running: state.running?.name,
            invocations: done && !state.steps.some(step => step.stealth) ? invocations(task, reply()) : [],
        };
    });

    post('start', ({ req, task, round, reply, save, body }) => {
        validateId(body.ticket);
        if (round.running?.ticket === body.ticket && body.index === round.steps.length) return { ok: true };
        if (!round.baseHash || round.running || body.index !== round.steps.length || body.index >= round.count) throw taskError('工具已被领取或处理。', 409);
        checkHistory(readChat(req, task).messages, round);
        const call = reply().toolCalls[body.index];
        save({ running: { name: call.name, ticket: body.ticket, stealth: body.stealth === true } });
        return { ok: true };
    });

    post('finish', ({ task, round, store, save, body }) => {
        validateId(body.ticket);
        if (round.steps[body.index]?.ticket === body.ticket) return { ok: true };
        if (!round.running || body.index !== round.steps.length || round.running.ticket !== body.ticket) throw taskError('工具执行凭据已失效。', 409);
        if (typeof body.result !== 'string' || typeof body.displayName !== 'string' || body.displayName.length > 512
            || !/^[a-f0-9]{64}$/.test(body.history)) throw taskError('Invalid tool result.');
        const step = { ticket: body.ticket, stealth: round.running.stealth, displayName: body.displayName, result: body.result, error: body.error === true };
        const bytes = Buffer.byteLength(JSON.stringify(step));
        const reserved = [...store.records.values()].filter(r => !r.acknowledged)
            .reduce((sum, r) => sum + (r.status === 'running' ? store.options.maxBytes : r.bytes), 0);
        if (task.bytes + bytes > store.options.maxBytes || reserved + bytes > store.options.maxStoredBytes) throw taskError('工具结果超过恢复缓存上限。', 413);
        save({ running: null, steps: [...round.steps, step], history: body.history }, bytes);
        return { ok: true };
    });

    post('skip', ({ req, task, round, save, body }) => {
        if (!round.running || body.index !== round.steps.length) throw taskError('工具状态已改变。', 409);
        const messages = readChat(req, task).messages;
        if (historyHash(messages.slice(0, round.baseLength)) !== round.baseHash) throw changed();
        const step = { displayName: round.running.name, stealth: round.running.stealth, error: true, result: 'The user skipped this tool after disconnection. Its outcome is unknown. Do not repeat it.' };
        save({ running: null, steps: [...round.steps, step], history: historyHash(messages) });
        return { ok: true };
    });

    post('commit', ({ req, task, round, store, reply, save, body }) => {
        if (!round.baseHash || round.steps.length !== round.count) throw taskError('工具调用尚未全部完成。', 409);
        const saved = readChat(req, task);
        let message = saved.messages.at(-1);
        if (message?.extra?.generation_tool_parent !== task.id) {
            checkHistory(saved.messages, round);
            if (round.steps.some(step => step.stealth)) {
                store.acknowledge(task.id);
                return { stop: true };
            }
            const formatted = body.message;
            if (typeof formatted?.mes !== 'string' || typeof formatted.name !== 'string' || typeof formatted.force_avatar !== 'string' || Buffer.byteLength(formatted.mes) > store.options.maxBytes) throw taskError('Invalid tool transcript.');
            message = {
                name: formatted.name, force_avatar: formatted.force_avatar, is_system: true, is_user: false, mes: formatted.mes,
                extra: { isSmallSys: true, api: 'vertexai', model: task.model, tool_invocations: invocations(task, reply()), generation_tool_parent: task.id },
            };
            saved.messages.push(message);
            writeChat(req, task, saved);
        } else {
            checkHistory(saved.messages.slice(0, -1), round);
        }
        const history = historyHash(saved.messages);
        if (round.committedHash !== history) save({ committedHash: history });
        return { message, history, nextId: round.nextId };
    });
}
