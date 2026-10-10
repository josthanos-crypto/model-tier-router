#!/usr/bin/env node
// Install without the plugin system: for a user (~/.claude) or one project (<dir>/.claude, which
// is what makes the router available in Claude Code cloud sessions of that repository).
//
//   node scripts/install.mjs                      show what would be installed for the user
//   node scripts/install.mjs --yes                install for the user
//   node scripts/install.mjs --project . --yes    install into this project's .claude/
//   node scripts/install.mjs --uninstall --yes    remove exactly what was installed
//
// Copies scripts/ and models/ to <.claude>/model-router/, the agents to <.claude>/agents/, the
// skills to <.claude>/skills/, and adds the hooks to <.claude>/settings.json (backup kept).
// Logs and config.json in ~/.claude/model-router are never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readJson } from './lib/catalog.mjs';
import { isMain } from './lib/io.mjs';

const MARK = 'model-router/scripts/';
const AGENTS = ['router-fast', 'router-standard', 'router-deep', 'router-max', 'router-frontier'];
const SKILLS = ['router', 'router-stats'];

export function hookConfig(scriptsRef) {
  const cmd = (script) => `node "${scriptsRef}/${script}"`;
  return {
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: cmd('session-start.mjs'), timeout: 10 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('route-prompt.mjs'), timeout: 10 }] }],
    PostToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: cmd('log-agent.mjs'), async: true, timeout: 15 }] }],
    SubagentStop: [{ hooks: [{ type: 'command', command: cmd('log-agent.mjs'), async: true, timeout: 30 }] }],
  };
}

const ours = (group) => (group.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(MARK));

export function withoutOurHooks(settings) {
  const next = { ...settings };
  if (!next.hooks) return next;
  const hooks = {};
  for (const [event, groups] of Object.entries(next.hooks)) {
    const kept = (groups || []).filter((g) => !ours(g));
    if (kept.length) hooks[event] = kept;
  }
  next.hooks = hooks;
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

export function withOurHooks(settings, scriptsRef) {
  const next = withoutOurHooks(settings);
  const hooks = { ...(next.hooks || {}) };
  for (const [event, groups] of Object.entries(hookConfig(scriptsRef))) hooks[event] = [...(hooks[event] || []), ...groups];
  return { ...next, hooks };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

export function plan({ project, uninstall }) {
  const base = project ? path.join(path.resolve(project), '.claude') : path.join(os.homedir(), '.claude');
  const scriptsRef = project ? '$CLAUDE_PROJECT_DIR/.claude/model-router/scripts' : path.join(base, 'model-router', 'scripts').replace(/\\/g, '/');
  return {
    base,
    scriptsRef,
    settingsFile: path.join(base, 'settings.json'),
    copies: uninstall
      ? []
      : [
          [path.join(ROOT, 'scripts'), path.join(base, 'model-router', 'scripts')],
          [path.join(ROOT, 'models'), path.join(base, 'model-router', 'models')],
          ...AGENTS.map((a) => [path.join(ROOT, 'agents', `${a}.md`), path.join(base, 'agents', `${a}.md`)]),
          ...SKILLS.map((s) => [path.join(ROOT, 'skills', s), path.join(base, 'skills', s)]),
        ],
    removals: [
      path.join(base, 'model-router', 'scripts'),
      path.join(base, 'model-router', 'models'),
      ...AGENTS.map((a) => path.join(base, 'agents', `${a}.md`)),
      ...SKILLS.map((s) => path.join(base, 'skills', s)),
    ],
  };
}

export function run({ project, uninstall, yes, log = console.log }) {
  const p = plan({ project, uninstall });
  const settings = readJson(p.settingsFile, {}) || {};
  const nextSettings = uninstall ? withoutOurHooks(settings) : withOurHooks(settings, p.scriptsRef);
  log(`${uninstall ? 'Uninstall from' : 'Install into'} ${p.base}`);
  for (const [, dest] of p.copies) log(`  copy  ${dest}`);
  if (uninstall) for (const r of p.removals) if (fs.existsSync(r)) log(`  remove ${r}`);
  log(`  hooks ${p.settingsFile} (${uninstall ? 'remove' : 'add'} 4 events${fs.existsSync(p.settingsFile) ? ', backup kept' : ''})`);
  if (!yes) {
    log('\nNothing written. Add --yes to apply.');
    return p;
  }
  if (uninstall) for (const r of p.removals) fs.rmSync(r, { recursive: true, force: true });
  else {
    for (const r of p.removals) fs.rmSync(r, { recursive: true, force: true });
    for (const [src, dest] of p.copies) {
      if (fs.statSync(src).isDirectory()) copyDir(src, dest);
      else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }
  }
  fs.mkdirSync(path.dirname(p.settingsFile), { recursive: true });
  if (fs.existsSync(p.settingsFile)) fs.copyFileSync(p.settingsFile, `${p.settingsFile}.bak-model-router`);
  fs.writeFileSync(p.settingsFile, JSON.stringify(nextSettings, null, 2) + '\n');
  log(uninstall ? 'Removed.' : 'Installed. Start a new session (or /hooks to reload) for it to take effect.');
  return p;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--project');
  try {
    run({ project: i > -1 ? args[i + 1] || '.' : null, uninstall: args.includes('--uninstall'), yes: args.includes('--yes') });
  } catch (err) {
    console.error(`install failed: ${err.message}`);
    process.exit(1);
  }
}
