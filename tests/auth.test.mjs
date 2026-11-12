import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentAuthManager } from '../lib/agent-auth.js';
import { probeAcpAgent } from '../lib/acp-session.js';
import { initAgentRuntime, runtimeBundle } from '../lib/agent-runtime.js';

test('registry probe returns discovered models and completed authentication invalidates account status immediately', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-auth-status-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const agent = { id: 'codebuddy-fixture', name: 'Registry fixture', enabled: true,
    registrySource: 'local', command: process.execPath,
    args: [fileURLToPath(new URL('./agent-fixture.cjs', import.meta.url))],
    env: { ACP_TEST_MODEL_CATALOG: '1', ACP_TEST_AUTH: '1', ACP_TEST_LOG: path.join(root, 'rpc.jsonl') } };
  const changes = [];
  const manager = new AgentAuthManager({ onAuthChanged: (id, authenticated) => changes.push({ id, authenticated }) });
  try {
    await initAgentRuntime();
    const probe = await probeAcpAgent({}, agent, root);
    assert.equal(probe.ok, true, probe.error);
    assert.deepEqual(probe.models.map(model => model.id), ['default', 'live-model']);
    assert.deepEqual(probe.authMethods.map(method => method.id), ['fixture-login']);
    const before = await manager.getAgentAccountStatus(agent);
    assert.equal(before.authenticated, false);
    assert.equal((await manager.getAgentAccountStatus(agent)).checkedAt, before.checkedAt, 'old unauthenticated status is cached');
    await manager.startLogin(agent, { methodId: 'fixture-login' });
    for (const deadline = Date.now() + 5000; manager.getFlowState(agent.id)?.phase !== 'succeeded';) {
      if (Date.now() > deadline) assert.fail('Scripted real ACP login did not complete');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // This is the client's normal non-forced catalog poll, not a manual refresh.
    const after = await manager.getAgentAccountStatus(agent);
    assert.equal(after.authenticated, true);
    assert.ok(after.checkedAt > before.checkedAt);
    assert.deepEqual(changes, [{ id: agent.id, authenticated: true }]);
    const calls = fs.readFileSync(agent.env.ACP_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(call => call.method === 'authenticate'));
    assert.ok(calls.some(call => call.method === 'session/new'));

    const entry = manager.entries.get(agent.id);
    await manager.authenticationChanged(agent.id, entry.authState, false);
    assert.equal((await manager.getAgentAccountStatus(agent)).authenticated, false, 'sign-out also expires the cached signed-in status');

    // Reproduce an account request already enriching version info when login
    // completes; it must not restore false after onChanged invalidates cache.
    let began, release;
    const started = new Promise(resolve => { began = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    t.mock.method(runtimeBundle().catalog, 'inspect', async () => { began(); await held; return { version: '1' }; });
    manager.clearAccountStatus(agent.id);
    const pending = manager.getAgentAccountStatus(agent);
    await started;
    await manager.authenticationChanged(agent.id, entry.authState, true);
    release();
    assert.equal((await pending).authenticated, true);
    assert.equal((await manager.getAgentAccountStatus(agent)).authenticated, true);
  } finally {
    for (const entry of manager.entries.values()) await entry.api?.dispose();
    await runtimeBundle().disposeAgentRuntime();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(root, { recursive: true });
  }
});
