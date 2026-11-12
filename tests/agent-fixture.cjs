// Deterministic ACP process: only the external model boundary is scripted.
const readline = require('node:readline');
const fs = require('node:fs');
const crypto = require('node:crypto');
let pending;
let permissionPrompt;
const connections = new Map();
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (id === 'fixture-permission' && message.result && permissionPrompt) {
    const { requestId, sessionId } = permissionPrompt;
    permissionPrompt = undefined;
    const outcome = message.result.outcome;
    const allowed = outcome?.outcome === 'selected' && outcome.optionId === 'allow';
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'fixture-mcp-call', status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: allowed ? 'PERMISSION_ALLOWED' : 'PERMISSION_DENIED' } }] } } });
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'PERMISSION_ALLOWED' : 'PERMISSION_DENIED' } } } });
    send({ id: requestId, result: { stopReason: 'end_turn' } });
    return;
  }
  if (process.env.ACP_TEST_LOG) fs.appendFileSync(process.env.ACP_TEST_LOG, JSON.stringify({ method, params, pid: process.pid }) + '\n');
  if (method === 'initialize') send({ id, result: { protocolVersion: 1, authMethods: process.env.ACP_TEST_AUTH ? [{ id: 'fixture-login', name: 'Fixture browser sign-in' }] : [], agentCapabilities: { loadSession: true, promptCapabilities: { image: process.env.ACP_TEST_NO_IMAGES !== '1' } }, agentInfo: { name: 'fixture', version: '1' } } });
  else if (method === 'authenticate') setTimeout(() => send({ id, result: {} }), 200);
  else if (method === 'session/new' || method === 'session/load') {
    if (process.env.ACP_TEST_STARTUP_CONTROL && fs.existsSync(process.env.ACP_TEST_STARTUP_CONTROL)) {
      send({ id, error: { code: -32603, message: 'Internal error', data: { details: 'OAuth token refresh failed: ProxyError connecting to oauth2.googleapis.com/token' } } });
      return;
    }
    const sessionId = params.sessionId || crypto.randomUUID();
    const injected = params.mcpServers?.find(server => server.name === 'whaleisle');
    connections.set(sessionId, Object.fromEntries((injected?.env || []).map(entry => [entry.name, entry.value])));
    send({ id, result: { sessionId, ...(process.env.ACP_TEST_MODEL_CATALOG ? { configOptions: [{ type: 'select', id: 'model', category: 'model', name: 'Model', currentValue: 'default', options: ['default', 'live-model'].map(value => ({ value, name: value })) }] } : {}) } });
  }
  else if (method === 'session/set_config_option') {
    if (params.configId === 'model' && params.value === 'stale-model') send({ id, error: { code: -32602, message: 'Model stale-model is not available for this account. Available: default, live-model.' } });
    else send({ id, result: {} });
  }
  else if (method === 'session/prompt') {
    const prompt = params.prompt.filter((block) => !String(block.text || '').includes('Configured-agent tools:')).map((block) => block.text || '').join('\n');
    const finalLine = prompt.split('\n').at(-1);
    if (finalLine.startsWith('MCP_REQUEST:')) {
      const request = JSON.parse(finalLine.slice('MCP_REQUEST:'.length));
      const env = connections.get(params.sessionId);
      fetch(env.DSH_ACP_MCP_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', authorization: env.DSH_ACP_MCP_AUTHORIZATION },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'fixture-request', method: 'tools/call', params: request }) })
        .then(response => response.json()).then(response => {
          fs.appendFileSync(process.env.ACP_TEST_LOG, JSON.stringify({ method: 'fixture/mcp-result', result: response.result }) + '\n');
          send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'MCP_ACCEPTED' } } } });
          send({ id, result: { stopReason: 'end_turn' } });
        }).catch(error => send({ id, error: { code: -32603, message: error.message } }));
      return;
    }
    if (prompt === 'ASYNC_PARENT_CASE') {
      const env = connections.get(params.sessionId);
      // Model boundary only: the parent calls the injected HTTP/MCP endpoint,
      // then finishes its ACP turn before the child completes.
      fetch(env.DSH_ACP_MCP_ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: env.DSH_ACP_MCP_AUTHORIZATION },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'async-parent', method: 'tools/call', params: {
          name: 'acp_delegate', arguments: { agent: 'beta', prompt: 'ASYNC_CHILD_WORK', description: 'Async child' },
        } }),
      }).then(response => response.json()).then(response => {
        if (response.result.isError || response.result.structuredContent.status !== 'running') throw new Error('Expected asynchronous acceptance');
        send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ASYNC_PARENT_YIELDED' } } } });
        send({ id, result: { stopReason: 'end_turn' } });
      }).catch(error => send({ id, error: { code: -32603, message: error.message } }));
      return;
    }
    if (prompt.startsWith('ASYNC_CHILD_WORK')) {
      setTimeout(() => {
        send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ASYNC_CHILD_RESULT' } } } });
        send({ id, result: { stopReason: 'end_turn' } });
      }, 800);
      return;
    }
    if (prompt.includes('FAIL_MODEL_SELECTION')) { send({ id, error: { code: -32603, message: "Model 'default' is unavailable for this account. Select an available model." } }); return; }
    if (prompt.includes('FAIL_OAUTH_TRANSPORT')) { send({ id, error: { code: -32603, message: 'Internal error', data: { details: 'OAuth refresh failed: ProxyError connecting to oauth2.googleapis.com/token' } } }); return; }
    if (prompt.includes('WAIT_FOR_CANCEL')) { pending = { id, sessionId: params.sessionId }; return; }
    if (prompt.startsWith('DELAYED_RESULT\n') || prompt === 'DELAYED_RESULT') {
      setTimeout(() => {
        send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DELAYED_RESULT_READY' } } } });
        send({ id, result: { stopReason: 'end_turn' } });
      }, 18000);
      return;
    }
    if (prompt.includes('TOOL_NO_TERMINAL')) {
      send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'read-no-terminal', title: 'Read package.json', kind: 'read', status: 'in_progress', rawInput: { path: 'package.json' } } } });
      setTimeout(() => {
        if (prompt.includes('TOOL_NO_TERMINAL_ERROR')) send({ id, error: { code: -32603, message: 'Read backend disconnected' } });
        else {
          send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'READ_RESULT_READY' } } } });
          send({ id, result: { stopReason: 'end_turn' } });
        }
      }, 40);
      return;
    }
    if (prompt.includes('PERMISSION_PROBE') || prompt.includes('PERMISSION_AFTER_OPEN_READ')) {
      permissionPrompt = { requestId: id, sessionId: params.sessionId };
      const ask = () => send({ id: 'fixture-permission', method: 'session/request_permission', params: {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'fixture-mcp-call', title: 'Calling acp_agents from whaleisle', kind: 'other', rawInput: { server_name: 'whaleisle', tool_name: 'acp_agents' } },
        options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
      } });
      if (prompt.includes('PERMISSION_AFTER_OPEN_READ')) {
        send({ method: 'session/update', params: { sessionId: params.sessionId, update: {
          sessionUpdate: 'tool_call', toolCallId: 'read-before-permission', title: 'Read package.json', kind: 'read', status: 'in_progress', rawInput: { path: 'package.json' },
        } } });
        setTimeout(ask, 40);
      } else ask();
      return;
    }
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `AGENT_RESULT:${prompt}` } } } });
    send({ id, result: { stopReason: 'end_turn' } });
  } else if (method === 'session/cancel') {
    if (pending) { send({ id: pending.id, result: { stopReason: 'cancelled' } }); pending = undefined; }
    if (id !== undefined) send({ id, result: {} });
  } else if (id !== undefined) send({ id, result: {} });
});

