// Run the hook scripts as Claude Code does: a child process, JSON on stdin, a private HOME.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCatalog, loadTiers, priceFor } from '../scripts/lib/catalog.mjs';
import { decide, instructions } from '../scripts/lib/route.mjs';
import { resolveAll } from '../scripts/lib/catalog.mjs';
import { sessionContext } from '../scripts/session-start.mjs';
import { sumTranscript, telemetryRow } from '../scripts/log-agent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = loadCatalog();
const tiers = loadTiers();

function runHook(script, input, env = {}) {
  const home = env.HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-home-'));
  const res = spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...env },
    encoding: 'utf8',
  });
  return { ...res, home, json: res.stdout ? JSON.parse(res.stdout) : null };
}

test('route-prompt: routes a prompt and logs it without the prompt text', () => {
  const r = runHook('route-prompt.mjs', { prompt: 'renombra la variable total', session_id: 's1' });
  assert.equal(r.status, 0);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(r.json.systemMessage, /^🧭 fast → Claude Haiku/);
  assert.match(r.json.hookSpecificOutput.additionalContext, /router-fast/);
  const log = fs.readFileSync(path.join(r.home, '.claude', 'model-router', 'routing.jsonl'), 'utf8');
  const row = JSON.parse(log.trim());
  assert.equal(row.tier, 'fast');
  assert.equal(row.session_id, 's1');
  assert.ok(!log.includes('renombra'), 'prompt text is not logged');
});

test('route-prompt: plugin installs use namespaced agent names', () => {
  const r = runHook('route-prompt.mjs', { prompt: 'renombra la variable total' }, { CLAUDE_PLUGIN_ROOT: root });
  assert.match(r.json.hookSpecificOutput.additionalContext, /model-tier-router:router-fast/);
});

test('route-prompt: slash commands, system notices, !off and junk produce no output', () => {
  for (const input of [{ prompt: '/help' }, { prompt: '<task-notification>done</task-notification>' }, { prompt: '!off hola' }, { prompt: '' }, {}, 'not json', '[1,2]']) {
    const r = runHook('route-prompt.mjs', input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', JSON.stringify(input));
  }
});

test('route-prompt: disabled by config or environment', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'model-router'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'model-router', 'config.json'), JSON.stringify({ enabled: false }));
  assert.equal(runHook('route-prompt.mjs', { prompt: 'hola' }, { HOME: home }).stdout, '');
  assert.equal(runHook('route-prompt.mjs', { prompt: 'hola' }, { MODEL_ROUTER: 'off' }).stdout, '');
});

test('route-prompt: --test prints the decision', () => {
  const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'route-prompt.mjs'), '--test', 'find the root cause of the deadlock'], { encoding: 'utf8' });
  assert.match(res.stdout, /tier=max/);
});

test('instructions differ by main model', () => {
  const routes = resolveAll(catalog, tiers);
  assert.match(instructions('deep', routes, 'opus'), /Handle it in this session/);
  assert.match(instructions('deep', routes, 'sonnet'), /router-deep/);
  assert.match(instructions('max', routes, 'opus'), /Think it through thoroughly/);
  assert.match(instructions('max', routes, 'sonnet'), /router-max/);
  assert.match(instructions('standard', routes, 'opus'), /router-standard/);
  assert.match(instructions('standard', routes, 'sonnet'), /Handle it directly/);
  assert.match(instructions('frontier', routes, 'sonnet'), /router-frontier/);
  for (const t of tiers.order) assert.ok(instructions(t, routes, 'opus').length < 520, `${t} note stays short`);
});

test('decide returns null for non-prompts', () => {
  const ctx = { catalog, tiers, config: { main_model: 'opus' } };
  assert.equal(decide(undefined, ctx), null);
  assert.equal(decide('   ', ctx), null);
  assert.equal(decide('!off x', ctx).output, null);
});

