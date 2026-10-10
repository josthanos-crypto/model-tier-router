#!/usr/bin/env node
// PostToolUse(Agent|Task) and SubagentStop hook: record which model each subagent really ran,
// its tokens and its estimated cost, in <data dir>/telemetry.jsonl. Runs async; fails open.
//
// Telemetry design adapted from DevstateBelgium/model-router (MIT).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costOf, dataDir, loadCatalog, priceFor } from './lib/catalog.mjs';
import { appendJsonl, isMain, readStdinJson } from './lib/io.mjs';

function parseResponse(r) {
  if (typeof r !== 'string') return r || {};
  try {
    return JSON.parse(r);
  } catch {
    return {};
  }
}

const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// Sum usage over every API request in a subagent transcript; one message id can span several lines.
export function sumTranscript(text, catalog) {
  const byId = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const m = e.message;
    if (e.type !== 'assistant' || !m || !m.usage) continue;
    byId.set(m.id || `#${byId.size}`, { model: m.model, usage: m.usage });
  }
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const models = new Set();
  let usd = 0;
  let priced = true;
  for (const { model, usage: u } of byId.values()) {
    if (model) models.add(model);
    for (const k of Object.keys(usage)) usage[k] += u[k] || 0;
    const price = priceFor(catalog, model);
    if (!price) priced = false;
    usd += costOf(price, u);
  }
  return { api_calls: byId.size, models: [...models], usage, est_usd: priced ? Math.round(usd * 10000) / 10000 : null };
}

export function telemetryRow(input, catalog, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  const base = {
    ts: new Date().toISOString(),
    env: process.env.CLAUDE_CODE_REMOTE === 'true' ? 'cloud' : 'local',
    session_id: input.session_id || null,
  };
  const event = input.hook_event_name;
  if (event === 'PostToolUse' && (input.tool_name === 'Agent' || input.tool_name === 'Task')) {
    const ti = input.tool_input || {};
    const tr = parseResponse(input.tool_response ?? input.tool_output);
    return {
      ...base,
      event: 'call',
      agent_id: tr.agentId || null,
      subagent_type: ti.subagent_type || 'general-purpose',
      requested_model: ti.model || null,
      resolved_model: tr.resolvedModel || null,
      duration_ms: tr.totalDurationMs ?? null,
    };
  }
  if (event === 'SubagentStop') {
    const file = expandHome(input.agent_transcript_path);
    let sums = {};
    try {
      if (file) sums = sumTranscript(readFile(file), catalog);
    } catch {
      // transcript not readable; log the event without usage
    }
    return { ...base, event: 'usage', agent_id: input.agent_id || null, subagent_type: input.agent_type || null, ...sums };
  }
  return null;
}

if (isMain(import.meta.url)) {
  try {
    const row = telemetryRow(await readStdinJson(), loadCatalog());
    if (row) appendJsonl(path.join(dataDir(), 'telemetry.jsonl'), row);
  } catch {
    // fail open
  }
  process.exit(0);
}
