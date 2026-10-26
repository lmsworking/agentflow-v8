'use strict';

const child_process = require('node:child_process');
const path = require('node:path');
const { no_ag_bypass } = require('./completion-context');

const call_referee = ({ host, event, cwd, session_id, prompt, turn_id, transcript_path, stop_hook_active }) => {
  const input = { cwd, session_id, hook_event_name: event, prompt, turn_id, transcript_path, stop_hook_active };
  const result = child_process.spawnSync(process.execPath, [path.join(__dirname, 'stop-hook.js'), '--host', host], {
    cwd, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true,
  });
  if (result.error) throw result.error;
  let output = {};
  try { output = JSON.parse(result.stdout || '{}'); } catch {}
  return { blocked: result.status === 2, message: result.stderr || '', additional_context: output.hookSpecificOutput?.additionalContext || '' };
};

const capture_context = result => result.additional_context || '';

const pi_context_message = (content, host, session_id) => ({
  message: {
    customType: 'agentflow-context',
    content: [`Active Agentflow host: ${host}. Active session ID: ${session_id}. Pass both values unchanged to Agentflow commands; never infer or reuse another session identity.`, content].filter(Boolean).join('\n\n'),
    display: false,
  },
});

const pi_extension = (pi, options = {}) => {
  const host = options.host || 'pi';
  let cwd = options.cwd || process.cwd();
  let correction_sent = false;
  let bypass_current_turn = false;
  let session_id;
  let latest_prompt;
  let pending_capture = '';
  pi.on('input', async (input, context) => {
    if (!['interactive', 'rpc'].includes(input.source) || typeof input.text !== 'string') return;
    cwd = context.cwd || cwd;
    session_id = context.sessionManager.getSessionId();
    latest_prompt = input.text;
    correction_sent = false;
    bypass_current_turn = no_ag_bypass(input.text);
    pending_capture = bypass_current_turn ? '' : capture_context(module.exports.call_referee({ host, event: 'UserPromptSubmit', cwd, session_id, prompt: input.text }));
  });
  pi.on('before_agent_start', async (_event, context) => {
    if (bypass_current_turn) return;
    cwd = context.cwd || cwd;
    session_id = context.sessionManager.getSessionId();
    const content = pending_capture;
    pending_capture = '';
    return pi_context_message(content, host, session_id);
  });
  pi.on('agent_before_settle', async (_event, context) => {
    if (bypass_current_turn || correction_sent) return;
    cwd = context.cwd || cwd;
    session_id = context.sessionManager.getSessionId();
    const result = module.exports.call_referee({ host, event: 'Stop', cwd, session_id, prompt: latest_prompt });
    if (result.blocked) {
      correction_sent = true;
      return { entries: [{ type: 'custom_message', customType: 'agentflow-completion', content: result.message, display: false }], continue: true };
    }
  });
};

const omp_extension = (omp, options = {}) => {
  const host = options.host || 'omp';
  let cwd = options.cwd || process.cwd();
  let correction_sent = false;
  let bypass_current_turn = false;
  let latest_prompt;
  let session_id;
  let pending_capture = '';
  omp.on('input', async (input, context) => {
    if (!['interactive', 'rpc'].includes(input.source) || typeof input.text !== 'string') return;
    cwd = context.cwd || cwd;
    session_id = context.sessionManager.getSessionId();
    latest_prompt = input.text;
    correction_sent = false;
    bypass_current_turn = no_ag_bypass(input.text);
    pending_capture = bypass_current_turn ? '' : capture_context(module.exports.call_referee({ host, event: 'UserPromptSubmit', cwd, session_id, prompt: input.text }));
  });
  omp.on('before_agent_start', async (_event, context) => {
    if (bypass_current_turn) return;
    cwd = context.cwd || cwd;
    session_id = context.sessionManager.getSessionId();
    const content = pending_capture;
    pending_capture = '';
    return pi_context_message(content, host, session_id);
  });
  omp.on('session_stop', async (input, context) => {
    if (bypass_current_turn || correction_sent || input.stop_hook_active) return;
    cwd = context.cwd || cwd;
    session_id = input.session_id || context.sessionManager.getSessionId();
    const result = module.exports.call_referee({ host, event: 'Stop', cwd, session_id, prompt: latest_prompt, turn_id: input.turn_id, transcript_path: input.session_file, stop_hook_active: input.stop_hook_active });
    if (result.blocked) {
      correction_sent = true;
      return { continue: true, additionalContext: result.message };
    }
  });
};

module.exports = { call_referee, pi_extension, omp_extension };
