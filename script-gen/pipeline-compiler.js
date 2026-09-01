// === pipeline-compiler.js ===
/**
 * @module pipeline-compiler
 * @description Compiles a pipeline JSON recipe into an AST suitable for
 *   consumption by the script emitters (Python, Node, Lua).
 *   Also validates the pipeline structure and resolves step references.
 *
 * @dependencies logger
 */

import { logger } from '../utils/logger.js';
import { isExportableStepType, STEP_TYPES } from '../utils/step-types.js';

const MODULE = 'pipeline-compiler';

/**
 * Compile and validate a pipeline recipe into an AST.
 * @param {object} recipe - Raw pipeline JSON
 * @returns {{ ast: object, errors: string[] }}
 */
export function compilePipeline(recipe) {
  const errors = [];
  if (!recipe || typeof recipe !== 'object') {
    return { ast: null, errors: ['Pipeline must be an object'] };
  }
  if (!Array.isArray(recipe.steps)) {
    return { ast: null, errors: ['Pipeline must have a steps array'] };
  }

  const mapSteps = (stepList) => {
    if (!Array.isArray(stepList)) return [];
    return stepList.map((step, i) => {
      if (!step.type) errors.push(`Step ${i + 1} is missing a type`);
      const mapped = {
        id:     step.id ?? `step_${i + 1}`,
        type:   (step.type ?? '').toUpperCase(),
        label:  step.label ?? step.type ?? `Step ${i + 1}`,
        config: step.config ?? {},
      };
      if (Array.isArray(step.children)) {
        mapped.children = mapSteps(step.children);
      }
      if (Array.isArray(step.ifBranch)) {
        mapped.ifBranch = mapSteps(step.ifBranch);
      }
      if (Array.isArray(step.elseBranch)) {
        mapped.elseBranch = mapSteps(step.elseBranch);
      }
      return mapped;
    });
  };

  const steps = mapSteps(recipe.steps);

  const ast = {
    name:         recipe.name ?? 'Untitled',
    version:      recipe.version ?? '3.0.0',
    targetOrigin: recipe.targetOrigin ?? '',
    steps,
    meta: {
      compiledAt: new Date().toISOString(),
      stepCount:  steps.length,
    },
  };

  logger.info(MODULE, 'compiled', { name: ast.name, steps: steps.length, errors: errors.length });
  return { ast, errors };
}

/**
 * Serialize a pipeline to a safe shareable JSON string.
 * Strips any sensitive config values (proxy credentials, API keys).
 * @param {object} pipeline
 * @returns {string}
 */
export function serializePipeline(pipeline) {
  const REDACT = /pass(word)?|secret|token|key|cred|auth/i;
  const sanitize = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (REDACT.test(k)) out[k] = '[REDACTED]';
      else if (typeof v === 'object') out[k] = sanitize(v);
      else out[k] = v;
    }
    return out;
  };
  return JSON.stringify(sanitize(pipeline), null, 2);
}

/**
 * Steps the script emitters cannot express.
 *
 * The emitters used to fall through to a `# TODO` comment for anything they did
 * not handle, so an exported script looked complete, ran, and silently did less
 * than the pipeline it came from. Callers use this to tell the user what will
 * be missing before they download it.
 *
 * @param {object} ast - compiled pipeline
 * @returns {Array<{ id: string, type: string, reason: string }>}
 */
export function findUnexportableSteps(ast) {
  const found = [];

  const walk = (steps) => {
    for (const step of Array.isArray(steps) ? steps : []) {
      if (!isExportableStepType(step.type)) {
        found.push({
          id: step.id ?? null,
          type: step.type,
          reason: STEP_TYPES[step.type]
            ? 'runs inside the extension and has no standalone equivalent'
            : 'unknown step type',
        });
      }
      walk(step.children);
      walk(step.ifBranch);
      walk(step.elseBranch);
    }
  };

  walk(ast?.steps);
  return found;
}

// === END pipeline-compiler.js ===
