import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createAcpAgentsManager } from '../lib/index.js';
import { AcpSessionConnection, AcpTurnExecution, modelsFromConfigOptions, probeAcpAgent } from '../lib/acp-session.js';
import { AgentAuthManager } from '../lib/agent-auth.js';
import { agentRuntimeIdentity, initAgentRuntime, runtimeBundle, configureRuntimeHost } from '../lib/agent-runtime.js';
import { normalizeModelList, saveAgentsConfig } from '../lib/presets.js';
import { createTaskStore } from '../lib/tasks.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'acp-reliability-'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const source = fs.readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
const suiteHome = temp();
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = suiteHome;
after(async () => {
  await runtimeBundle().disposeAgentRuntime();
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  fs.rmSync(suiteHome, { recursive: true });
});

test('native API picker preserves absent reasoning and ACP visibility overrides an old directory', () => {
  const helper = source.indexOf('    function acpModelReasoning(');
  const helperEnd = source.indexOf('\n    /**', helper);
  const start = source.indexOf('const { categories, filterTabs, allChoices } = useMemo(() => {');
  const end = source.indexOf('\n      const currentProviderId', start);
  const project = vm.compileFunction(`${source.slice(helper, helperEnd)}\n${source.slice(start, end)}\nreturn allChoices;`,
    ['state', 'acpCatalog', 'accountProviderName', 't', 'ACP_PREFIX', 'useMemo']);
  const choices = project({ groups: [{ id: 'api', models: [{ id: 'plain' }] }, { id: 'acp:new-agent', models: [{ id: 'old-hidden' }] }] },
    [{ id: 'new-agent', enabled: true, hiddenModels: ['old-hidden'], models: [{ id: 'new-visible' }, { id: 'old-hidden' }] }], 'Account', key => key, 'acp:', fn => fn());
  assert.deepEqual(choices.map(choice => choice.selection), [{ provider: 'api', model: 'plain' }, { provider: 'acp:new-agent', model: 'new-visible' }]);
});

test('provider terminal error, cancellation and token limit keep their distinct meanings', async () => {
  for (const reason of ['end_turn', 'error', 'cancelled', 'max_tokens']) {
    const turn = new AcpTurnExecution({ connection: { api: { makeDeferred: async () => ({}), prompt: async () => ({ stopReason: reason, error: { message: 'provider detail', code: 42 } }) } } });
    await turn.beginPrompt();
    const items = turn.queue.items;
    if (reason === 'error') { assert.equal(items[0].type, 'prompt-error'); assert.equal(items[0].error.message, 'provider detail'); assert.equal(items[0].error.code, 42); }
    else { assert.equal(items[0].type, 'prompt-done'); assert.equal(items[0].stopReason, reason); }
  }
});

test('parallel root conversations may reuse native tool IDs without sharing results or owners', async (t) => {
  const root = temp(), storeFile = path.join(root, 'agents.json');
  saveAgentsConfig([{ id: 'unknown-agent', enabled: true, command: process.execPath, models: [{ id: 'default' }] }], storeFile);
  const hosts = ['A', 'B'].map(id => ({ id, options: { provider: 'acp:unknown-agent' }, session: { header: { cwd: root }, snapshotEvents: () => [], append() {} } }));
  const manager = createAcpAgentsManager({ agents: { get: id => hosts.find(host => host.id === id) } }, { storeFile });
  t.mock.method(AcpSessionConnection.prototype, 'ensureReady', async function () { this.api = { getConfigOptions: async () => [], setSessionModel: async () => {} }; });
  t.mock.method(AcpTurnExecution.prototype, 'beginPrompt', function () {
    this.registerToolCall({ toolCallId: 'tool_1', kind: 'read', status: 'completed', outputText: `Private ${this.hostAgent.id}` });
    this.complete({ stopReason: 'end_turn' });
  });
  try {
    const outputs = await Promise.all(hosts.map(async host => {
      const chunks = [];
      for await (const chunk of manager.adapter.stream({ provider: 'acp:unknown-agent', model: 'default', sessionId: host.id, signal: new AbortController().signal, messages: [{ id: 'user', role: 'user', content: 'read' }] })) chunks.push(chunk);
      return chunks.find(chunk => chunk.block?.type === 'tool-call').block;
    }));
    assert.notEqual(outputs[0].id, outputs[1].id);
    assert.equal(await manager.executeTrackedToolCall({ callId: outputs[1].id, agent: hosts[0] }), null);
    for (let i = 0; i < 2; i++) {
      const result = await manager.executeTrackedToolCall({ callId: outputs[i].id, name: outputs[i].name, agent: hosts[i] });
      assert.equal(result.value.text, `Private ${hosts[i].id}`);
    }
    assert.equal(manager.pendingToolExecutions.size, 0);
  } finally { await manager.dispose(); fs.rmSync(root, { recursive: true }); }
});

