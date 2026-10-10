// Parsers for Anthropic's public model data (Models API JSON and the docs' markdown pages),
// and the merge that turns them into models/catalog.json. Pure functions: no I/O here.
import { EFFORTS } from './catalog.mjs';

export const DOCS = {
  overview: 'https://platform.claude.com/docs/en/models/overview.md',
  pricing: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
  effort: 'https://platform.claude.com/docs/en/build-with-claude/effort.md',
};
export const API_MODELS = 'https://api.anthropic.com/v1/models?limit=1000';

const LINES = ['haiku', 'sonnet', 'opus', 'fable', 'mythos'];

const stripLinks = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function lineFromName(name) {
  const m = /^Claude (\w+)/i.exec(name || '');
  const line = m && m[1].toLowerCase();
  return LINES.includes(line) ? line : null;
}

// "Claude Opus 4.8" -> "claude-opus-4-8". Only for docs-derived legacy entries, used to price by prefix.
export function idFromName(name) {
  return name.toLowerCase().replace(/[ .]+/g, '-');
}

function section(md, heading) {
  const start = md.indexOf(`\n## ${heading}`);
  if (start < 0) return '';
  const next = md.indexOf('\n## ', start + 4);
  return md.slice(start, next < 0 ? undefined : next);
}

const dollars = (cell) => {
  const m = /\$\s*([\d.]+)/.exec(cell);
  return m ? Number(m[1]) : null;
};

// The "Model pricing" table: name -> price per MTok, with Haiku-style long-context rows merged.
export function parsePricing(md) {
  const out = {};
  for (const row of section(md, 'Model pricing').split('\n')) {
    if (!row.startsWith('| Claude ')) continue;
    const c = cells(row);
    if (c.length < 6) continue;
    const label = stripLinks(c[0]);
    const name = label.replace(/\s*\(.*$/, '').trim();
    const price = {
      input: dollars(c[1]),
      cache_write_5m: dollars(c[2]),
      cache_write_1h: dollars(c[3]),
      cache_read: dollars(c[4]),
      output: dollars(c[5]),
    };
    if (Object.values(price).some((v) => v === null)) continue;
    const over = /for prompts over ([\d,]+) tokens/i.exec(label);
    if (over) {
      out[name] = out[name] || {};
      out[name].long_context = { threshold: Number(over[1].replace(/,/g, '')), ...price };
      continue;
    }
    out[name] = { ...price, ...(out[name] || {}) };
    if (/limited availability/i.test(label)) out[name].availability = 'limited';
    if (/retired/i.test(label)) out[name].retired = true;
  }
  return out;
}

// The "Compare models" table: the current lineup, one column per model.
export function parseOverview(md) {
  const rows = md.split('\n').filter((l) => l.startsWith('|'));
  const headerIdx = rows.findIndex((r) => cells(r)[0] === 'Feature');
  if (headerIdx < 0) return { current: [], legacy: [] };
  const names = cells(rows[headerIdx]).slice(1).map(stripLinks);
  const rowOf = (label) => {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const c = cells(rows[i]);
      if (stripLinks(c[0]) === label) return c.slice(1);
    }
    return [];
  };
  const ids = rowOf('Claude API ID').map((c) => (/`([^`]+)`/.exec(c) || [])[1]);
  const efforts = rowOf('Default effort').map((c) => (/`([^`]+)`/.exec(c) || [])[1] || null);
  const current = names
    .map((name, i) => ({ name, id: ids[i], line: lineFromName(name), default_effort: efforts[i] || null }))
    .filter((m) => m.id);
  const legacyLine = md.split('\n').find((l) => l.startsWith('Legacy models')) || '';
  const legacy = [...legacyLine.matchAll(/\[(Claude [^\]]+)\]/g)].map((m) => m[1]);
  return { current, legacy };
}

