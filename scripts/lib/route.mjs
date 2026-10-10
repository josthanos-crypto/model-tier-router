// Turn a classification into the routing note the main session reads.
import { agentRef, resolveAll } from './catalog.mjs';
import { SYSTEM_PROMPT, classify } from './classify.mjs';

export const label = (r) => `${r.model.name}${r.effort ? ` · ${r.effort}` : ''}`;

export function instructions(tier, routes, mainModel) {
  const r = routes[tier];
  const head = `[model-router] tier=${tier} → ${label(r)}.`;
  const agent = (t) => `subagent_type "${agentRef(routes[t].agent)}" (run_in_background: false)`;
  const verify = ' Verify the result yourself; on ESCALATE or a failed check, retry once with a sharper brief, then go one tier up.';

  if (tier === 'fast')
    return `${head} If it takes more than a couple of tool calls and needs no context from this conversation, delegate it to ${agent('fast')} and relay the answer; otherwise answer directly and tersely.`;
  if (tier === 'frontier')
    return `${head} Requested by the user. Send a complete brief (goal, material, constraints, what is known) to ${agent('frontier')}, then present its result.${verify}`;
  if (mainModel === 'opus') {
    if (tier === 'standard')
      return `${head} If the task is clearly specified, self-contained and more than a few lines of work, brief ${agent('standard')}; if it is tiny or depends on this conversation, do it directly.${verify}`;
    const extra = tier === 'max' ? ' Think it through thoroughly.' : '';
    return `${head} Handle it in this session: read the relevant material first, plan, act, then verify. Delegate clearly scoped sub-parts to ${agent('standard')}.${extra}`;
  }
  if (tier === 'standard')
    return `${head} Handle it directly. If it proves complex (unclear cause, design decision, multi-file change), brief ${agent('deep')} first.`;
  return `${head} Send a complete brief (goal, files, constraints, what you already know) to ${agent(tier)}, wait for its plan, then implement and verify it yourself.`;
}

export function decide(prompt, { catalog, tiers, config }) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.trimStart().startsWith('/')) return null;
  if (SYSTEM_PROMPT.test(prompt)) return null; // agent notices etc. are not user prompts; routing them could loop
  const result = classify(prompt, config.thresholds);
  if (result.tier === 'none') return { ...result, output: null };
  const routes = resolveAll(catalog, tiers);
  const r = routes[result.tier];
  return {
    ...result,
    output: {
      systemMessage: `🧭 ${result.tier} → ${label(r)}`,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: instructions(result.tier, routes, config.main_model),
      },
    },
  };
}