test('termination and repeated close share one awaited resource finalizer', async () => {
  let plans = 0, tokens = 0;
  const release = configureRuntimeHost({});
  const root = temp();
  await initAgentRuntime();
  const conn = new AcpSessionConnection({ cwd: root, agentConfig: { id: 'termination-fixture', name: 'Unknown agent', command: process.execPath, args: [fileURLToPath(new URL('./agent-fixture.cjs', import.meta.url))] }, mcpInjection: { release: () => { tokens++; } } });
  await conn.ensureReady();
  const handle = conn.handle;
  conn._agyPlan = { cleanup: async () => { plans++; } };
  conn._handleTermination(new Error('process exited'));
  await Promise.all([conn.close(), conn.close()]);
  await tick();
  assert.deepEqual({ plans, tokens }, { plans: 1, tokens: 1 });
  assert.equal(conn.handle, null); assert.equal(conn._agyPlan, null);
  const { effect } = runtimeBundle();
  await effect.run(effect.Fiber.await(handle.eventsFiber));
  await release();
  fs.rmSync(root, { recursive: true });
});

test('failed load and resume preserve the original native mapping and useful errors', async () => {
  const conn = new AcpSessionConnection({ agentConfig: {}, resumeSessionId: 'saved-native' });
  conn.api = { resumeSession: async () => { throw new Error('temporary network failure'); } };
  await assert.rejects(conn._resumeFallback(new Error('permission denied')), /saved-native.*permission denied.*temporary network failure/);
  assert.equal(conn.resumeSessionId, 'saved-native');
});

test('dynamic select, boolean, empty values and nonstandard reasoning IDs survive discovery and application', async () => {
  const options = [
    { id: 'model', category: 'model', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'Model' }] },
    { id: 'budget', category: 'thought_level', type: 'select', name: 'Thinking', description: 'Agent budget', currentValue: 'max', options: [{ value: 'high', name: 'High' }, { value: 'max', name: 'Maximum' }] },
    { id: 'fast', type: 'boolean', name: 'Fast', currentValue: true },
    { id: 'format', type: 'select', name: 'Format', currentValue: '', options: [{ value: '', name: 'Automatic' }, { value: 'json', name: 'JSON' }] },
  ];
  const [model] = modelsFromConfigOptions(options);
  assert.equal(model.defaultEffort, 'max');
  assert.equal(model.options.find(option => option.id === 'budget').role, 'reasoning');
  assert.equal(model.options.find(option => option.id === 'budget').description, 'Agent budget');
  assert.deepEqual(model.options.find(option => option.id === 'fast'), { id: 'fast', label: 'Fast', type: 'boolean', currentValue: true, name: 'Fast', category: undefined });
  assert.equal(normalizeModelList([model])[0].defaultEffort, 'max');
  const conn = new AcpSessionConnection({ agentConfig: {} });
  const applied = [];
  conn.api = { getConfigOptions: async () => options, setConfigOption: async (...args) => applied.push(args) };
  await conn.syncOption('fast', false);
  await conn.syncOption('format', '_t3/empty');
  assert.deepEqual(applied, [['fast', false], ['format', '']]);
  await assert.rejects(conn.syncOption('fast', 'false'), /not available/);
});

test('generic schema elicitation uses the existing question surface and returns typed answers', async () => {
  const root = temp();
  const conn = new AcpSessionConnection({ cwd: root, agentConfig: { permissionPolicy: 'ask' }, requestUserInput: async (_, question) => ({ answers: [{ id: question.id, selected: question.id === 'confirm' ? ['false'] : [], ...(question.id === 'count' ? { custom: '12' } : {}) }] }) });
  let handlers;
  conn.api = { assignHandlers: async value => { handlers = value; } };
  conn.activeTurn = new AcpTurnExecution({ connection: conn });
  try {
    await conn._wireHandlers();
    const response = await handlers.handleElicitation({ mode: 'form', message: 'Configure task', requestedSchema: { type: 'object', required: ['confirm', 'count'], properties: { confirm: { type: 'boolean' }, count: { type: 'integer' } } } });
    assert.deepEqual(response, { action: 'accept', content: { confirm: false, count: 12 } });
    await assert.rejects(handlers.handleElicitation({ mode: 'form', requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } }), /cannot present/);
  } finally { await conn.close(); fs.rmSync(root, { recursive: true }); }
});

