#!/usr/bin/env node
// UserPromptSubmit hook: classify the prompt locally (no API call, no tokens) and tell the main
// session which model tier fits and how to use it. Hooks cannot switch the main session's model,
// so routing works through subagents that pin their own model and effort.
//
// Fails open: any error exits 0 with no output, so a prompt is never blocked.
//   node scripts/route-prompt.mjs --test "your prompt"   shows the decision without a session
import path from 'node:path';
import { dataDir, loadCatalog, loadConfig, loadTiers } from './lib/catalog.mjs';
import { appendJsonl, readStdinJson } from './lib/io.mjs';
import { decide } from './lib/route.mjs';

async function main() {
  const config = loadConfig();
  const ctx = { catalog: loadCatalog(), tiers: loadTiers(), config };
  const testIdx = process.argv.indexOf('--test');
  if (testIdx > -1) {
    const d = decide(process.argv.slice(testIdx + 1).join(' '), ctx);
    console.log(d ? `tier=${d.tier} score=${d.score} via=${d.via} payload=${d.payload}\n${d.output?.hookSpecificOutput.additionalContext || '(routing off for this prompt)'}` : 'not routed');
    return;
  }
  if (!config.enabled || process.env.MODEL_ROUTER === 'off') return;
  const input = await readStdinJson();
  const d = decide(input.prompt, ctx);
  if (!d) return;
  if (config.log) {
    try {
      appendJsonl(path.join(dataDir(), 'routing.jsonl'), {
        ts: new Date().toISOString(),
        session_id: input.session_id || null,
        chars: input.prompt.length,
        payload: d.payload,
        tier: d.tier,
        score: d.score,
        via: d.via,
      });
    } catch {
      // logging is best effort
    }
  }
  if (d.output) process.stdout.write(JSON.stringify(d.output));
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
