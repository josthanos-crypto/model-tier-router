#!/usr/bin/env node
// SessionStart hook: one short line of routing context, plus a nudge when the model catalog
// looks out of date: the session or a subagent runs a model the catalog does not know.
import path from 'node:path';
import { dataDir, loadCatalog, loadConfig, loadTiers, priceFor, resolveAll } from './lib/catalog.mjs';
import { isMain, readJsonl, readStdinJson } from './lib/io.mjs';
import { label } from './lib/route.mjs';

export function sessionContext({ catalog, tiers, config, telemetry = [], sessionModel = null }) {
  const routes = resolveAll(catalog, tiers);
  const list = tiers.order.map((t) => `${t}=${label(routes[t])}${routes[t].manualOnly ? ' (on request)' : ''}`).join(', ');
  const lines = [
    `[model-router] ${list}. Main session expected on ${config.main_model}. User prefixes: !fast !std !deep !max !fable, !off to skip. Catalog ${catalog.updated_at}.`,
  ];
  const notes = [];
  const seen = telemetry.flatMap((r) => (r && Array.isArray(r.models) ? r.models : []));
  if (typeof sessionModel === 'string' && sessionModel.startsWith('claude-')) seen.push(sessionModel);
  const unknown = [...new Set(seen.filter((m) => typeof m === 'string' && !priceFor(catalog, m)))];
  if (unknown.length) notes.push(`this setup runs models the catalog does not know (${unknown.slice(0, 3).join(', ')})`);
  if (notes.length)
    lines.push(`Note: ${notes.join('; ')}. Suggest once, in one line, running "/plugin marketplace update model-tier-router".`);
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  try {
    const config = loadConfig();
    if (config.enabled && process.env.MODEL_ROUTER !== 'off') {
      const input = await readStdinJson();
      const telemetry = readJsonl(path.join(dataDir(), 'telemetry.jsonl')).slice(-200);
      const text = sessionContext({ catalog: loadCatalog(), tiers: loadTiers(), config, telemetry, sessionModel: input.model });
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
    }
  } catch {
    // fail open
  }
  process.exit(0);
}
