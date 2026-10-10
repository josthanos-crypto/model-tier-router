import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, normalize } from '../scripts/lib/classify.mjs';

const cases = {
  fast: [
    'rename getUser to fetchUser',
    'what does this regex do',
    'git status',
    'renombra la variable total a importeTotal',
    '¿qué es la potencia contratada?',
    'traduce este párrafo al inglés',
    'resume este texto',
    'extrae los datos de la factura',
    'formatea este JSON',
    '¿dónde está el fichero de configuración?',
    '¿Cuántos ficheros .mjs hay en la carpeta scripts/lib?',
  ],
  standard: [
    'add pagination to /orders with tests',
    'redacta un correo para el cliente explicándole la nueva tarifa',
    'si el cliente tiene 6 periodos, cuál le conviene',
    'no refactorices nada, solo añade un test para calcularTotal',
    'crea una tabla con las tarifas de las tres comercializadoras',
    'optimiza la consulta',
  ],
  deep: [
    'not sure how to structure billing',
    'no sé cómo estructurar la facturación de los clientes',
    'por qué no funciona el login',
    'el cálculo da importes incorrectos solo en algunos clientes',
    'Haz un estudio de ahorro completo para un cliente con varios suministros comparando 6 comercializadoras',
  ],
  max: [
    'find the root cause of the deadlock',
    'averigua por qué fallan los cobros duplicados a veces',
    'diseña la arquitectura del sistema de comparativas desde cero',
  ],
};

for (const [tier, prompts] of Object.entries(cases)) {
  for (const p of prompts) {
    test(`${tier}: ${p}`, () => assert.equal(classify(p).tier, tier));
  }
}

test('overrides work with and without accents, in both languages', () => {
  assert.deepEqual(classify('!rápido dime la hora').tier, 'fast');
  assert.equal(classify('!fast explain the architecture of this distributed system').tier, 'fast');
  assert.equal(classify('!estandar diseña la arquitectura').tier, 'standard');
  assert.equal(classify('!profundo renombra esto').tier, 'deep');
  assert.equal(classify('!máximo hola').tier, 'max');
  assert.equal(classify('!fable haz un estudio de mercado').tier, 'frontier');
  assert.equal(classify('!off lo que sea').tier, 'none');
  assert.equal(classify('!fast x').via, 'override');
});

test('frontier is never chosen automatically', () => {
  const huge = 'diseña la arquitectura distribuida desde cero, averigua la causa raíz del interbloqueo y por qué falla a veces '.repeat(20);
  assert.equal(classify(huge).tier, 'max');
});

test('short follow-ups stay in the main session as standard', () => {
  for (const p of ['yes go ahead', 'sí, adelante', 'vale', 'hazlo', 'perfecto', 'continúa', 'si', '¡Adelante!']) {
    const r = classify(p);
    assert.equal(r.tier, 'standard', p);
    assert.equal(r.via, 'followup', p);
  }
});

test('a Spanish "si" that starts a question is not a follow-up', () => {
  assert.equal(classify('si el cliente cambia de tarifa, ¿pierde la permanencia?').via, 'heuristic');
});

test('pasted code is payload and keeps a simple ask off Opus', () => {
  const code = '```js\n' + 'const x = compute(a, b);\n'.repeat(40) + '```';
  const r = classify(`which line has the bug?\n${code}`);
  assert.ok(r.payload > 500);
  assert.equal(r.tier, 'standard');
});

test('a pasted invoice is payload, not complexity', () => {
  const invoice = [
    'Potencia P1: 4,6 kW',
    'Potencia P2: 4,6 kW',
    'Consumo P1: 120,5 kWh',
    'Consumo P2: 98,2 kWh',
    'Consumo P3: 210,7 kWh',
    'Término de potencia: 12,34 €',
    'Término de energía: 45,67 €',
    'Total factura: 72,10 €',
  ].join('\n');
  const r = classify(`Extrae los importes de esta factura:\n${invoice}`);
  assert.ok(r.payload > 100, `payload ${r.payload}`);
  assert.equal(r.tier, 'standard');
});

test('a long pasted document with a short instruction is judged by the instruction', () => {
  const doc = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. '.repeat(30);
  const r = classify(`Resume el siguiente texto:\n\n${doc}\n\nGracias.`);
  assert.ok(r.payload > 1000);
  assert.equal(r.tier, 'standard');
});

test('a long single-line paste is payload, not complexity', () => {
  const json = JSON.stringify({ items: Array.from({ length: 120 }, (_, i) => ({ id: i, name: `item ${i}`, price: i * 1.5 })) });
  const r1 = classify(`can you check this config? ${json}`);
  assert.ok(r1.payload > 4000);
  assert.equal(r1.tier, 'standard');
  const prose = 'El cliente se compromete a mantener el contrato durante doce meses desde la fecha de activación. '.repeat(40);
  const r2 = classify(`revisa este contrato y dime si tiene permanencia: ${prose}`);
  assert.ok(r2.payload > 3000);
  assert.equal(r2.tier, 'standard');
});

test('Spanish stems do not catch English words', () => {
  assert.notEqual(classify('critical production bug: the button label is wrong').tier, 'deep');
});

test('English negation removes the negated work from the score', () => {
  assert.equal(classify("don't refactor anything, just add a log line").tier, 'standard');
});

test('concept questions about hard topics are standard, not deep', () => {
  assert.equal(classify('what is a race condition').tier, 'standard');
  assert.equal(classify('explícame qué es una condición de carrera').tier, 'standard');
  assert.equal(classify('¿Qué es una arquitectura distribuida?').tier, 'standard');
});

test('scope words keep Haiku away from sweeping changes', () => {
  assert.equal(classify('rename every endpoint in the api').tier, 'standard');
  assert.equal(classify('renombra todos los ficheros del proyecto').tier, 'standard');
});

test('long lists and many files raise the score', () => {
  const list = '1. a\n2. b\n3. c\n4. d\n';
  assert.ok(classify(`haz esto:\n${list}`).score > classify('haz esto').score);
  assert.ok(classify('revisa a.py b.py c.py').score > classify('revisa a.py').score);
});

test('thresholds are configurable', () => {
  assert.equal(classify('refactor the pricing module', { deep_score: 2 }).tier, 'deep');
  assert.equal(classify('refactor the pricing module').tier, 'standard');
});

test('huge prompts are bounded and still classified', () => {
  const r = classify('x '.repeat(40_000) + '\nfind the root cause');
  assert.ok(r.payload > 0);
  assert.ok(['deep', 'max', 'standard'].includes(r.tier));
});

test('normalize strips accents and lowercases', () => {
  assert.equal(normalize('Análisis ÑANDÚ'), 'analisis nandu');
});
