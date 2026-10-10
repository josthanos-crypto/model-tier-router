#!/usr/bin/env node
// Report: how prompts were routed and what subagents really cost.
//   node scripts/stats.mjs [--days 7] [--data <dir>]
import path from 'node:path';
import { dataDir } from './lib/catalog.mjs';
import { isMain, readJsonl } from './lib/io.mjs';

const pct = (n, total) => (total ? `${Math.round((100 * n) / total)}%` : '0%');
const usd = (n) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export function report({ routing, telemetry, days, now = new Date() }) {
  const since = now.getTime() - days * 86_400_000;
  const recent = (rows) => rows.filter((r) => Date.parse(r.ts) >= since);
  const routed = recent(routing);
  const usage = recent(telemetry).filter((r) => r.event === 'usage');

  const out = [`## Model router: últimos ${days} días`, ''];
  if (routed.length) {
    const counts = {};
    for (const r of routed) counts[r.tier] = (counts[r.tier] || 0) + 1;
    const parts = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t} ${pct(n, routed.length)}`);
    out.push(`**Mensajes enrutados:** ${routed.length} (${parts.join(' · ')})`, '');
  } else out.push('**Mensajes enrutados:** ninguno registrado.', '');

  if (!usage.length) {
    out.push('**Subagentes:** ninguno registrado todavía.');
    return out.join('\n');
  }
  const groups = new Map();
  for (const r of usage) {
    const key = `${r.subagent_type || '?'}|${(r.models || []).join('+') || '?'}`;
    const g = groups.get(key) || { runs: 0, out: 0, usd: 0, unpriced: 0 };
    g.runs += 1;
    g.out += r.usage?.output_tokens || 0;
    if (typeof r.est_usd === 'number') g.usd += r.est_usd;
    else g.unpriced += 1;
    groups.set(key, g);
  }
  out.push('| Subagente | Modelo | Ejecuciones | Tokens de salida | Coste estimado |', '|---|---|---:|---:|---:|');
  let total = 0;
  for (const [key, g] of [...groups.entries()].sort((a, b) => b[1].usd - a[1].usd)) {
    const [agent, model] = key.split('|');
    total += g.usd;
    out.push(`| ${agent} | ${model} | ${g.runs} | ${g.out.toLocaleString('es-ES')} | ${usd(g.usd)}${g.unpriced ? ` (+${g.unpriced} sin precio)` : ''} |`);
  }
  out.push('', `**Total subagentes:** ${usd(total)}. Precios de lista; la sesión principal no se incluye.`);
  return out.join('\n');
}

if (isMain(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const dir = arg('data') || dataDir();
  const days = Number(arg('days')) > 0 ? Number(arg('days')) : 7;
  console.log(
    report({
      routing: readJsonl(path.join(dir, 'routing.jsonl')),
      telemetry: readJsonl(path.join(dir, 'telemetry.jsonl')),
      days,
    }),
  );
}
