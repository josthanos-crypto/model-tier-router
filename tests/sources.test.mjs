import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCatalog,
  effortsFromDocs,
  idFromName,
  lineFromName,
  parseApiModels,
  parseEffort,
  parseOverview,
  parsePricing,
} from '../scripts/lib/sources.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
const LINES = ['haiku', 'sonnet', 'opus', 'fable'];
const docs = () => ({ overview: parseOverview(fixture('overview.md')), pricing: parsePricing(fixture('pricing.md')), effort: parseEffort(fixture('effort.md')) });

test('pricing table: base, cache and output prices per model', () => {
  const p = parsePricing(fixture('pricing.md'));
  assert.deepEqual(p['Claude Opus 5.5'], { input: 4, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2, output: 20 });
  assert.equal(p['Claude Fable 5.1'].output, 50);
  assert.equal(p['Claude Mythos 5.1'].availability, 'limited');
  assert.equal(p['Claude Opus 4.1'].retired, true);
});

test('pricing table: Haiku 5.5 long-context tier is merged into one entry', () => {
  const h = parsePricing(fixture('pricing.md'))['Claude Haiku 5.5'];
  assert.equal(h.input, 0.1);
  assert.equal(h.output, 0.5);
  assert.deepEqual(h.long_context, { threshold: 100000, input: 0.5, cache_write_5m: 0.625, cache_write_1h: 1, cache_read: 0.05, output: 2.5 });
});

test('pricing parser fails loudly without the "Model pricing" table', () => {
  assert.throws(() => parsePricing('## Batch processing\n| Claude Opus 5.5 | $2 / MTok | $1 | $1 | $1 | $10 / MTok |\n'), /no "input" column/);
});

test('pricing columns are read by header, so a reordered table keeps prices right', () => {
  const md = [
    '## Model pricing',
    '| Model | Output tokens | 1h cache writes | 5m cache writes | Cache hits and refreshes | Base input tokens |',
    '| :-- | :-- | :-- | :-- | :-- | :-- |',
    '| Claude Opus 5.5 | $20 / MTok | $8 / MTok | $5 / MTok | $0.20 / MTok | $4 / MTok |',
  ].join('\n');
  assert.deepEqual(parsePricing(md)['Claude Opus 5.5'], { input: 4, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2, output: 20 });
});

test('overview: current lineup with ids, lines and default effort', () => {
  const { current, legacy } = parseOverview(fixture('overview.md'));
  assert.deepEqual(
    current.map((m) => [m.id, m.line, m.default_effort]),
    [
      ['claude-fable-5-1', 'fable', 'high'],
      ['claude-opus-5-5', 'opus', 'medium'],
      ['claude-sonnet-5-5', 'sonnet', 'high'],
      ['claude-haiku-5-5', 'haiku', 'medium'],
    ],
  );
  assert.ok(legacy.includes('Claude Haiku 4.5'));
  assert.ok(legacy.includes('Claude Opus 5'));
});

test('overview fails loudly when the table or the id row is missing', () => {
  assert.throws(() => parseOverview('# nothing here'), /comparison table not found/);
  const renamed = fixture('overview.md').replace('| Claude API ID ', '| API model name ');
  assert.throws(() => parseOverview(renamed), /"Claude API ID" row not found/);
});

test('a reworded effort table reports nothing instead of dropping xhigh', () => {
  const reworded = fixture('effort.md').replace(/Extended capability for long-horizon work\. Available on/, 'Extended capability. Supported by');
  const e = parseEffort(reworded);
  assert.deepEqual(e, { supported: [], xhigh: [], max: [] });
  assert.equal(effortsFromDocs(e, 'claude-opus-5-5', 'Claude Opus 5.5'), null);
});

