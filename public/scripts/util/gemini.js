export const GEMINI_4_MODELS = ['gemini-4-argon', 'gemini-4-carbon', 'gemini-4-neon'];

/**
 * Resolve a supported Gemini 4 model ID, including versioned model names.
 * @param {string} model Google model name
 * @returns {string|undefined} Base model ID
 */
export function getGemini4Model(model) {
    const modelId = model?.split('/').pop() ?? '';
    return GEMINI_4_MODELS.find(id => modelId === id || modelId.startsWith(`${id}-`));
}
