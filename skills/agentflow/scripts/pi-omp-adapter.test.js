'use strict';

const assert = require('node:assert/strict');
const child_process = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const installer = require('./install-hook');
const adapter = require('./pi-omp-adapter');

const temp_dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-pi-omp-'));

test('Pi and OMP referee identities accept no-ag owner input without opening project state', () => {
  const root = temp_dir();
  try {
    for (const host of ['pi', 'omp']) {
      const result = child_process.spawnSync(process.execPath, [path.join(__dirname, 'stop-hook.js'), '--host', host], {
        cwd: root, encoding: 'utf8',
        input: JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: `session-${host}`, prompt: 'no-ag: repair directly' }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('project integrations install idempotently and refuse foreign-file replacement or removal', () => {
  const root = temp_dir();
  try {
    for (const host of ['pi', 'omp']) {
      const first = installer.install({ cwd: root, hosts: [host], quiet: true });
      assert.equal(first.status, 'available');
      assert.equal(first.restart_required, true);
      assert.equal(installer.install({ cwd: root, hosts: [host], quiet: true }).changed, false);
      const file = first.config_path;
      assert.match(fs.readFileSync(file, 'utf8'), /agentflow-owned/);
      installer.install({ cwd: root, hosts: [host], off: true, quiet: true });
      assert.equal(fs.existsSync(file), false);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'foreign');
      assert.equal(installer.install({ cwd: root, hosts: [host], quiet: true }).status, 'conflict');
      assert.equal(installer.install({ cwd: root, hosts: [host], off: true, quiet: true }).status, 'conflict');
      assert.equal(fs.readFileSync(file, 'utf8'), 'foreign');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('project-wide install, inspection, and removal include both extensions', () => {
  const root = temp_dir();
  try {
    const initialized = child_process.spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const installed = installer.install({ cwd: root, quiet: true });
    assert.deepEqual(installed.hosts.map(result => result.host), ['claude', 'codex', 'pi', 'omp']);
    const pi = path.join(root, '.pi', 'extensions', 'agentflow.js');
    const omp = path.join(root, '.omp', 'hooks', 'pre', 'agentflow.js');
    assert.equal(fs.existsSync(pi), true);
    assert.equal(fs.existsSync(omp), true);
    const omp_source = fs.readFileSync(omp, 'utf8');
    assert.match(omp_source, /^\/\/ agentflow-owned OMP extension\nimport adapter from "file:/u);
    assert.match(omp_source, /export default omp => adapter\.omp_extension\(omp\);/u);
    assert.equal(installer.inspect({ cwd: root }).some(item => item.includes(pi)), true);
    const guard = path.join(root, '.git', 'hooks', 'pre-commit');
    assert.equal(fs.existsSync(guard), true);
    installer.install({ cwd: root, hosts: ['pi'], off: true, quiet: true });
    assert.equal(fs.existsSync(pi), false);
    assert.equal(fs.existsSync(guard), true);
    assert.equal(fs.existsSync(installer.config_path_for('codex', 'project', root)), true);
    installer.install({ cwd: root, off: true, quiet: true });
    assert.equal(fs.existsSync(pi), false);
    assert.equal(fs.existsSync(omp), false);
    assert.equal(fs.existsSync(guard), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('first Pi and OMP startup bootstraps without a session only when notebook ownership is off', () => {
  const root = temp_dir();
  try {
    for (const host of ['pi', 'omp']) {
      const env = { ...process.env };
      for (const key of ['AGENTFLOW_SESSION_ID', 'PI_SESSION_ID', 'OMP_SESSION_ID']) delete env[key];
      const args = [path.join(__dirname, 'agf.js'), 'start', '--repo', root, '--host', host, '--message-stdin', '--json'];
      const result = child_process.spawnSync(process.execPath, args, { cwd: root, env, input: 'godev', encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.active_host, host);
      assert.equal(output.session_id, undefined);
      assert.equal(output.hooks_restart_required, true);
      assert.equal(output.hooks.status, 'available');
      const extension = host === 'pi' ? path.join(root, '.pi', 'extensions', 'agentflow.js') : path.join(root, '.omp', 'hooks', 'pre', 'agentflow.js');
      assert.equal(fs.existsSync(extension), true);

      const config_file = path.join(root, 'ag.json');
      const config = JSON.parse(fs.readFileSync(config_file, 'utf8'));
      config.switches['notebook-ownership'] = 'on';
      fs.writeFileSync(config_file, JSON.stringify(config));
      const notebook = fs.readFileSync(path.join(root, '.agentflow', 'devlog.md'));
      const refused = child_process.spawnSync(process.execPath, args, { cwd: root, env, input: 'godev again', encoding: 'utf8' });
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /requires the current session ID when notebook ownership is on/u);
      assert.deepEqual(fs.readFileSync(path.join(root, '.agentflow', 'devlog.md')), notebook);
      config.switches['notebook-ownership'] = 'off';
      fs.writeFileSync(config_file, JSON.stringify(config));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pi captures exact owner input, returns capture context, and offers at most one correction', async () => {
  const root = temp_dir();
  const handlers = {};
  const calls = [];
  const original = adapter.call_referee;
  adapter.call_referee = facts => {
    calls.push(facts);
    return { blocked: facts.event === 'Stop', message: 'finding', additional_context: 'captured' };
  };
  try {
    adapter.pi_extension({ on: (event, handler) => { handlers[event] = handler; } }, { cwd: root });
    const context = { sessionManager: { getSessionId: () => 'session-pi' } };
    await handlers.input({ text: ' exact\ninput ', source: 'interactive' }, context);
    await handlers.input({ text: 'extension prompt', source: 'extension' }, context);
    assert.equal(calls.length, 1);
    assert.deepEqual({ host: calls[0].host, session_id: calls[0].session_id, prompt: calls[0].prompt }, { host: 'pi', session_id: 'session-pi', prompt: ' exact\ninput ' });
    const notice = await handlers.before_agent_start({}, context);
    assert.deepEqual(notice, { message: { customType: 'agentflow-context', content: 'Active Agentflow host: pi. Active session ID: session-pi. Pass both values unchanged to Agentflow commands; never infer or reuse another session identity.\n\ncaptured', display: false } });
    const correction = await handlers.agent_before_settle({}, context);
    assert.deepEqual(correction, { entries: [{ type: 'custom_message', customType: 'agentflow-completion', content: 'finding', display: false }], continue: true });
    assert.equal(await handlers.agent_before_settle({}, context), undefined);
  } finally {
    adapter.call_referee = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OMP extension ignores generated input and blocks settlement once with host context', async () => {
  const root = temp_dir();
  const handlers = {};
  const calls = [];
  const original = adapter.call_referee;
  adapter.call_referee = facts => {
    calls.push(facts);
    return { blocked: facts.event === 'Stop', message: 'finding', additional_context: 'captured' };
  };
  try {
    adapter.omp_extension({ on: (event, handler) => { handlers[event] = handler; } }, { cwd: root });
    const context = { cwd: root, sessionManager: { getSessionId: () => 'session-omp' } };
    await handlers.input({ text: 'owner', source: 'rpc' }, context);
    await handlers.input({ text: 'generated', source: 'extension' }, context);
    const notice = await handlers.before_agent_start({}, context);
    assert.deepEqual(notice, { message: { customType: 'agentflow-context', content: 'Active Agentflow host: omp. Active session ID: session-omp. Pass both values unchanged to Agentflow commands; never infer or reuse another session identity.\n\ncaptured', display: false } });
    const blocked = await handlers.session_stop({ session_id: 'session-omp', session_file: '/session' }, context);
    assert.equal(calls.length, 2);
    assert.deepEqual({ host: calls[0].host, session_id: calls[0].session_id, prompt: calls[0].prompt }, { host: 'omp', session_id: 'session-omp', prompt: 'owner' });
    assert.deepEqual(blocked, { continue: true, additionalContext: 'finding' });
    assert.equal(await handlers.session_stop({ session_id: 'session-omp' }, context), undefined);
  } finally {
    adapter.call_referee = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Pi and OMP no-ag turns bypass prompt capture, injected context, and settlement checks', async () => {
  for (const host of ['pi', 'omp']) {
    const handlers = {};
    const calls = [];
    const original = adapter.call_referee;
    adapter.call_referee = facts => { calls.push(facts); return { blocked: false, additional_context: '' }; };
    try {
      const api = { on: (event, handler) => { handlers[event] = handler; } };
      const context = { cwd: os.tmpdir(), sessionManager: { getSessionId: () => `session-${host}` } };
      if (host === 'pi') {
        adapter.pi_extension(api);
        await handlers.input({ text: 'no-ag: skip workflow for this task', source: 'interactive' }, context);
        assert.equal(await handlers.before_agent_start({}, context), undefined);
        assert.equal(await handlers.agent_before_settle({}, context), undefined);
      } else {
        adapter.omp_extension(api);
        assert.equal(await handlers.input({ text: 'no-ag: skip workflow for this task', source: 'interactive' }, context), undefined);
        assert.equal(await handlers.before_agent_start({}, context), undefined);
        assert.equal(await handlers.session_stop({ session_id: `session-${host}` }, context), undefined);
      }
      assert.deepEqual(calls, []);
    } finally { adapter.call_referee = original; }
  }
});