test('invalidated pending authentication cannot republish or delete a newer creation', async (t) => {
  const manager = new AgentAuthManager({});
  const old = deferred(), fresh = deferred(), disposed = [];
  t.mock.method(manager, '_createEntry', async agent => {
    await (agent.profileDir === 'old' ? old : fresh).promise;
    return { fingerprint: agentRuntimeIdentity(agent, ''), profile: agent.profileDir, api: { refreshMethods: async () => {}, invalidate: async () => {}, dispose: async () => { disposed.push(agent.profileDir); } } };
  });
  const before = manager._entry({ id: 'same', profileDir: 'old' });
  const rejected = assert.rejects(before, /configuration changed/);
  await tick(); await manager.invalidate('same');
  const after = manager._entry({ id: 'same', profileDir: 'new' });
  old.resolve(); await rejected;
  assert.ok(manager.inflightEntries.has('same'), 'old finally cannot remove the new reservation');
  fresh.resolve(); assert.equal((await after).profile, 'new');
  assert.deepEqual(disposed, ['old']);
  await manager.dispose();
  assert.deepEqual(disposed, ['old', 'new']);
});

test('provider logout rejection is visible and does not publish a false signed-out marker', async (t) => {
  const manager = new AgentAuthManager({}); let writes = 0;
  t.mock.method(manager, '_entry', async () => ({ api: { logout: async () => { throw new Error('logout unsupported'); } }, authState: { set: async () => { writes++; } } }));
  await assert.rejects(manager.logoutAgent({ id: 'new-agent' }), /logout unsupported/);
  assert.equal(writes, 0); await manager.dispose();
});

