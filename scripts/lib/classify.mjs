// Local, zero-token prompt classifier (English and Spanish). Scores only what the user WROTE:
// pasted logs, code, invoices and documents count as payload, which can raise a prompt to
// "standard" but is not meant to push a simple ask up to Opus.
//
// Heuristic design adapted from shaaz1000/claude-router (MIT); Spanish patterns are new here.

export const TIERS = ['fast', 'standard', 'deep', 'max', 'frontier'];
export const DEFAULT_THRESHOLDS = { fast_max_chars: 160, deep_score: 3, max_score: 6 };

// pattern -> weight (3 = deep on its own, 2 = needs company, 1 = weak hint)
const DEEP = {
  // English
  'root cause': 3, 'race conditions?': 3, 'deadlocks?': 3, 'memory leaks?': 3, 'security (audit|review)': 3,
  'vulnerab\\w+': 3, 'architect\\w*': 3, 'distributed': 3, 'from scratch': 3, 'ultrathink': 3,
  'think (hard|deeply)': 3, 'flaky': 3, 'intermittent\\w*': 3, 'bottleneck\\w*': 3, 'concurren\\w+': 3,
  'across (the|our|my) (codebase|repo|project|services)': 3, "why (does|is|isn't|doesn't|do|are|did)": 3,
  'design (a|an|the)? ?\\w* ?(system|schema|api|architecture|service)': 3, 'monolith\\w*': 3,
  '(figure|find) out (why|what|how)': 3, "how (is|was) that possible|how that's possible": 3,
  'redesign\\w*': 3, '(nobody|no one) knows why': 3, 'not sure (how|what|whether|if|where)': 3, 'poke holes': 3,
  'refactor\\w*': 2, 'migrat\\w+': 2, 'optimi[sz]\\w*': 2, 'performance': 2, 'scal(e|ing|ability)': 2,
  'trade ?offs?': 2, 'debug\\w*': 2, 'investigate': 2, 'rewrite': 2, 'end to end': 2, 'plan (out|for|the|to)': 2,
  '(multi|several|multiple) (file|service|step)s?': 2, 'profil(e|ing)': 2, 'decoupl\\w+': 2,
  '(split|extract|break) .{0,40} (into|out)': 2, 'event driven': 2, 'idempoten\\w+': 2, 'critique': 2,
  'how should we': 2, 'data model': 2, '(best|right) (way|approach) to': 2, 'brainstorm\\w*': 2,
  'explor\\w+ (options|ideas|approaches)': 2, 'should (i|we) (use|go|pick|choose)': 2, 'pros and cons': 2,
  'restructur\\w+': 2,
  'implement\\w*': 1, 'build (a|an|the|me)': 1, 'production': 1, 'under load': 1, 'properly': 1,
  'strategy': 1, 'evaluate': 1,
  // Spanish (matched after accents are stripped). English stems that also match Spanish words
  // (refactor-, optimi-, implement-, concurren-, format-, indent-) are not repeated here.
  'causa raiz': 3, 'condicion(es)? de carrera': 3, 'interbloqueos?|bloqueo mutuo': 3, 'fugas? de memoria': 3,
  '(auditoria|revision) de seguridad': 3, 'vulnerabilidad(es)?': 3, 'arquitectura': 3, 'distribuid[oa]s?': 3,
  'desde cero': 3, 'piensa (bien|a fondo|profundamente|detenidamente)|razona a fondo': 3, 'intermitentes?': 3,
  'cuellos? de botella': 3, 'en todo el (codigo|repo|repositorio|proyecto)': 3,
  'por que (falla|fallan|no|pasa|ocurre|sale|salen|da|dan|es|son|esta|estan|se)': 3,
  'disen(a|ar|ame|o)( un| una| el| la)?( \\w+)? (sistema|esquema|api|arquitectura|servicio|estrategia|modelo)': 3,
  'no (se|sabemos|tengo claro|tenemos claro|estoy seguro|estamos seguros) (como|que|si|cual|donde|por que)': 3,
  'nadie sabe (por que|como)': 3, '(averigua|averiguar|descubre|descubrir) (por que|que|como)': 3,
  'redisen\\w+': 3, 'monolito': 3, 'como es posible': 3,
  'migr(a|ar|ad\\w*|acion|aciones)': 2, 'rendimiento': 2,
  'escalabilidad|escalar': 2, 'pros y contras|ventajas y (desventajas|inconvenientes)': 2, 'depur\\w+': 2,
  'investiga(r|ndo|cion)?': 2, 'reescrib\\w+': 2, 'de principio a fin|de extremo a extremo': 2, 'planific\\w+|plan (para|de)': 2,
  '(varios|multiples|muchos) (archivos|ficheros|servicios|pasos|modulos|suministros)': 2, 'desacopl\\w+': 2,
  'critica(r)?': 2, 'como deberiamos': 2, '(mejor|correcta) (forma|manera|opcion) de': 2, 'lluvia de ideas': 2,
  'explora\\w* (opciones|ideas|alternativas)': 2, 'deberia(mos)? (usar|elegir|ir con|optar)': 2,
  'reestructur\\w+': 2, 'modelo de datos': 2, '(estudio|informe|analisis) (completo|detallado|a fondo|en profundidad)': 2,
  '(compara|comparar|comparativa)\\w* (en detalle|a fondo|completa)': 2,
  '(construye|crea|creame|hazme|haz) (un|una|el|la)': 1, 'produccion': 1, 'bajo carga': 1,
  'estrategia': 1, 'evalua(r|cion)?': 1,
};