test('effort page: supported ids and xhigh/max availability', () => {
  const e = parseEffort(fixture('effort.md'));
  assert.ok(e.supported.includes('claude-haiku-5-5'));
  assert.ok(e.xhigh.includes('Claude Sonnet 5.5'));
  assert.ok(!e.xhigh.includes('Claude Opus 4.6'));
  assert.ok(e.max.includes('Claude Opus 4.6'));
  assert.deepEqual(effortsFromDocs(e, 'claude-opus-5-5', 'Claude Opus 5.5'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortsFromDocs(e, 'claude-opus-4-6', 'Claude Opus 4.6'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(effortsFromDocs(e, 'claude-opus-4-5', 'Claude Opus 4.5'), ['low', 'medium', 'high'], 'dated id in the list');
  assert.deepEqual(effortsFromDocs(e, 'claude-haiku-4-5', 'Claude Haiku 4.5'), []);
  assert.equal(effortsFromDocs({ supported: [], xhigh: [], max: [] }, 'x', 'X'), null);
});

test('name helpers', () => {
  assert.equal(lineFromName('Claude Opus 5.5'), 'opus');
  assert.equal(lineFromName('Claude Banana 1'), null);
  assert.equal(idFromName('Claude Opus 4.8'), 'claude-opus-4-8');
});

test('docs-only catalog: current models, prices and efforts', () => {
  const { catalog, changed } = buildCatalog({ previous: null, api: null, ...docs(), lines: LINES, today: '2026-10-10' });
  assert.equal(changed, true);
  assert.equal(catalog.source, 'docs');
  assert.deepEqual(catalog.current, { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' });
  const opus = catalog.models.find((m) => m.id === 'claude-opus-5-5');
  assert.equal(opus.price.output, 20);
  assert.deepEqual(opus.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(!catalog.models.some((m) => m.id === 'claude-opus-4-1'), 'retired models are not added');
});

test('a second run with the same data reports no change and keeps the date', () => {
  const first = buildCatalog({ previous: null, api: null, ...docs(), lines: LINES, today: '2026-10-10' }).catalog;
  const again = buildCatalog({ previous: first, api: null, ...docs(), lines: LINES, today: '2026-12-01' });
  assert.equal(again.changed, false);
  assert.equal(again.catalog.updated_at, '2026-10-10');
  assert.deepEqual(again.summary, []);
});

function apiModel(id, line, created, efforts = ['low', 'medium', 'high', 'xhigh', 'max'], extra = {}) {
  const effort = { supported: efforts.length > 0 };
  for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max']) effort[lvl] = { supported: efforts.includes(lvl) };
  return { id, display_name: extra.name || id, line, created_at: created, lifecycle: extra.lifecycle || 'active', capabilities: { effort } };
}

test('Models API: a new model in a line becomes current and is reported', () => {
  const previous = buildCatalog({ previous: null, api: null, ...docs(), lines: LINES, today: '2026-10-10' }).catalog;
  const api = parseApiModels({
    data: [
      apiModel('claude-opus-6', 'opus', '2027-01-15T00:00:00Z', ['low', 'medium', 'high', 'max'], { name: 'Claude Opus 6' }),
      apiModel('claude-opus-5-5', 'opus', '2026-09-22T00:00:00Z', undefined, { name: 'Claude Opus 5.5' }),
      apiModel('claude-sonnet-5-5', 'sonnet', '2026-09-28T00:00:00Z', undefined, { name: 'Claude Sonnet 5.5' }),
      apiModel('claude-haiku-5-5', 'haiku', '2026-10-07T00:00:00Z', undefined, { name: 'Claude Haiku 5.5' }),
      apiModel('claude-fable-5-1', 'fable', '2026-09-01T00:00:00Z', undefined, { name: 'Claude Fable 5.1' }),
      apiModel('claude-fable-5', 'fable', '2026-06-01T00:00:00Z', undefined, { name: 'Claude Fable 5', lifecycle: 'deprecated' }),
    ],
  });
  const pricing = { ...docs().pricing, 'Claude Opus 6': { input: 4, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2, output: 20 } };
  const { catalog, changed, summary } = buildCatalog({ previous, api, ...docs(), pricing, lines: LINES, today: '2027-01-20' });
  assert.equal(changed, true);
  assert.equal(catalog.current.opus, 'claude-opus-6');
  assert.equal(catalog.updated_at, '2027-01-20');
  assert.ok(summary.includes('current opus: claude-opus-5-5 -> claude-opus-6'));
  assert.ok(summary.includes('new model: Claude Opus 6 (claude-opus-6)'));
  assert.deepEqual(catalog.models.find((m) => m.id === 'claude-opus-6').efforts, ['low', 'medium', 'high', 'max']);
});

test('Models API: deprecated and limited models never become current', () => {
  const api = parseApiModels({
    data: [
      apiModel('claude-haiku-5-5', 'haiku', '2026-10-07T00:00:00Z', undefined, { name: 'Claude Haiku 5.5' }),
      apiModel('claude-sonnet-5-5', 'sonnet', '2026-09-28T00:00:00Z', undefined, { name: 'Claude Sonnet 5.5' }),
      apiModel('claude-opus-5-5', 'opus', '2026-09-22T00:00:00Z', undefined, { name: 'Claude Opus 5.5' }),
      apiModel('claude-opus-9', 'opus', '2027-09-22T00:00:00Z', undefined, { name: 'Claude Opus 9', lifecycle: 'deprecated' }),
      apiModel('claude-fable-5-1', 'fable', '2026-09-01T00:00:00Z', undefined, { name: 'Claude Fable 5.1' }),
    ],
  });
  const pricing = { ...docs().pricing, 'Claude Opus 9': { input: 1, cache_write_5m: 1, cache_write_1h: 1, cache_read: 1, output: 1 } };
  const { catalog } = buildCatalog({ previous: null, api, ...docs(), pricing, lines: LINES, today: '2027-10-01' });
  assert.equal(catalog.current.opus, 'claude-opus-5-5');
  assert.equal(catalog.source, 'api');
});

const current5 = () => [
  apiModel('claude-haiku-5-5', 'haiku', '2026-10-07T00:00:00Z', undefined, { name: 'Claude Haiku 5.5' }),
  apiModel('claude-sonnet-5-5', 'sonnet', '2026-09-28T00:00:00Z', undefined, { name: 'Claude Sonnet 5.5' }),
  apiModel('claude-opus-5-5', 'opus', '2026-09-22T00:00:00Z', undefined, { name: 'Claude Opus 5.5' }),
  apiModel('claude-fable-5-1', 'fable', '2026-09-01T00:00:00Z', undefined, { name: 'Claude Fable 5.1' }),
];

test('sanity: a current model without a price aborts the update', () => {
  const api = parseApiModels({ data: [...current5(), apiModel('claude-haiku-6', 'haiku', '2027-01-01T00:00:00Z', undefined, { name: 'Claude Haiku 6' })] });
  assert.throws(() => buildCatalog({ previous: null, api, ...docs(), lines: LINES, today: '2027-01-02' }), /claude-haiku-6 has no price/);
});

test('sanity: implausible prices abort the update', () => {
  const pricing = { ...docs().pricing, 'Claude Opus 5.5': { input: 20, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2, output: 4 } };
  assert.throws(() => buildCatalog({ previous: null, api: null, ...docs(), pricing, lines: LINES, today: '2026-10-10' }), /prices look wrong/);
});

test('sanity: a model that lacks an effort the tiers use aborts the update', () => {
  const api = parseApiModels({ data: [...current5(), apiModel('claude-opus-6', 'opus', '2027-01-15T00:00:00Z', ['low', 'medium', 'high'], { name: 'Claude Opus 6' })] });
  const pricing = { ...docs().pricing, 'Claude Opus 6': { input: 4, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2, output: 20 } };
  const required = { opus: ['high', 'xhigh'] };
  assert.throws(() => buildCatalog({ previous: null, api, ...docs(), pricing, lines: LINES, required, today: '2027-01-20' }), /does not support effort xhigh/);
});

test('sanity: a line with no source model aborts instead of silently keeping the old one', () => {
  const previous = buildCatalog({ previous: null, api: null, ...docs(), lines: LINES, today: '2026-10-10' }).catalog;
  const overview = { ...docs().overview, current: docs().overview.current.filter((m) => m.line !== 'fable') };
  assert.throws(() => buildCatalog({ previous, api: null, ...docs(), overview, lines: LINES, today: '2026-10-11' }), /no current model found for line "fable"/);
});

test('Models API without a line field falls back to the display name and keeps known lines', () => {
  const data = current5().map(({ line, ...m }) => m);
  const previous = buildCatalog({ previous: null, api: null, ...docs(), lines: LINES, today: '2026-10-10' }).catalog;
  const { catalog } = buildCatalog({ previous, api: parseApiModels({ data }), ...docs(), lines: LINES, today: '2026-10-11' });
  assert.deepEqual(catalog.current, previous.current);
  assert.equal(catalog.models.find((m) => m.id === 'claude-opus-4-8').line, 'opus', 'unlisted models keep their line');
});

test('parseApiModels tolerates junk and missing capabilities', () => {
  assert.deepEqual(parseApiModels(null), []);
  const [m] = parseApiModels({ data: [{ id: 'claude-x', line: null }, 42] });
  assert.equal(m.name, 'claude-x');
  assert.equal(m.efforts, null);
});
