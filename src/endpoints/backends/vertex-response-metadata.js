import { createInterface } from 'node:readline';
import { tryParse } from '../../util.js';
import { stableStringify } from '../../../public/scripts/util/generation-recovery.js';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// An event can update just one nested field. Arrays and scalar values are snapshots.
function mergeFields(previous, next) {
    if (!isObject(previous) || !isObject(next)) return next;
    const entries = Object.entries(next).map(([key, value]) => [
        key, Object.hasOwn(previous, key) ? mergeFields(previous[key], value) : value,
    ]);
    return { ...previous, ...Object.fromEntries(entries) };
}

function partMetadata(part) {
    if (!isObject(part)) return part;
    const fields = { ...part };
    if (typeof part.text === 'string') delete fields.text;
    if (typeof part.inlineData?.data === 'string') {
        fields.inlineData = { ...part.inlineData };
        delete fields.inlineData.data;
    }
    return Object.keys(fields).length ? fields : undefined;
}

/** Keep provider-defined fields, without collecting the chat text or inline media bytes. */
export class VertexResponseMetadata {
    /** @type {Record<string, any>} */
    fields = {};
    candidates = new Map();

    add(packet) {
        if (!isObject(packet)) return false;
        if (!Array.isArray(packet.candidates)) {
            if (Object.hasOwn(packet, 'candidates')) this.candidates.clear();
            this.fields = mergeFields(this.fields, packet);
            return true;
        }
        const { candidates, ...fields } = packet;
        this.fields = mergeFields(this.fields, fields);
        if (!candidates.length) this.fields.candidates = [];
        else delete this.fields.candidates;
        for (const [position, candidate] of candidates.entries()) {
            const index = candidate?.index ?? position;
            const entry = this.candidates.get(index) ?? { fields: {}, parts: new Map() };
            this.candidates.set(index, entry);
            if (!isObject(candidate)) {
                entry.fields = candidate;
                entry.parts.clear();
                continue;
            }
            const fields = { ...candidate };
            for (const key of ['content', 'output']) {
                if (!Object.hasOwn(fields, key)) continue;
                const content = fields[key];
                if (typeof content === 'string') delete fields[key];
                if (!Array.isArray(content?.parts)) {
                    if (content === null || (isObject(content) && Object.hasOwn(content, 'parts'))) entry.parts.delete(key);
                    continue;
                }
                const { parts, ...attributes } = content;
                if (Object.keys(attributes).length) fields[key] = attributes;
                else delete fields[key];
                // Part positions restart in each SSE event. Keep distinct metadata from any part.
                for (const part of parts) {
                    const meta = partMetadata(part);
                    if (meta === undefined) continue;
                    if (!entry.parts.has(key)) entry.parts.set(key, new Map());
                    entry.parts.get(key).set(stableStringify(meta), meta);
                }
            }
            entry.fields = mergeFields(entry.fields, fields);
        }
        return true;
    }

    snapshot() {
        const result = { ...this.fields };
        const candidates = [];
        for (const entry of this.candidates.values()) {
            if (!isObject(entry.fields)) {
                candidates.push(entry.fields);
                continue;
            }
            const candidate = { ...entry.fields };
            for (const [key, parts] of entry.parts) {
                candidate[key] = { ...candidate[key], parts: [...parts.values()] };
            }
            candidates.push(candidate);
        }
        if (candidates.some(candidate => !isObject(candidate) || Object.keys(candidate).length)) result.candidates = candidates;
        return result;
    }

    observeStream(source) {
        const reader = createInterface({ input: source, crlfDelay: Infinity, terminal: false });
        let data = [];
        let firstLine = true;
        const dispatch = () => {
            if (!data.length) return;
            const payload = data.join('\n');
            data = [];
            if (payload.trim() !== '[DONE]') this.add(tryParse(payload));
        };
        reader.on('line', line => {
            if (firstLine) {
                line = line.replace(/^\uFEFF/, '');
                firstLine = false;
            }
            if (!line) dispatch();
            else if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5));
        });
        reader.once('close', dispatch);
        // The existing stream handler owns errors and cancellation. Drop any incomplete event.
        reader.on('error', () => { data = []; reader.close(); });
    }
}