const SYMPTOM = [
  'randomly', 'sometimes', 'only (happens|fails|in)', 'inconsisten\\w+', 'falls? over', 'crash\\w*', 'slow\\w*',
  'hangs?', 'freez\\w+', 'corrupt\\w*', 'leak\\w*', 'at the same time', 'rps', 'throughput', 'latency', 'p9\\d',
  'timeouts?', "other users'?", 'wrong (data|user|totals?|results?)', 'after deploys?',
  'double (charg\\w*|count\\w*|process\\w*|book\\w*)', 'keeps? (climbing|growing|increasing)', 'worse than',
  'a veces', 'aleatoriamente|al azar|de forma aleatoria', 'solo (pasa|falla|ocurre|en)', 'se caen?',
  'se cuelga|cuelgues?', 'se bloquea', 'congela\\w*', 'lentitud|muy lent[oa]|va lent[oa]', 'fugas?',
  'al mismo tiempo', 'latencia', 'tiempos? de espera', '(datos|totales|resultados|importes|calculos) (incorrectos|erroneos|mal)',
  'despues del? (despliegue|desplegar|deploy)', '(doble|duplicad\\w+) (cobro|cargo|factura\\w*)|(cobros?|cargos?|facturas?) (dobles|duplicad\\w+)',
  'sigue (creciendo|subiendo|aumentando)', 'peor que',
];

const FAST = [
  'renam\\w+', 'typos?', 'format\\w*', 'lint\\w*', 'indent\\w*', 'add (a )?comments?', 'what is', "what's", 'whats',
  'what are', 'what does', 'list', 'show me', 'where is', 'find (all|the file|where|usages|references)', 'delete',
  'remove (the )?unused', 'change the \\w+ (color|colour|text|label|padding|margin|size)', 'grep',
  'git (status|log|diff|add|commit|push|stash)', 'commit message', 'convert', 'translate', 'summari[sz]\\w*',
  'tl;?dr', 'extract', 'count', 'explain (this|the|what)', 'which (line|file|one)', 'quick\\w*', 'simple',
  'one liner', 'bump', 'install', 'proofread', 'spell\\w*', 'sort', 'capitali[sz]e',
  'renombr\\w+|cambia(r)? el nombre', 'erratas?|faltas? de ortografia', 'da formato|dale formato',
  'sangria', '(anade|agrega|pon)( un)? comentarios?', 'que es', 'que son', 'que significa', 'que hace',
  'lista\\w*', 'muestra(me)?|ensename', 'donde (esta|estan)',
  '(busca|encuentra)( todas?| todos?| el archivo| el fichero| donde| los usos| las referencias)', 'borra\\w*|elimina\\w*',
  'cambia el (color|texto|tamano|margen|titulo)', 'mensaje de commit',
  'convierte\\w*|pasa(lo|la|r)? a (pdf|excel|csv|json|tabla|markdown|word)', 'traduc\\w+', 'resum\\w+',
  'extra(e|er|eme|igas|ccion)', 'cuantos|cuantas', 'explica(me)? (esto|este|esta|que|el|la|lo)',
  '(que|cual) (linea|archivo|fichero)', 'rapid\\w+', 'sencill\\w+', 'instala\\w*',
  '(corrige|revisa) (la )?ortografia', 'ordena\\w*', 'mayusculas?', '(actualiza|sube) la version',
];

const compile = (p) => new RegExp(`\\b(?:${p})\\b`);
const DEEP_RE = Object.entries(DEEP).map(([p, w]) => [compile(p), w]);
const SYMPTOM_RE = SYMPTOM.map(compile);
const FAST_RE = FAST.map(compile);

