#!/usr/bin/env node
// SessionStart hook: one short line of routing context, plus a nudge when the model catalog
// looks out of date (old, or telemetry has seen a model the catalog does not know).
import path from 'node:path';
import { dataDir, daysSince, loadCatalog, loadConfig, loadTiers, priceFor, resolveAll } from './lib/catalog.mjs';
import { isMain, readJsonl } from './lib/io.mjs';
import { label } from './lib/route.mjs';

export const STALE_DAYS = 120;

export function sessionContext({ catalog, tiers, config, telemetry = [], now = new Date() }) {
  const routes = resolveAll(catalog, tiers);
  const list = tiers.order.map((t) => `${t}=${label(routes[t])}${routes[t].manualOnly ? ' (on request)' : ''}`).join(', ');
  const lines = [
    `[model-router] ${list}. Main session expected on ${config.main_model}. User prefixes: !fast !std !deep !max !fable, !off to skip. Catalog ${catalog.updated_at}.`,
  ];
  const notes = [];
  const age = daysSince(catalog.updated_at, now);
  if (age > STALE_DAYS) notes.push(`the model catalog is ${age} days old`);
  const unknown = [...new Set(telemetry.flatMap((r) => r.models || []).filter((m) => m && !priceFor(catalog, m)))];
  if (unknown.length) notes.push(`subagents ran models the catalog does not know (${unknown.slice(0, 3).join(', ')})`);
  if (notes.length)
    lines.push(`Note: ${notes.join('; ')}. Suggest once, in one line, running "/plugin marketplace update model-tier-router".`);
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  try {
    const config = loadConfig();
    if (config.enabled && process.env.MODEL_ROUTER !== 'off') {
      const telemetry = readJsonl(path.join(dataDir(), 'telemetry.jsonl')).slice(-200);
      const text = sessionContext({ catalog: loadCatalog(), tiers: loadTiers(), config, telemetry });
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
    }
  } catch {
    // fail open
  }
  process.exit(0);
}
