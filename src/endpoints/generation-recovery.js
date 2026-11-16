import express from 'express';
import sanitize from 'sanitize-filename';
import { buildGenerationRecoveryRouter } from '../generation-tasks/router.js';

/** Mount inside the existing authenticated and CSRF-protected API. */
export function createGenerationRecoveryRouter(backendRouter) {
    return buildGenerationRecoveryRouter(backendRouter, () => express.Router(), sanitize);
}
