// Model catalog and routing policy: load, resolve a tier to a concrete model, price usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PLUGIN_NAME = 'model-tier-router';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// One fixed place, so hooks (which get plugin env vars) and Bash commands (which do not) agree.
export function dataDir() {
  return process.env.MODEL_ROUTER_DATA || path.join(os.homedir(), '.claude', 'model-router');
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function loadCatalog(root = ROOT) {
  return readJson(path.join(root, 'models', 'catalog.json'), null);
}

export function loadTiers(root = ROOT) {
  return readJson(path.join(root, 'models', 'tiers.json'), null);
}

const DEFAULT_CONFIG = { enabled: true, main_model: 'opus', log: true };

export function loadConfig(dir = dataDir()) {
  const user = readJson(path.join(dir, 'config.json'), {});
  const cfg = { ...DEFAULT_CONFIG, ...(user && typeof user === 'object' ? user : {}) };
  if (!['opus', 'sonnet'].includes(cfg.main_model)) cfg.main_model = DEFAULT_CONFIG.main_model;
  return cfg;
}

export function findModel(catalog, id) {
  return catalog?.models?.find((m) => m.id === id) || null;
}

// The highest supported effort that does not exceed the requested one.
export function clampEffort(requested, supported) {
  const want = EFFORTS.indexOf(requested);
  if (want < 0) return null;
  if (!Array.isArray(supported) || supported.length === 0) return null;
  for (let i = want; i >= 0; i--) if (supported.includes(EFFORTS[i])) return EFFORTS[i];
  return null;
}

export function resolveTier(name, catalog, tiers) {
  const tier = tiers?.tiers?.[name];
  if (!tier) throw new Error(`unknown tier: ${name}`);
  const id = catalog?.current?.[tier.line];
  const model = findModel(catalog, id);
  if (!model) throw new Error(`no current model for line "${tier.line}" (tier ${name})`);
  return {
    tier: name,
    line: tier.line,
    agent: tier.agent,
    manualOnly: Boolean(tier.manual_only),
    model: { id: model.id, name: model.name },
    effort: clampEffort(tier.effort, model.efforts),
  };
}

export function resolveAll(catalog, tiers) {
  return Object.fromEntries(tiers.order.map((t) => [t, resolveTier(t, catalog, tiers)]));
}

// Longest catalog id that prefixes the model string, so suffixed ids like "claude-opus-5-5[1m]" still price.
export function priceFor(catalog, modelId) {
  if (!modelId || !catalog?.models) return null;
  let best = null;
  for (const m of catalog.models) {
    if (m.price && modelId.startsWith(m.id) && (!best || m.id.length > best.id.length)) best = m;
  }
  return best ? best.price : null;
}

// USD for one API request. Long-context tiers apply per request, on the whole prompt including cache.
export function costOf(price, usage) {
  if (!price || !usage) return 0;
  const input = usage.input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const write1h = Math.min(write, usage.cache_creation?.ephemeral_1h_input_tokens || 0);
  const read = usage.cache_read_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const lc = price.long_context;
  const p = lc && input + write + read > lc.threshold ? { ...price, ...lc } : price;
  const writeCost = (write - write1h) * p.cache_write_5m + write1h * (p.cache_write_1h ?? p.cache_write_5m);
  return (input * p.input + writeCost + read * p.cache_read + output * p.output) / 1_000_000;
}

export function daysSince(isoDate, now = new Date()) {
  const t = Date.parse(isoDate);
  return Number.isNaN(t) ? Infinity : Math.floor((now.getTime() - t) / 86_400_000);
}

export function agentRef(agent, asPlugin = Boolean(process.env.CLAUDE_PLUGIN_ROOT)) {
  return asPlugin ? `${PLUGIN_NAME}:${agent}` : agent;
}