const SCOPE =
  /\b(all|every|entire|whole|everything|across|todos|todas|cada|entero|entera|en todo)\b|\bin \/?[\w-]+\/|\b\w+(components|files|endpoints|modules|services|pages|routes)\b|\b(components|files|endpoints|modules|services|pages|routes|archivos|ficheros|modulos|servicios|paginas|rutas)\b/;
const CONCEPT_Q =
  /^(what (is|are)|what's|explain|define|difference between|how does .{0,60} work|que (es|son|significa)|explica(me)?|(cual es la )?diferencia entre|como funciona)\b/;
const NEGATION_EN = /\b(don'?t|do not|no need to|without|not(?! sure)|never|avoid)\b(\s+\w+){1,3}/g;
const NEGATION_ES = /\b(sin|nunca|evita(r|ndo)?|no hace falta|no hay que|no quiero que|no (?:(?:lo|la|los|las|le|les|me|te|nos) )?\w+(?:es|as))\b(\s+\w+){0,3}/g;
const CUE =
  /\b(this|these|below|following|above|attached|here is|here are|here's|my notes|the (text|doc|log|file|output|article|email)|este|esta|estos|estas|esto|siguiente|abajo|arriba|adjunt[oa]s?|aqui (esta|estan|tienes|va|van)|mis notas|el (texto|documento|log|archivo|fichero|correo|email|contrato|informe)|la (factura|tabla|salida))\b/;
const DATA_LINE = new RegExp(
  [
    '^\\s*(\\d{4}-\\d\\d-\\d\\d|\\d\\d:\\d\\d(:\\d\\d)?|\\[\\d|at \\S+\\(|File "|Traceback|#\\d+ |\\$ |> |\\{|\\}|\\[|\\]|<\\/?\\w|"[\\w-]+"\\s*:|(import|from|def|class|function|const|let|var|public|private|return|if|for|while)\\b)',
    '[;{}]\\s*$', '=>', '==', '\\(\\);', '^\\s*\\|.{0,400}\\|\\s*$', '^\\s{4,}\\S', '^\\t',
    '^[^,\\s]{0,40}(,[^,]{0,40}){2,}$', '^(From|To|Subject|Date|Cc|De|Para|Asunto|Fecha|CC):\\s',
    '\\d+[.,]\\d+\\s*(€|eur|kwh|kw|mwh)\\b', '^\\s*[^:]{1,40}:\\s*-?[\\d.,]+\\s*(€|%|kwh|kw|eur)?\\s*$',
  ].join('|'),
  'i',
);
const LOOKUP = /^(list|show|find|where|what|which|git|grep|count|lista|muestra|busca|encuentra|donde|que|cual|cuantos|cuantas|cuenta)\b/;
const FOLLOWUP =
  /^(y(es|eah|ep)?|ok(ay)?|sure|go( ahead)?|do it|continue|proceed|next|try again|again|same (for|with|thing)|now (do|the|apply)|and (also|then)|keep going|looks good|lgtm|perfect|vale|dale|venga|adelante|hazlo|sigue|continua|siguiente|otra vez|de nuevo|lo mismo (para|con)|ahora (haz|el|la|aplica)|perfecto|genial|correcto|de acuerdo|claro|procede|y (tambien|luego))\b|^si\s*[,.!]*\s*(adelante|dale|hazlo|vale|claro|por favor|porfa)?\s*[.!]*$/;
export const SYSTEM_PROMPT =
  /^\s*<(task-notification|command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|user-memory-input|system-reminder)>/;
const OVERRIDES = [
  [/^!(fast|rapido)\b/, 'fast'],
  [/^!(std|normal|estandar)\b/, 'standard'],
  [/^!(deep|profundo)\b/, 'deep'],
  [/^!(max|maximo)\b/, 'max'],
  [/^!(frontier|frontera|fable|top)\b/, 'frontier'],
  [/^!(off|noroute|sin)\b/, 'none'],
];

const MAX_ANALYZE = 8000; // instructions sit at the start and end; bound the work for huge pastes
const LONG_LINE = 600; // a single line longer than this is pasted material after its lead-in

export function normalize(text) {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

// Anchored patterns (lookups, follow-ups, concept questions) must see past Spanish ¿ ¡ and quotes.
const lead = (text) => text.trim().replace(/^[¿¡"'«(\s]+/, '');

const hits = (res, text) => res.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
const weight = (pairs, text) => pairs.reduce((n, [re, w]) => n + (re.test(text) ? w : 0), 0);

function separatePayload(prompt) {
  let payload = 0;
  let text = prompt;
  if (text.length > 4 * MAX_ANALYZE) {
    payload = text.length - MAX_ANALYZE;
    text = text.slice(0, MAX_ANALYZE / 2) + '\n\n' + text.slice(-MAX_ANALYZE / 2);
  }
  text = text.replace(/```[\s\S]*?(```|$)/g, (m) => {
    payload += m.length;
    return '\n';
  });

  // one very long line: "check this config? {...}" or "revisa este contrato: <texto>"
  text = text
    .split('\n')
    .map((line) => {
      if (line.length <= LONG_LINE) return line;
      const cut = line.slice(0, 200).search(/[:?]\s|[{[]/);
      if (cut < 0) return line;
      const keep = /[{[]/.test(line[cut]) ? cut : cut + 1;
      payload += line.length - keep;
      return line.slice(0, keep);
    })
    .join('\n');

  // runs of 3+ code/log/data lines are payload
  const keep = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) payload += run.reduce((n, l) => n + l.length, 0);
    else keep.push(...run);
    run = [];
  };
  for (const line of text.split('\n')) {
    if (line.trim() && DATA_LINE.test(line.slice(0, 400))) run.push(line);
    else {
      flush();
      keep.push(line);
    }
  }
  flush();
  text = keep.join('\n').trim();

  // a pasted document: short instruction head/tail with a cue, long middle
  if (text.length > 700) {
    const paras = text.split(/\n\s*\n/).filter((p) => p.trim());
    const lines = text.split('\n');
    let head = '';
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      if (lines[i].trimEnd().endsWith(':') && lines.slice(0, i + 1).join('\n').length <= 400) {
        head = lines.slice(0, i + 1).join('\n');
        break;
      }
    }
    if (!head && paras.length && paras[0].length <= 400) head = paras[0];
    let tail = paras.length > 1 && paras[paras.length - 1].length <= 400 ? paras[paras.length - 1] : '';
    const last = lines[lines.length - 1] || '';
    if (!tail && last.length <= 300 && last.trimEnd().endsWith('?')) tail = last;
    const instr = `${head}\n${tail}`.trim();
    const il = normalize(instr);
    if (instr && (CUE.test(il) || tail.includes('?') || hits(FAST_RE, il) > 0)) {
      payload += text.length - instr.length;
      text = instr;
    }
  }
  return { text, payload };
}

/**
 * @returns {{tier: string, score: number|null, via: string, payload: number}}
 * tier is one of TIERS, or "none" when the user opted out with !off.
 */
export function classify(prompt, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const head = normalize(prompt.trim());
  for (const [re, tier] of OVERRIDES) if (re.test(head)) return { tier, score: null, via: 'override', payload: 0 };

  let { text: instr, payload } = separatePayload(prompt.trim());
  if (instr.length <= 80 && FOLLOWUP.test(lead(normalize(instr)))) {
    // "yes go ahead" after a plan means: do it here, where the context lives
    return { tier: 'standard', score: null, via: 'followup', payload };
  }
  if (instr.length > MAX_ANALYZE) {
    payload += instr.length - MAX_ANALYZE;
    instr = instr.slice(0, MAX_ANALYZE / 2) + '\n' + instr.slice(-MAX_ANALYZE / 2);
  }
  const low = normalize(instr).replace(NEGATION_EN, ' ').replace(NEGATION_ES, ' ');
  const n = instr.length;

  const deep = weight(DEEP_RE, low);
  const fast = hits(FAST_RE, low);
  const symptoms = hits(SYMPTOM_RE, low);
  let score = deep + 2 * symptoms - fast;
  score += (n > 600 ? 1 : 0) + (n > 1500 ? 1 : 0) + (n > 3000 ? 1 : 0);
  if ((instr.match(/^\s*(?:\d+[.)]|[-*•])\s/gm) || []).length >= 4) score += 1;
  const files = new Set(low.match(/[\w/]+\.(?:py|ts|tsx|js|jsx|mjs|cs|go|rs|java|sql|ya?ml|xlsx|csv|docx|pdf)\b/g) || []);
  if (files.size >= 3) score += 1;

  let tier;
  if (score >= t.max_score) tier = 'max';
  else if (score >= t.deep_score) tier = 'deep';
  else if (fast > 0 && deep === 0 && symptoms === 0 && n <= t.fast_max_chars && (!SCOPE.test(low) || LOOKUP.test(lead(low))))
    tier = 'fast'; // strict: Haiku only on clear, small, lookup-style work
  else tier = 'standard';

  if (CONCEPT_Q.test(lead(low)) && n <= 250 && (tier === 'deep' || tier === 'max')) tier = 'standard'; // explaining a hard topic is not hard work
  if (payload > 0 && tier === 'fast') tier = 'standard'; // the context lives in the prompt; don't delegate it
  return { tier, score, via: 'heuristic', payload };
}
