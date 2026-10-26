'use strict';
// Agent cards (system prompts), tool grants, and the output schemas the runner
// enforces. Repo copies in .fleet/agents/ override the kit's defaults so a team
// can tune a prompt without forking the kit.
const fs = require('fs');
const path = require('path');
const { KIT_ROOT } = require('./config');

const ROLES = ['planner', 'planner-deep', 'builder-light', 'builder', 'builder-deep', 'reviewer', 'reviewer-deep', 'publisher'];

const TOOLS = {
  planner: { tools: ['Read', 'Grep', 'Glob', 'Bash'], disallowed: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'WebFetch', 'WebSearch'] },
  'planner-deep': { tools: ['Read', 'Grep', 'Glob', 'Bash'], disallowed: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'WebFetch', 'WebSearch'] },
  'builder-light': { tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'MultiEdit'], disallowed: ['Agent', 'WebSearch'] },
  builder: { tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'MultiEdit'], disallowed: ['Agent', 'WebSearch'] },
  'builder-deep': { tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'MultiEdit', 'WebFetch'], disallowed: ['Agent', 'WebSearch'] },
  reviewer: { tools: ['Read', 'Grep', 'Glob', 'Bash'], disallowed: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent'] },
  'reviewer-deep': { tools: ['Read', 'Grep', 'Glob', 'Bash'], disallowed: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent'] },
  publisher: { tools: ['Read', 'Grep', 'Glob', 'Bash'], disallowed: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent'] },
};

function loadCard(root, name) {
  const repoCard = path.join(root, '.fleet', 'agents', `${name}.md`);
  const kitCard = path.join(KIT_ROOT, 'agents', `${name}.md`);
  const file = fs.existsSync(repoCard) ? repoCard : kitCard;
  return fs.readFileSync(file, 'utf8');
}

/** Full system prompt for a role: role card + shared rules + role-family procedure. */
function systemPrompt(root, role) {
  const parts = [loadCard(root, role), loadCard(root, '_shared')];
  if (role.startsWith('builder')) parts.push(loadCard(root, '_builder-common'));
  if (role.startsWith('reviewer')) parts.push(loadCard(root, '_reviewer-common'));
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Output schemas. These are what make agent results parseable data.
// ---------------------------------------------------------------------------
const TASK_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'local id like t1, t2; used only for depends_on' },
    title: { type: 'string', maxLength: 90 },
    description: { type: 'string', description: 'what to build and how it fits the codebase; exact paths, names, error text' },
    size: { type: 'string', enum: ['small', 'medium', 'large'] },
    files: { type: 'array', items: { type: 'string' }, description: 'files this task will create or change (repo-relative). Directories allowed with trailing /' },
    acceptance: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'checkable by inspection or by running a command' },
    verify: { type: 'array', items: { type: 'string' }, description: 'shell commands that prove it works (optional)' },
    depends_on: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'title', 'description', 'size', 'files', 'acceptance', 'depends_on'],
  additionalProperties: false,
};

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['plan', 'escalate', 'questions', 'nothing'] },
    summary: { type: 'string', description: 'one or two sentences: what will be built' },
    assumptions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' }, description: 'only when mode=questions: things that truly block any reasonable plan' },
    escalate_reason: { type: 'string' },
    stack: { type: 'string', description: 'detected or chosen stack, one line' },
    tasks: { type: 'array', items: TASK_SCHEMA },
  },
  required: ['mode', 'summary', 'assumptions', 'tasks'],
  additionalProperties: false,
};

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    summary: { type: 'string', description: 'what changed, two to four sentences, for the changelog' },
    files_changed: { type: 'array', items: { type: 'string' } },
    gates_run: { type: 'string', description: 'which gate commands you ran and their results' },
    blocked_reason: { type: 'string', description: 'when blocked: the exact ambiguity or missing thing, as a question a human can answer in one sentence' },
    notes: { type: 'string', description: 'anything the reviewer or next builder needs to know' },
  },
  required: ['status', 'summary', 'files_changed', 'notes'],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'escalate'] },
    criteria: {
      type: 'array',
      items: { type: 'object', properties: { text: { type: 'string' }, pass: { type: 'boolean' }, note: { type: 'string' } }, required: ['text', 'pass'], additionalProperties: false },
    },
    gates_run: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string' },
          detail: { type: 'string', description: 'concrete: file, line or symbol, input that breaks it, expected vs actual' },
          file: { type: 'string' },
        },
        required: ['severity', 'title', 'detail'], additionalProperties: false,
      },
    },
    scope_ok: { type: 'boolean', description: 'no files outside declared scope changed, tests not weakened' },
    summary: { type: 'string', description: 'one or two sentences for the human' },
    escalate_reason: { type: 'string' },
  },
  required: ['verdict', 'criteria', 'findings', 'scope_ok', 'summary'],
  additionalProperties: false,
};

const RELEASE_SCHEMA = {
  type: 'object',
  properties: {
    bump: { type: 'string', enum: ['major', 'minor', 'patch'] },
    headline: { type: 'string', maxLength: 100, description: 'one line a user would recognize' },
    added: { type: 'array', items: { type: 'string' } },
    changed: { type: 'array', items: { type: 'string' } },
    fixed: { type: 'array', items: { type: 'string' } },
    removed: { type: 'array', items: { type: 'string' } },
    internal: { type: 'array', items: { type: 'string' }, description: 'refactors, tooling, deps' },
    attention: { type: 'array', items: { type: 'string' }, description: 'what a human should look at or decide' },
  },
  required: ['bump', 'headline', 'added', 'changed', 'fixed', 'removed', 'internal', 'attention'],
  additionalProperties: false,
};

const SCHEMAS = { plan: PLAN_SCHEMA, build: BUILD_SCHEMA, review: REVIEW_SCHEMA, release: RELEASE_SCHEMA };

module.exports = { ROLES, TOOLS, SCHEMAS, loadCard, systemPrompt };
