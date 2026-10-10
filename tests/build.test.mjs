import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { outOfDate, renderAll, renderReadmeTiers } from '../scripts/build.mjs';
import { loadCatalog, loadTiers, resolveAll } from '../scripts/lib/catalog.mjs';
import { report } from '../scripts/stats.mjs';
import { plan, run, withOurHooks, withoutOurHooks } from '../scripts/install.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('generated files are committed up to date', () => {
  assert.deepEqual(outOfDate(renderAll()), []);
});

test('agents pin the full model id and the clamped effort', () => {
  const files = renderAll();
  const catalog = loadCatalog();
  const tiers = loadTiers();
  const routes = resolveAll(catalog, tiers);
  for (const t of tiers.order) {
    const agent = files[`agents/${tiers.tiers[t].agent}.md`];
    assert.match(agent, new RegExp(`^model: ${routes[t].model.id}$`, 'm'), t);
    assert.match(agent, new RegExp(`^effort: ${routes[t].effort}$`, 'm'), t);
  }
  assert.equal(routes.fast.model.id, catalog.current.haiku);
  assert.match(files['agents/router-frontier.md'], /Use only when the user asks for it/);
});

test('a new model in the catalog flows into every generated file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-build-'));
  fs.mkdirSync(path.join(tmp, 'models'));
  const catalog = loadCatalog();
  const next = {
    ...catalog,
    updated_at: '2027-02-01',
    current: { ...catalog.current, sonnet: 'claude-sonnet-6' },
    models: [...catalog.models, { id: 'claude-sonnet-6', name: 'Claude Sonnet 6', line: 'sonnet', efforts: ['low', 'medium', 'high'], price: { input: 2, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.1, output: 10 } }],
  };
  fs.writeFileSync(path.join(tmp, 'models', 'catalog.json'), JSON.stringify(next));
  fs.copyFileSync(path.join(root, 'models', 'tiers.json'), path.join(tmp, 'models', 'tiers.json'));
  fs.writeFileSync(path.join(tmp, 'README.md'), 'x\n<!-- tiers:start -->\nold\n<!-- tiers:end -->\ny\n');
  const files = renderAll(tmp);
  assert.match(files['agents/router-standard.md'], /^model: claude-sonnet-6$/m);
  assert.match(files['agents/router-standard.md'], /^effort: high$/m);
  assert.match(files['web/claude-ai.md'], /ESTÁNDAR \(Claude Sonnet 6\)/);
  assert.match(files['docs/MODELOS.md'], /Claude Sonnet 6 \*\*\(actual\)\*\*/);
  assert.match(files['README.md'], /\| Estándar \| Claude Sonnet 6 \| high \|/);
  assert.ok(!files['README.md'].includes('old'));
});

test('README markers missing leaves README untouched', () => {
  const tiers = loadTiers();
  const routes = resolveAll(loadCatalog(), tiers);
  assert.equal(renderReadmeTiers('no markers', tiers, routes), 'no markers');
});

test('build --check passes on the committed tree', () => {
  const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
});

test('stats report: routing mix and subagent cost', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const ts = '2026-10-09T12:00:00Z';
  const text = report({
    routing: [{ ts, tier: 'fast' }, { ts, tier: 'fast' }, { ts, tier: 'deep' }, { ts: '2026-01-01T00:00:00Z', tier: 'max' }],
    telemetry: [
      { ts, event: 'usage', subagent_type: 'router-fast', models: ['claude-haiku-5-5'], usage: { output_tokens: 1200 }, est_usd: 0.0012 },
      { ts, event: 'usage', subagent_type: 'router-standard', models: ['claude-sonnet-5-5'], usage: { output_tokens: 3000 }, est_usd: 0.05 },
      { ts, event: 'usage', subagent_type: 'x', models: ['mystery'], usage: {}, est_usd: null },
      { ts, event: 'call' },
    ],
    days: 7,
    now,
  });
  assert.match(text, /\*\*Mensajes enrutados:\*\* 3 \(fast 67% · deep 33%\)/);
  assert.match(text, /router-standard \| claude-sonnet-5-5 \| 1 \|/);
  assert.match(text, /\+1 sin precio/);
  assert.match(text, /\*\*Total subagentes:\*\* \$0\.0512/);
  assert.match(report({ routing: [], telemetry: [], days: 7, now }), /ninguno registrado todavía/);
});

test('install: hooks merge idempotently and uninstall restores foreign hooks', () => {
  const foreign = { hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier' }] }] }, model: 'opus' };
  const once = withOurHooks(foreign, '/x/model-router/scripts');
  const twice = withOurHooks(once, '/x/model-router/scripts');
  assert.deepEqual(twice, once);
  assert.equal(once.hooks.PostToolUse.length, 2);
  assert.equal(once.hooks.UserPromptSubmit.length, 1);
  assert.deepEqual(withoutOurHooks(once), foreign);
  assert.deepEqual(withoutOurHooks({}), {});
});

test('install: project install copies files and writes portable hook paths', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-proj-'));
  const quiet = () => {};
  const dry = run({ project, yes: false, log: quiet });
  assert.ok(!fs.existsSync(path.join(project, '.claude')), 'dry run writes nothing');
  assert.equal(dry.scriptsRef, '$CLAUDE_PROJECT_DIR/.claude/model-router/scripts');
  run({ project, yes: true, log: quiet });
  const base = path.join(project, '.claude');
  assert.ok(fs.existsSync(path.join(base, 'agents', 'router-fast.md')));
  assert.ok(fs.existsSync(path.join(base, 'skills', 'router', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(base, 'model-router', 'models', 'catalog.json')));
  const settings = JSON.parse(fs.readFileSync(path.join(base, 'settings.json'), 'utf8'));
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /\$CLAUDE_PROJECT_DIR\/\.claude\/model-router\/scripts\/route-prompt\.mjs/);
  // the copied hook really runs from its new home
  const res = spawnSync(process.execPath, [path.join(base, 'model-router', 'scripts', 'route-prompt.mjs'), '--test', 'git status'], { encoding: 'utf8' });
  assert.match(res.stdout, /tier=fast/);
  run({ project, uninstall: true, yes: true, log: quiet });
  assert.ok(!fs.existsSync(path.join(base, 'agents', 'router-fast.md')));
  assert.ok(!fs.existsSync(path.join(base, 'model-router', 'scripts')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'settings.json'), 'utf8')), {});
});

test('install: user install targets ~/.claude with an absolute path', () => {
  const p = plan({ project: null });
  assert.ok(p.scriptsRef.endsWith('.claude/model-router/scripts'));
  assert.ok(path.isAbsolute(p.base));
});
