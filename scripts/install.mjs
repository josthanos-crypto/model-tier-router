#!/usr/bin/env node
// Install without the plugin system: for a user (~/.claude) or one project (<dir>/.claude, which
// is what makes the router available in Claude Code cloud sessions of that repository).
//
//   node scripts/install.mjs                      show what would be installed for the user
//   node scripts/install.mjs --yes                install for the user
//   node scripts/install.mjs --project . --yes    install into this project's .claude/
//   node scripts/install.mjs --uninstall --yes    remove exactly what was installed
//
// Every file written is recorded in <.claude>/model-router/install-manifest.json, and only those
// files are ever replaced or removed. An existing file that is not in the manifest stops the
// install instead of being overwritten. settings.json is backed up (timestamped) before each
// change and left alone if it is not valid JSON. Logs and config.json are never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './lib/catalog.mjs';
import { isMain } from './lib/io.mjs';

const MARK = 'model-router/scripts/';
const OWN_DIRS = ['model-router/scripts', 'model-router/models', 'skills/router', 'skills/router-stats'];

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

function walk(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out;
}

// [absolute source, destination relative to the .claude dir]
export function sourceFiles(root = ROOT) {
  const files = [];
  for (const f of walk(path.join(root, 'scripts'))) files.push([path.join(root, 'scripts', f), `model-router/scripts/${f}`]);
  for (const f of walk(path.join(root, 'models'))) files.push([path.join(root, 'models', f), `model-router/models/${f}`]);
  for (const f of walk(path.join(root, 'agents'))) files.push([path.join(root, 'agents', f), `agents/${f}`]);
  for (const skill of ['router', 'router-stats'])
    for (const f of walk(path.join(root, 'skills', skill))) files.push([path.join(root, 'skills', skill, f), `skills/${skill}/${f}`]);
  return files;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // fall through
  }
  throw new Error(`${file} is not valid JSON; fix it first, nothing was changed`);
}

export function plan({ project, uninstall }) {
  const base = project ? path.join(path.resolve(project), '.claude') : path.join(os.homedir(), '.claude');
  const manifestFile = path.join(base, 'model-router', 'install-manifest.json');
  let installed = [];
  try {
    installed = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).files || [];
  } catch {
    // no previous install
  }
  const owned = new Set(installed);
  const copies = uninstall ? [] : sourceFiles();
  const targets = new Set(copies.map(([, rel]) => rel));
  return {
    base,
    manifestFile,
    scriptsRef: project ? '$CLAUDE_PROJECT_DIR/.claude/model-router/scripts' : path.join(base, 'model-router', 'scripts').replace(/\\/g, '/'),
    settingsFile: path.join(base, 'settings.json'),
    copies,
    conflicts: copies.map(([, rel]) => rel).filter((rel) => !owned.has(rel) && fs.existsSync(path.join(base, rel))),
    removals: uninstall ? installed : installed.filter((rel) => !targets.has(rel)),
  };
}

// Remove our directories bottom-up, but only where they are empty: a directory that still holds
// something we did not install is left as it is.
function pruneEmpty(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) pruneEmpty(path.join(dir, entry.name));
  try {
    fs.rmdirSync(dir);
  } catch {
    // not empty
  }
}

function pruneOwnDirs(base) {
  for (const dir of OWN_DIRS) pruneEmpty(path.join(base, dir));
}

export function run({ project, uninstall, yes, log = console.log }) {
  const p = plan({ project, uninstall });
  const settings = readSettings(p.settingsFile);
  const nextSettings = uninstall ? withoutOurHooks(settings) : withOurHooks(settings, p.scriptsRef);
  log(`${uninstall ? 'Uninstall from' : 'Install into'} ${p.base}`);
  if (!uninstall) log(`  copy   ${p.copies.length} files (agents, skills, model-router/scripts, model-router/models)`);
  for (const rel of p.removals) log(`  remove ${rel}`);
  log(`  hooks  ${p.settingsFile} (${uninstall ? 'remove' : 'add'}${fs.existsSync(p.settingsFile) ? ', timestamped backup kept' : ''})`);
  if (p.conflicts.length) {
    log('\nThese files exist and were not installed by this tool; move them away first:');
    for (const rel of p.conflicts) log(`  ${rel}`);
    throw new Error(`${p.conflicts.length} existing file(s) would be overwritten`);
  }
  if (!yes) {
    log('\nNothing written. Add --yes to apply.');
    return p;
  }
  for (const rel of p.removals) fs.rmSync(path.join(p.base, rel), { force: true });
  for (const [src, rel] of p.copies) {
    const dest = path.join(p.base, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  if (uninstall) {
    fs.rmSync(p.manifestFile, { force: true });
    pruneOwnDirs(p.base);
  } else {
    fs.writeFileSync(p.manifestFile, JSON.stringify({ version: 1, files: p.copies.map(([, rel]) => rel) }, null, 2) + '\n');
  }
  fs.mkdirSync(path.dirname(p.settingsFile), { recursive: true });
  if (fs.existsSync(p.settingsFile)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(p.settingsFile, `${p.settingsFile}.bak-model-router-${stamp}`, fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(p.settingsFile, JSON.stringify(nextSettings, null, 2) + '\n');
  log(uninstall ? 'Removed.' : 'Installed. Start a new session for it to take effect.');
  return p;
}

export function parseArgs(args) {
  const i = args.indexOf('--project');
  const next = i > -1 ? args[i + 1] : undefined;
  return {
    project: i > -1 ? (next && !next.startsWith('--') ? next : '.') : null,
    uninstall: args.includes('--uninstall'),
    yes: args.includes('--yes'),
  };
}

if (isMain(import.meta.url)) {
  try {
    run(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`install: ${err.message}`);
    process.exit(1);
  }
}
