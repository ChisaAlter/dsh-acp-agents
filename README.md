# Configured coding agents for DeepSeek Harness

Configure a coding agent once, then use it either as the current conversation's agent or as a managed subagent. This is an independently packaged Cordis plugin for DeepSeek Harness and WhaleIsle Desktop.

Source and issues: [ChisaAlter/dsh-acp-agents](https://github.com/ChisaAlter/dsh-acp-agents). This repository contains the plugin and its bundled runtime, not the desktop host.

## Switch agents in a conversation

1. Open **Settings → Agent**, add an agent instance, complete its authentication, and enable it.
2. Open the conversation's model selector and choose that agent, its model, and reasoning effort.
3. Continue in the same conversation. Switching to another agent does not change the conversation's identity. A newly selected agent receives the visible conversation text; returning to an existing agent relays missed turns while retaining its own ACP session.

Claude Code, Codex, and Antigravity can use managed ACP Registry distributions. Devin uses its local CLI. Other ACP servers can be configured with a command, arguments, and environment. Multiple instances of the same agent can have separate profiles and credentials.

## Delegate to a configured agent

Enabled agents are exposed through two model-facing tools:

- `acp_agents()` lists configured agent instance ids and models, without credentials.
- `acp_delegate({ agent, prompt, description?, model?, reasoning_effort?, client_request_id?, mode?, timeout_ms?, isolation?, interaction_mode?, runtime_mode?, options? })` starts an independent child. Omit `model` to use its first visible configured model. Explicit effort and options must be advertised by discovery.

For example, after discovering the actual instance id:

```json
{
  "agent": "codex",
  "description": "Review session cancellation",
  "prompt": "Review lib/acp-session.js for cancellation races. Do not edit files. Return concrete findings with line references."
}
```

The child shares the parent's working directory, not its conversation. Include the necessary context in `prompt`. Child sessions, result delivery, follow-up messages, cancellation, and delegation depth are managed by the host's subagent service. Agent configuration and permission policy are reused; configuration does not grant additional authority.

Delegation first prepares the actual ACP connection and validates authentication, the requested model, and settings before publishing a child task. The prepared connection is reused for execution; validation sends no task prompt. A preparation rejection creates no child or failed task row. Errors retain protocol details such as an OAuth proxy failure rather than reporting only `Internal error`. Model/authentication/network failures never justify retrying with weaker runtime permissions. Antigravity's live account model list bounds discovery and selection; obsolete configured entries remain in management data but are excluded from usable choices after discovery. Child-scope disposal closes the ACP process and revokes its bridge token before the host reports released resources.

The same tools are injected into external agents through the session-authenticated MCP bridge. Delegation returns `{ taskId, subagentId, status: "running", next }` after acceptance. The host manages child execution and resource release; the plugin assembles errors and final output before delivering one durable completion message. Follow `next`: end the current turn, without polling or launching the task again. A busy parent receives the notice at its next model step; an idle parent resumes in a new turn. Children do not need to send a second final report.

Use `acp_result({ task_id: taskId })` after a completion notice or when the user requests status. The compatibility `agent_id` selects that child's latest task. Exact task lookup retains earlier results. `wait_ms` and delegation `mode: "wait"` support an event-driven wait of up to 20000 ms; a timeout retains automatic completion delivery. Use a stable `client_request_id` to retry identical delegation arguments without starting a second child. Reusing it for different arguments is rejected.

`send_message` resumes a child and records a fresh execution row after its earlier task settles. `interrupt_agent` pauses the current execution and preserves queued input. `acp_cancel({ task_id })` cancels the task, clears its queue, awaits descendant/resource release, and suppresses its completion wake. Completed output remains readable. No operation changes the parent's selected agent.

Use `isolation: "worktree"` for parallel edits in a separate retained checkout from committed HEAD. Uncommitted files are not copied; results name the checkout path. Worktree creation obeys host permissions and does not move the parent. `interaction_mode: "plan"` restricts the child to investigation and planning. `runtime_mode` can inherit or restrict the host policy, never expand it. Discovered non-permission settings can be supplied as `options: [{ id, value }]`.

ACP permission requests remain independent of mirrored tool execution. The current host sandbox and approval policy bound every callback. A delegated operation that needs human consent is presented through the live root conversation's question surface; explicit `never` still refuses it. Antigravity's multiple-choice questions use that same surface and return the selected native option id. Pending questions and approvals appear in task status and the compact row.

Delegations appear as compact horizontal entries with an agent icon, task, status, and elapsed time. The agent name and smaller model label form a stacked identity group, separate from the task. The Antigravity label omits the redundant Chinese translation without changing the configured agent name. Long text is truncated; hover for full details, or click to open the existing child conversation. Narrow entries prioritize the agent, model, and status. Failures show their diagnostic inline instead of expanding the entry. Informational delegation records carry the host's persistence compatibility marker so conversations remain readable after a restart.

## Install and requirements

- Node.js `^22.19.0 || >=24.0.0`.
- A DeepSeek Harness host with Cordis 4, LLM adapter registration, connection, and web-server services.
- Delegation additionally requires the host's `subagents` and `tools` services with managed local child support (`prepareContinuable` / `startActivation`). Without those services, conversation switching remains available.

Install `dsh-acp-agents` through the host's plugin loader. The package declares its server entry, browser client, and composition patch; it does not require changes to the host's source. Produce a distributable archive with `npm pack` and install it through the host's supported local-package flow.

## Configuration and existing data

The plugin stores agents in `$DSH_HOME/acp-agents.json`, external session mappings in `acp-agent-sessions.json`, durable task receipts in `acp-tasks.json`, and account profiles in `acp-profiles/`. Task receipts contain prompts/results and should receive the same protection as conversation logs. If `DSH_HOME` is unset, it uses `~/.dsh`.

Existing agent ids, provider ids (`acp:<instance-id>`), profiles, and session mappings remain usable. Existing runtime cache directories are reused to retain managed installations and authentication. Environment credentials remain in the local configuration file; catalog responses mask secret-shaped values and preserve them when unchanged settings are saved.

## Build the bundled runtime

Clone the standalone repository:

```sh
git clone https://github.com/ChisaAlter/dsh-acp-agents.git
cd dsh-acp-agents
```

The shipped package includes its runtime bundles. Rebuilding them uses the source snapshot inside this project, not another checkout or a T3 Code installation:

```sh
npm ci --prefix tools/runtime-build
npm run build:runtime
```

`tools/runtime-build/upstream/SOURCE.json` records the snapshot revision. Adapted third-party implementation is isolated there; the plugin owns its agent management, conversation routing, host delegation, and UI. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for provenance and license terms.

## Verify changes

Run `npm test` for handoff, discovery, and delegation contracts. Set `DSH_HARNESS_ROOT` to a built DeepSeek Harness checkout, then run `npm run test:host` for the real Cordis, AgentLoop, child lifecycle, ACP subprocess, and HTTP/MCP bridge integration. The integration test uses scripted ACP agents rather than a paid model or a user's account, and stores its artifacts in a new temporary directory.

## Current interaction limits

Conversation handoff relays visible text and retained images, not private reasoning or runtime state. Images use stored bytes after ACP image capability negotiation; unsupported agents return an explicit error. Stored files use resource links (the host may already project files into readable saved-path text).

After restart, opening the parent reconciles task receipts with child history and the durable parent inbox. Undelivered results are offered once. Interrupted work is reported with a recovery diagnostic; no model task is silently replayed. An explicit follow-up resumes the retained child. Existing pre-receipt task rows retain their log-based display recovery.
