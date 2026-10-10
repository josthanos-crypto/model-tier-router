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
  const start = `\n${md}`.indexOf(`\n## ${heading}`);
  if (start < 0) return '';
  const next = md.indexOf('\n## ', start + 4);
  return md.slice(start, next < 0 ? undefined : next);
}

const dollars = (cell) => {
  const m = /\$\s*([\d.]+)/.exec(cell);
  return m ? Number(m[1]) : null;
};

const PRICE_COLUMNS = {
  input: /base input/i,
  cache_write_5m: /5m cache/i,
  cache_write_1h: /1h cache/i,
  cache_read: /cache (hits|reads?)/i,
  output: /^output/i,
};

// The "Model pricing" table: name -> price per MTok, with Haiku-style long-context rows merged.
// Columns are found by their header, so a reordered table cannot swap prices; a missing
// section or column throws, so a docs redesign fails the update loudly instead of silently.
export function parsePricing(md) {
  const rows = section(md, 'Model pricing').split('\n').filter((l) => l.startsWith('|'));
  const header = rows.length ? cells(rows[0]) : [];
  const col = {};
  for (const [key, re] of Object.entries(PRICE_COLUMNS)) {
    col[key] = header.findIndex((h) => re.test(h));
    if (col[key] < 1) throw new Error(`pricing table: no "${key}" column (header: ${header.join(' | ') || 'none'})`);
  }
  const out = {};
  for (const row of rows) {
    if (!row.startsWith('| Claude ')) continue;
    const c = cells(row);
    const label = stripLinks(c[0]);
    const name = label.replace(/\s*\(.*$/, '').trim();
    const price = Object.fromEntries(Object.entries(col).map(([key, i]) => [key, dollars(c[i] || '')]));
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
  if (headerIdx < 0) throw new Error('models overview: comparison table not found');
  const names = cells(rows[headerIdx]).slice(1).map(stripLinks);
  const rowOf = (label) => {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const c = cells(rows[i]);
      if (stripLinks(c[0]) === label) return c.slice(1);
    }
    return [];
  };
  const ids = rowOf('Claude API ID').map((c) => (/`([^`]+)`/.exec(c) || [])[1]);
  if (!ids.some(Boolean)) throw new Error('models overview: "Claude API ID" row not found');
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
  const xhigh = listFor('xhigh');
  const max = listFor('max');
  // If either list cannot be read, the page changed shape: report nothing rather than
  // silently dropping levels (a new model then fails the sanity check instead).
  if (!xhigh.length || !max.length) return { supported: [], xhigh: [], max: [] };
  return { supported, xhigh, max };
}

// "claude-opus-4-5-20251101" is the dated snapshot of "claude-opus-4-5"; "claude-opus-4-5-1" is not.
export function sameModel(listed, id) {
  return listed === id || (listed.startsWith(`${id}-`) && /^\d{8}$/.test(listed.slice(id.length + 1)));
}

export function effortsFromDocs(effortDoc, id, name) {
  if (!effortDoc || !effortDoc.supported.length) return null;
  if (!effortDoc.supported.some((s) => sameModel(s, id))) return [];
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
        line: m.line ?? lineFromName(m.display_name),
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
// `required` maps each line to the effort levels its tiers use; a current model must support them.
export function buildCatalog({ previous, api, overview, pricing, effort, lines, required = {}, today }) {
  const prev = new Map((previous?.models || []).map((m) => [m.id, m]));
  const byId = new Map();
  const defined = (entry) => Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== null));
  const put = (entry) => byId.set(entry.id, { ...(byId.get(entry.id) || {}), ...defined(entry) });

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
  for (const line of lines) {
    let pick = null;
    if (api) {
      for (const m of byId.values()) {
        if (m.line === line && m.lifecycle === 'active' && m.availability !== 'limited' && (!pick || newer(m, pick))) pick = m;
      }
    } else {
      pick = (overview?.current || []).find((m) => m.line === line) || null;
    }
    if (!pick) throw new Error(`sanity: no current model found for line "${line}"`);
    current[line] = pick.id;
  }

  for (const line of lines) {
    const m = byId.get(current[line]);
    if (!m) throw new Error(`sanity: line "${line}" has no current model`);
    const p = m.price;
    if (!p) throw new Error(`sanity: ${m.id} has no price`);
    if (!(p.cache_read > 0 && p.cache_read < p.input && p.input < p.output && p.cache_write_5m >= p.input && p.cache_write_1h >= p.cache_write_5m))
      throw new Error(`sanity: ${m.id} prices look wrong: ${JSON.stringify(p)}`);
    if (!Array.isArray(m.efforts) || m.efforts.length === 0) throw new Error(`sanity: ${m.id} has no effort levels`);
    const missing = (required[line] || []).filter((e) => !m.efforts.includes(e));
    if (missing.length)
      throw new Error(`sanity: ${m.id} does not support effort ${missing.join(', ')} used by models/tiers.json; adjust the tiers`);
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
  return { catalog, changed, summary: changed ? diffSummary(previous, catalog) : [] };
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
