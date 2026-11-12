import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveStoreFile } from './presets.js';

const require = createRequire(import.meta.url);
// Required lazily: the 3.2MB vendor bundle's parse must not sit on the cordis
// plugin-import path — it would widen other plugins' deferred route windows.
let bundle = null;

let initPromise = null;
let initError = null;

/**
 * The vendored ACP runtime is a process-wide ManagedRuntime. It is initialized
 * lazily on first use; initialization failures are memoized so a broken vendor
 * bundle surfaces one consistent error instead of repeatedly half-starting.
 */
export function runtimeBundle() {
  if (!bundle) bundle = require('./vendor/agent-runtime.cjs');
  return bundle;
}

export function runtimeHomeDir() {
  const base = path.dirname(resolveStoreFile());
  const legacy = path.join(base, 't3');
  const dir = fs.existsSync(legacy) ? legacy : path.join(base, 'acp-runtime');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function initAgentRuntime() {
  if (initError) throw initError;
  if (!initPromise) {
    const base = runtimeHomeDir();
    initPromise = runtimeBundle()
      .initAgentRuntime({
        cacheDir: path.join(base, 'provider-status-cache'),
        toolsDir: path.join(base, 'tools'),
        paths: {
          cwd: process.cwd(),
          baseDir: base,
          stateDir: base,
          attachmentsDir: path.join(base, 'attachments'),
        },
      })
      .catch((err) => {
        initError = err instanceof Error ? err : new Error(String(err));
        initPromise = null;
        throw initError;
      });
  }
  return initPromise;
}

/**
 * Registry settings the ACP runtime catalog/auth code consumes, from our agent record.
 * `authMethodId` is only a verified ACP method id — our `authMethod` field is a
 * UI label, so an empty id lets ACP runtime pick the first agent-managed method.
 */
export function registrySettingsFor(agent, commandPath) {
  const source = agent?.registrySource === 'registry' ? 'registry' : 'local';
  return {
    source,
    enabled: agent?.enabled !== false,
    agentId: String(agent?.registryAgentId || (source === 'registry' ? agent?.id : '') || ''),
    // commandPath is an override for registry agents, required for local.
    commandPath: String(commandPath || ''),
    commandArgs: Array.isArray(agent?.args) ? agent.args.map(String) : [],
    authMethodId: String(agent?.acpAuthMethodId || ''),
    distribution: 'auto',
    customModels: (Array.isArray(agent?.models) ? agent.models : [])
      .map((m) => String(m?.id || ''))
      .filter(Boolean),
  };
}

/** ACP agent environment as a process env record. */
export function agentEnvironment(agent) {
  const env = {};
  for (const [key, value] of Object.entries(agent?.env || {})) {
    if (value === undefined || value === null) continue;
    env[String(key)] = String(value);
  }
  return env;
}
