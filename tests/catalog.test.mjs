import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  EFFORTS,
  agentRef,
  clampEffort,
  costOf,
  daysSince,
  loadCatalog,
  loadConfig,
  loadTiers,
  priceFor,
  resolveAll,
  resolveTier,
} from '../scripts/lib/catalog.mjs';

const catalog = loadCatalog();
const tiers = loadTiers();

test('the committed catalog resolves every tier to a priced model with effort levels', () => {
  const routes = resolveAll(catalog, tiers);
  for (const t of tiers.order) {
    const r = routes[t];
    const m = catalog.models.find((x) => x.id === r.model.id);
    assert.ok(m.price && m.price.input > 0 && m.price.output > 0, `${t} priced`);
    assert.ok(EFFORTS.includes(r.effort), `${t} effort ${r.effort}`);
  }
  assert.ok(/^\d{4}-\d\d-\d\d$/.test(catalog.updated_at));
});

test('tiers map to the expected lines and efforts', () => {
  const routes = resolveAll(catalog, tiers);
  assert.equal(routes.fast.line, 'haiku');
  assert.equal(routes.standard.line, 'sonnet');
  assert.equal(routes.deep.line, 'opus');
  assert.ok(EFFORTS.indexOf(routes.max.effort) >= EFFORTS.indexOf(routes.deep.effort), 'max never thinks less than deep');
  assert.equal(routes.frontier.line, 'fable');
  assert.equal(routes.frontier.manualOnly, true);
});

test('resolveTier errors are explicit', () => {
  assert.throws(() => resolveTier('nope', catalog, tiers), /unknown tier/);
  assert.throws(() => resolveTier('fast', { current: {}, models: [] }, tiers), /no current model/);
});

test('clampEffort steps down to the nearest supported level', () => {
  assert.equal(clampEffort('xhigh', ['low', 'medium', 'high', 'max']), 'high');
  assert.equal(clampEffort('max', EFFORTS), 'max');
  assert.equal(clampEffort('low', ['medium']), null);
  assert.equal(clampEffort('high', []), null);
  assert.equal(clampEffort('turbo', EFFORTS), null);
});

// Fixed prices, so these tests check the arithmetic and never break when Anthropic changes a price.
const fx = {
  models: [
    { id: 'claude-opus-5-5', price: { input: 4, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2, output: 20 } },
    { id: 'claude-opus-5', price: { input: 5, cache_write_5m: 6.25, cache_write_1h: 10, cache_read: 0.5, output: 25 } },
    { id: 'claude-haiku-4-5', price: { input: 1, cache_write_5m: 1.25, cache_write_1h: 2, cache_read: 0.1, output: 5 } },
    {
      id: 'claude-haiku-5-5',
      price: {
        input: 0.1, cache_write_5m: 0.125, cache_write_1h: 0.2, cache_read: 0.01, output: 0.5,
        long_context: { threshold: 100000, input: 0.5, cache_write_5m: 0.625, cache_write_1h: 1, cache_read: 0.05, output: 2.5 },
      },
    },
    { id: 'claude-sonnet-x' },
  ],
};

test('priceFor matches the longest id prefix', () => {
  assert.equal(priceFor(fx, 'claude-opus-5-5').output, 20);
  assert.equal(priceFor(fx, 'claude-opus-5-5[1m]').output, 20);
  assert.equal(priceFor(fx, 'claude-opus-5').output, 25, 'Opus 5 is not priced as Opus 5.5');
  assert.equal(priceFor(fx, 'claude-haiku-4-5-20251001').output, 5);
  assert.equal(priceFor(fx, 'claude-sonnet-x'), null, 'a model without a price is unpriced');
  assert.equal(priceFor(fx, 'claude-opus-5-6'), null, 'a new model is unknown, not priced as an older one');
  assert.equal(priceFor(fx, 'claude-opus-5-5-1'), null);
  assert.equal(priceFor(fx, 'gpt-9'), null);
  assert.equal(priceFor(fx, null), null);
});

test('costOf prices cache and applies Haiku long-context rates per request', () => {
  const haiku = priceFor(fx, 'claude-haiku-5-5');
  // exactly at the threshold is still the base tier; output does not count toward prompt length
  const short = costOf(haiku, { input_tokens: 100_000, output_tokens: 1_000_000 });
  assert.equal(short, (100_000 * 0.1 + 1_000_000 * 0.5) / 1e6);
  const long = costOf(haiku, { input_tokens: 50_000, cache_read_input_tokens: 60_000, output_tokens: 1000 });
  assert.equal(long, (50_000 * 0.5 + 60_000 * 0.05 + 1000 * 2.5) / 1e6);
  const opus = priceFor(fx, 'claude-opus-5-5');
  assert.equal(costOf(opus, { cache_creation_input_tokens: 1_000_000 }), 5);
  const mixed = { cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 400_000 } };
  assert.equal(costOf(opus, mixed), (600_000 * 5 + 400_000 * 8) / 1e6, '1h cache writes use the 1h rate');
  assert.equal(costOf(null, { input_tokens: 5 }), 0);
});

test('config defaults and validation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-cfg-'));
  assert.deepEqual(loadConfig(dir), { enabled: true, main_model: 'opus', log: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ main_model: 'haiku', log: false }));
  assert.deepEqual(loadConfig(dir), { enabled: true, main_model: 'opus', log: false });
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken');
  assert.equal(loadConfig(dir).main_model, 'opus');
});

test('helpers', () => {
  assert.equal(daysSince('2026-10-01', new Date('2026-10-11T12:00:00Z')), 10);
  assert.equal(daysSince('not a date'), Infinity);
  assert.equal(agentRef('router-fast', true), 'model-tier-router:router-fast');
  assert.equal(agentRef('router-fast', false), 'router-fast');
});