// The effort page: which ids accept the parameter at all, and which names get xhigh / max.
export function parseEffort(md) {
  const supported = [];
  const fm = /supportedModels:\n((?:\s+- .+\n)+)/.exec(md);
  if (fm) for (const l of fm[1].split('\n')) if (l.trim().startsWith('- ')) supported.push(l.trim().slice(2).trim());
  const listFor = (level) => {
    const row = md.split('\n').find((l) => l.startsWith(`| \`${level}\``));
    const m = row && /Available on ([^|]+?)\.\s*\|/.exec(row);
    return m ? m[1].replace(/\band\s+/g, '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  };
  return { supported, xhigh: listFor('xhigh'), max: listFor('max') };
}

export function effortsFromDocs(effortDoc, id, name) {
  if (!effortDoc || !effortDoc.supported.length) return null;
  if (!effortDoc.supported.some((s) => s === id || s.startsWith(`${id}-`))) return [];
  const levels = ['low', 'medium', 'high'];
  if (effortDoc.xhigh.includes(name)) levels.push('xhigh');
  if (effortDoc.max.includes(name)) levels.push('max');
  return levels;
}

export function parseApiModels(json) {
  return (json?.data || [])
    .filter((m) => m && typeof m.id === 'string')
    .map((m) => {
      const e = m.capabilities?.effort;
      const efforts = e?.supported ? EFFORTS.filter((lvl) => e[lvl]?.supported) : e ? [] : null;
      return {
        id: m.id,
        name: m.display_name || m.id,
        line: m.line ?? null,
        lifecycle: m.lifecycle || 'active',
        created_at: m.created_at || null,
        efforts,
      };
    });
}

function versionKey(m) {
  return (m.id.match(/\d+/g) || []).map(Number);
}

function newer(a, b) {
  if (a.created_at && b.created_at && a.created_at !== b.created_at) return a.created_at > b.created_at;
  const va = versionKey(a);
  const vb = versionKey(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    if ((va[i] || 0) !== (vb[i] || 0)) return (va[i] || 0) > (vb[i] || 0);
  }
  return a.id > b.id;
}

const LINE_ORDER = (l) => (LINES.includes(l) ? LINES.indexOf(l) : LINES.length);

// Merge the sources into a catalog. `lines` are the model lines the tiers need.
export function buildCatalog({ previous, api, overview, pricing, effort, lines, today }) {
  const prev = new Map((previous?.models || []).map((m) => [m.id, m]));
  const byId = new Map();
  const put = (entry) => byId.set(entry.id, { ...(byId.get(entry.id) || {}), ...entry });

  for (const m of prev.values()) put({ ...m });
  if (api) {
    // the API lists every active and deprecated model; anything it no longer lists cannot be current
    for (const m of byId.values()) m.lifecycle = 'unlisted';
    for (const m of api) put({ id: m.id, name: m.name, line: m.line, lifecycle: m.lifecycle, created_at: m.created_at, ...(m.efforts ? { efforts: m.efforts } : {}) });
  } else {
    for (const m of overview?.current || []) put({ id: m.id, name: m.name, line: m.line, lifecycle: 'active' });
    for (const name of overview?.legacy || []) {
      const id = idFromName(name);
      if (!byId.has(id)) put({ id, name, line: lineFromName(name), lifecycle: 'active' });
    }
  }

  const priceByName = pricing || {};
  for (const [name, p] of Object.entries(priceByName)) {
    if (p.retired) continue;
    const id = [...byId.values()].find((m) => m.name === name)?.id || idFromName(name);
    if (!byId.has(id)) put({ id, name, line: lineFromName(name), lifecycle: 'active' });
  }

  const defaults = new Map((overview?.current || []).map((m) => [m.id, m.default_effort]));
  for (const m of byId.values()) {
    const p = priceByName[m.name];
    if (p) {
      const { availability, retired, ...price } = p;
      m.price = price;
      if (availability) m.availability = availability;
    }
    if (!m.efforts) {
      const fromDocs = effortsFromDocs(effort, m.id, m.name);
      if (fromDocs) m.efforts = fromDocs;
    }
    if (defaults.get(m.id)) m.default_effort = defaults.get(m.id);
  }

  const current = {};
  const notes = [];
  for (const line of lines) {
    let pick = null;
    if (api) {
      for (const m of byId.values()) {
        if (m.line === line && m.lifecycle === 'active' && m.availability !== 'limited' && (!pick || newer(m, pick))) pick = m;
      }
    } else {
      pick = (overview?.current || []).find((m) => m.line === line) || null;
    }
    current[line] = pick ? pick.id : previous?.current?.[line] || null;
    if (!pick) notes.push(`no source model for line "${line}", kept previous`);
  }

  for (const line of lines) {
    const m = byId.get(current[line]);
    if (!m) throw new Error(`sanity: line "${line}" has no current model`);
    if (!m.price) throw new Error(`sanity: ${m.id} has no price`);
    if (!Array.isArray(m.efforts) || m.efforts.length === 0) throw new Error(`sanity: ${m.id} has no effort levels`);
  }

  const models = [...byId.values()]
    .map(({ id, name, line, lifecycle, created_at, default_effort, efforts, price, availability }) =>
      Object.fromEntries(
        Object.entries({ id, name, line, lifecycle, created_at, default_effort, efforts, price, availability }).filter(
          ([, v]) => v !== undefined && v !== null,
        ),
      ),
    )
    .sort((a, b) => LINE_ORDER(a.line) - LINE_ORDER(b.line) || b.name.localeCompare(a.name, 'en', { numeric: true }));

  const body = { current, models };
  const changed = !previous || JSON.stringify({ current: previous.current, models: previous.models }) !== JSON.stringify(body);
  const catalog = {
    _comment: 'Generated by scripts/update-models.mjs from Anthropic docs or the Models API. Do not edit by hand; edit models/tiers.json for routing policy.',
    updated_at: changed ? today : previous.updated_at,
    source: api ? 'api' : 'docs',
    ...body,
  };
  return { catalog, changed, notes, summary: changed ? diffSummary(previous, catalog) : [] };
}

export function diffSummary(previous, next) {
  const out = [];
  const prev = new Map((previous?.models || []).map((m) => [m.id, m]));
  for (const [line, id] of Object.entries(next.current)) {
    const was = previous?.current?.[line];
    if (was !== id) out.push(`current ${line}: ${was || '(none)'} -> ${id}`);
  }
  for (const m of next.models) {
    const p = prev.get(m.id);
    if (!p) out.push(`new model: ${m.name} (${m.id})`);
    else if (JSON.stringify(p.price) !== JSON.stringify(m.price)) out.push(`price changed: ${m.name}`);
    else if (JSON.stringify(p.efforts) !== JSON.stringify(m.efforts)) out.push(`effort levels changed: ${m.name}`);
  }
  return out;
}