test('session-start: one routing line, plus a nudge when an unknown model shows up', () => {
  const config = { main_model: 'opus' };
  const fresh = sessionContext({ catalog, tiers, config, telemetry: [{ models: [catalog.current.haiku] }], sessionModel: catalog.current.opus });
  assert.match(fresh, /fast=Claude Haiku/);
  assert.match(fresh, /frontier=Claude Fable [\d.]+ · high \(on request\)/);
  assert.ok(!fresh.includes('Note:'));
  const unknown = sessionContext({ catalog, tiers, config, telemetry: [{ models: ['claude-opus-9'] }] });
  assert.match(unknown, /claude-opus-9/);
  assert.match(unknown, /plugin marketplace update model-tier-router/);
  assert.match(sessionContext({ catalog, tiers, config, sessionModel: 'claude-sonnet-7' }), /claude-sonnet-7/);
  assert.ok(!sessionContext({ catalog, tiers, config, sessionModel: 'opus' }).includes('Note:'), 'aliases are not reported');
});

test('session-start tolerates junk telemetry rows', () => {
  const text = sessionContext({ catalog, tiers, config: { main_model: 'opus' }, telemetry: [null, 7, { models: 'x' }, { models: [null, 3] }] });
  assert.ok(!text.includes('Note:'));
});

test('hooks still run when started through a symlinked path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-link-'));
  const link = path.join(dir, 'scripts');
  fs.symlinkSync(path.join(root, 'scripts'), link);
  const res = spawnSync(process.execPath, [path.join(link, 'session-start.mjs')], { input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
  assert.match(res.stdout, /SessionStart/);
});

test('session-start hook emits SessionStart JSON', () => {
  const r = runHook('session-start.mjs', { hook_event_name: 'SessionStart' });
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
});

const transcript = [
  { type: 'user', message: { content: 'hi' } },
  { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 500 } } },
  { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 500 } } },
  { type: 'assistant', message: { id: 'm2', model: 'claude-sonnet-5-5', usage: { input_tokens: 2000, cache_read_input_tokens: 10000, output_tokens: 300 } } },
]
  .map((e) => JSON.stringify(e))
  .concat(['{torn'])
  .join('\n');

test('sumTranscript dedupes message ids and prices usage', () => {
  const s = sumTranscript(transcript, catalog);
  assert.equal(s.api_calls, 2);
  assert.deepEqual(s.models, ['claude-sonnet-5-5']);
  assert.equal(s.usage.output_tokens, 800);
  const p = priceFor(catalog, 'claude-sonnet-5-5');
  assert.equal(s.est_usd, Math.round(((3000 * p.input + 10000 * p.cache_read + 800 * p.output) / 1e6) * 10000) / 10000);
  assert.equal(sumTranscript(JSON.stringify({ type: 'assistant', message: { model: 'mystery', usage: { output_tokens: 1 } } }), catalog).est_usd, null);
});

test('telemetryRow: Agent call and SubagentStop usage', () => {
  const call = telemetryRow(
    { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'router-fast', description: 'x' }, tool_response: JSON.stringify({ agentId: 'a1', resolvedModel: 'claude-haiku-5-5' }) },
    catalog,
  );
  assert.equal(call.event, 'call');
  assert.equal(call.resolved_model, 'claude-haiku-5-5');
  const usage = telemetryRow({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'router-standard', agent_transcript_path: '/t' }, catalog, () => transcript);
  assert.equal(usage.event, 'usage');
  assert.equal(usage.api_calls, 2);
  const unreadable = telemetryRow({ hook_event_name: 'SubagentStop', agent_transcript_path: '/missing' }, catalog, () => {
    throw new Error('ENOENT');
  });
  assert.equal(unreadable.api_calls, undefined);
  assert.equal(telemetryRow({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, catalog), null);
});

test('log-agent hook appends telemetry from a real transcript file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-home-'));
  const file = path.join(home, 't.jsonl');
  fs.writeFileSync(file, transcript);
  runHook('log-agent.mjs', { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'router-standard', agent_transcript_path: file }, { HOME: home });
  const rows = fs.readFileSync(path.join(home, '.claude', 'model-router', 'telemetry.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(rows[0]).usage.output_tokens, 800);
});