test('pre-admission receipts compare request identity before any task exists', async () => {
  const root = temp(), held = deferred(); let starts = 0;
  const tasks = createTaskStore({}, path.join(root, 'agents.json'));
  try {
    const first = tasks.once({ id: 'parent' }, 'stable', { prompt: 'one' }, async () => { starts++; await held.promise; return { taskId: 'first' }; });
    const same = tasks.once({ id: 'parent' }, 'stable', { prompt: 'one' }, () => assert.fail('duplicate preparation'));
    await assert.rejects(tasks.once({ id: 'parent' }, 'stable', { prompt: 'two' }, () => assert.fail('different preparation')), /different task arguments/);
    held.resolve(); assert.deepEqual(await first, await same); assert.equal(starts, 1);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('client patch saves cannot reenable an agent disabled by another settings client', async () => {
  const root = temp(), storeFile = path.join(root, 'agents.json');
  saveAgentsConfig([{ id: 'custom', name: 'Custom', command: 'not-an-installed-agent', enabled: true, models: [{ id: 'm' }] }], storeFile);
  const manager = createAcpAgentsManager({}, { storeFile });
  try {
    const selectedAgent = (await manager.buildCatalog()).agents.find(agent => agent.id === 'custom');
    await manager.handleRpc('agent/save', { agent: { id: 'custom', enabled: false } });
    const start = source.indexOf('      const saveAgentPatch = async');
    const end = source.indexOf('\n      const toggleModelFavorite', start);
    const save = vm.compileFunction(`${source.slice(start, end)}\nreturn saveAgentPatch(patch);`, ['selectedAgent', 'patch', 'rpc', 'setBusyAction', 'setBanner', 'setCatalog', 'setSavedFlash', 't']);
    const noop = () => {};
    assert.equal(await save(selectedAgent, { favoriteModels: ['m'] }, (method, input) => manager.handleRpc(method, input), noop, noop, noop, noop, key => key), true);
    const current = (await manager.buildCatalog()).agents.find(agent => agent.id === 'custom');
    assert.equal(current.enabled, false); assert.deepEqual(current.favoriteModels, ['m']);
  } finally { await manager.dispose(); fs.rmSync(root, { recursive: true }); }
});

test('native v2 background work wakes once, retains multiple cycles, and does not dispatch another prompt', async () => {
  const conn = new AcpSessionConnection({ agentConfig: {}, cwd: os.tmpdir() });
  conn.protocolVersion = 2; conn.acpSessionId = 'root'; let wakes = 0;
  conn.onBackgroundWork = () => { wakes++; };
  const state = update => conn._onRuntimeEvent({ _tag: 'UnknownUpdate', updateType: 'state_update', rawPayload: { sessionId: 'root', update: { sessionUpdate: 'state_update', ...update } } });
  state({ state: 'running' });
  conn._onRuntimeEvent({ _tag: 'ContentDelta', text: 'first native output', rawPayload: { sessionId: 'root' } });
  state({ state: 'idle', stopReason: 'end_turn' });
  const first = conn.activeTurn;
  state({ state: 'running' });
  conn._onRuntimeEvent({ _tag: 'ContentDelta', text: 'second native output', rawPayload: { sessionId: 'root' } });
  state({ state: 'idle', stopReason: 'end_turn' });
  assert.equal(first.promptPromise, null); assert.equal(conn.activeTurn.promptPromise, null);
  assert.equal(conn.pendingBackgroundTurns[0], first);
  assert.ok(first.queue.items.some(item => item.text === 'first native output'));
  assert.ok(conn.activeTurn.queue.items.some(item => item.text === 'second native output'));
  assert.equal(wakes, 2, 'connection offers each cycle; host bridge deduplicates pending wake delivery');
  await conn.close();
});

test('local API credential removal works when native logout is unsupported and reports partial completion', async t => {
  const root = temp(), storeFile = path.join(root, 'agents.json');
  saveAgentsConfig([{ id: 'local-key', command: 'missing-fixture-executable', env: { CUSTOM_API_KEY: 'fixture-test-key', KEEP_CONFIG: 'yes' }, acpAuthedAt: 123 }], storeFile);
  const manager = createAcpAgentsManager({}, { storeFile });
  t.mock.method(AgentAuthManager.prototype, 'logoutAgent', async () => { throw new Error('Native logout unavailable'); });
  try {
    await assert.rejects(manager.handleRpc('agent/logout', { id: 'local-key' }), /Native logout unavailable/);
    const result = await manager.handleRpc('agent/logout', { id: 'local-key', clearApiKeys: true });
    assert.equal(result.logoutWarning, 'Native logout unavailable');
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8')).agents.find(agent => agent.id === 'local-key');
    assert.deepEqual(stored.env, { KEEP_CONFIG: 'yes' });
    assert.equal(stored.acpAuthedAt, 123, 'failed provider logout must not erase the independent ACP marker');
  } finally { await manager.dispose(); fs.rmSync(root, { recursive: true }); }
});

test('explicit probe URL authentication publishes consent and resumes only after the matching acceptance', async () => {
  const root = temp();
  const release = configureRuntimeHost({});
  const agent = { id: 'unknown-url', name: 'Unknown URL agent', enabled: true, command: process.execPath, args: [fileURLToPath(new URL('./agent-fixture.cjs', import.meta.url))], env: { ACP_TEST_URL_AUTH: '1' } };
  const probe = probeAcpAgent({}, agent, root, { liveSession: true });
  try {
    await initAgentRuntime();
    const actions = runtimeBundle().registryAuthAction;
    let action;
    const end = Date.now() + 5000;
    while (!action && Date.now() < end) { action = await actions.get('dsh-unknown-url'); if (!action) await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(action?.elicitationId, 'fixture-consent');
    assert.equal(await actions.accept('dsh-unknown-url', 'wrong-consent'), false);
    assert.equal(await actions.accept('dsh-unknown-url', 'fixture-consent'), true);
    assert.equal((await probe).ok, true);
    assert.equal(await actions.get('dsh-unknown-url'), null);
  } finally { await probe; await release(); fs.rmSync(root, { recursive: true }); }
});

test('Antigravity plans preserve a parallel session directory and release only their own run', async () => {
  const root = temp(), previous = process.env.DSH_HOME;
  const release = configureRuntimeHost({});
  process.env.DSH_HOME = root;
  try {
    await initAgentRuntime();
    const input = { stateDir: root, instanceId: 'dsh:test-plans', cwd: root, userHome: root, baseEnv: { ...process.env }, auth: { authMethod: 'oauth-personal' }, executablePath: path.join(root, 'agy_acp_server.exe') };
    const first = await runtimeBundle().antigravitySessionPlan(input);
    fs.writeFileSync(path.join(first.runtimeTempDirectory, 'still-owned'), 'first');
    const second = await runtimeBundle().antigravitySessionPlan(input);
    assert.ok(fs.existsSync(path.join(first.runtimeTempDirectory, 'still-owned')));
    assert.notEqual(first.runtimeTempDirectory, second.runtimeTempDirectory);
    await second.cleanup(); assert.ok(fs.existsSync(first.runtimeTempDirectory));
    await Promise.all([first.cleanup(), first.cleanup()]); assert.equal(fs.existsSync(first.runtimeTempDirectory), false);
  } finally { await release(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; fs.rmSync(root, { recursive: true }); }
});
