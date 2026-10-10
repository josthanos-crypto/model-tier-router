#!/usr/bin/env node
// Refresh models/catalog.json from Anthropic. Uses the Models API when ANTHROPIC_API_KEY is set
// (authoritative line, lifecycle and effort data) and the public docs pages otherwise.
// Prices always come from the docs pricing page. Exits non-zero and writes nothing if a sanity
// check fails, so a docs redesign can never ship a broken catalog.
//
//   node scripts/update-models.mjs            update in place, print a summary
//   node scripts/update-models.mjs --dry-run  print what would change
//   node scripts/update-models.mjs --summary-file out.md   also write the summary (for the PR body)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadCatalog, loadTiers } from './lib/catalog.mjs';
import { API_MODELS, DOCS, buildCatalog, parseApiModels, parseEffort, parseOverview, parsePricing } from './lib/sources.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const summaryIdx = args.indexOf('--summary-file');
const summaryFile = summaryIdx > -1 ? args[summaryIdx + 1] : null;

async function get(url, headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'model-tier-router-updater', ...headers } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function fetchApi(key) {
  const res = await get(API_MODELS, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
  return parseApiModels(await res.json());
}

async function main() {
  const tiers = loadTiers();
  const previous = loadCatalog();
  const lines = [...new Set(Object.values(tiers.tiers).map((t) => t.line))];

  const [overviewMd, pricingMd, effortMd] = await Promise.all(
    [DOCS.overview, DOCS.pricing, DOCS.effort].map((u) => get(u).then((r) => r.text())),
  );
  let api = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      api = await fetchApi(process.env.ANTHROPIC_API_KEY);
    } catch (err) {
      console.warn(`Models API unavailable (${err.message}); falling back to docs.`);
    }
  }

  const { catalog, changed, notes, summary } = buildCatalog({
    previous,
    api,
    overview: parseOverview(overviewMd),
    pricing: parsePricing(pricingMd),
    effort: parseEffort(effortMd),
    lines,
    today: new Date().toISOString().slice(0, 10),
  });

  for (const n of notes) console.warn(`note: ${n}`);
  if (!changed) {
    console.log(`Catalog is up to date (source: ${catalog.source}).`);
    return;
  }
  const text = [`Model catalog update (source: ${catalog.source})`, '', ...summary.map((s) => `- ${s}`)].join('\n');
  console.log(text);
  if (summaryFile) fs.writeFileSync(summaryFile, text + '\n');
  if (dryRun) return;
  fs.writeFileSync(path.join(ROOT, 'models', 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
}

main().catch((err) => {
  console.error(`update-models failed: ${err.message}`);
  process.exit(1);
});
