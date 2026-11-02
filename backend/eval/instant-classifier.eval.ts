// Live evaluation of the instant classifier (issue #16). Not part of `npm test`:
// it calls Cloudflare Workers AI with the account in .env and spends a few neurons.
//   node --env-file=.env --import tsx backend/eval/instant-classifier.eval.ts [model...]
// Prints a per-model summary and one line per draft. Drafts are fixed and synthetic.
import type { InstantClassification } from '@fairbuy/core';
import { InstantClassifier } from '../src/instant-classifier';
import { settings, type Settings } from '../src/settings';

interface Case {
  draft: string;
  /** Acceptable words for the category value; null means no category should be returned. */
  category: string[] | null;
  budget?: { amount: number; currency: string | null; hard?: boolean };
  condition?: 'new' | 'used' | 'refurbished';
  /** Each entry lists alternative words, one of which must appear in some requirement label. */
  requirements?: string[][];
  clarification?: boolean;
}

export const CASES: Case[] = [
  { draft: 'A used laptop for coding, at least 16 GB RAM and 512 GB SSD, max EUR 800', category: ['laptop'], budget: { amount: 800, currency: 'EUR', hard: true }, condition: 'used', requirements: [['16'], ['512']] },
  { draft: 'Cerco un portatile ricondizionato per programmare, almeno 16 GB di RAM, massimo 700 €', category: ['portatile', 'laptop', 'notebook'], budget: { amount: 700, currency: 'EUR', hard: true }, condition: 'refurbished', requirements: [['16']] },
  { draft: 'Ich suche eine leise Waschmaschine, maximal 60 cm breit, bis 600 CHF', category: ['waschmaschine', 'washing'], budget: { amount: 600, currency: 'CHF', hard: true }, requirements: [['60'], ['leise', 'quiet']] },
  { draft: 'Lavatrice da 8 kg, larghezza massima 60 cm, circa 500 euro', category: ['lavatrice', 'washing'], budget: { amount: 500, currency: 'EUR', hard: false }, requirements: [['8'], ['60']] },
  { draft: 'Omega Speedmaster Professional 310.30.42.50.01.001, new, under CHF 8000', category: ['watch', 'speedmaster', 'omega', 'chronograph'], budget: { amount: 8000, currency: 'CHF', hard: true }, condition: 'new', requirements: [['310.30', 'speedmaster', 'professional']] },
  { draft: "Montre automatique Seiko Presage d'occasion, environ 400 €", category: ['montre', 'watch', 'seiko', 'presage'], budget: { amount: 400, currency: 'EUR', hard: false }, condition: 'used', requirements: [['automatique', 'automatic']] },
  { draft: 'Zapatillas de running para maratón, talla 42, alrededor de 120 euros', category: ['zapatillas', 'shoes', 'running', 'sneakers'], budget: { amount: 120, currency: 'EUR', hard: false }, requirements: [['42']] },
  { draft: 'Bici da corsa in carbonio, taglia 54, fino a 1500 euro', category: ['bici', 'bike', 'bicycle', 'corsa'], budget: { amount: 1500, currency: 'EUR', hard: true }, requirements: [['carbonio', 'carbon'], ['54']] },
  { draft: 'Smartphone with at least 128 GB storage and a good camera, under 500 GBP', category: ['smartphone', 'phone'], budget: { amount: 500, currency: 'GBP', hard: true }, requirements: [['128'], ['camera']] },
  { draft: "I don't want a MacBook, I need a Windows laptop", category: ['laptop'], requirements: [['windows']] },
  { draft: 'Not a laptop: a tablet for reading, 10 inch screen, budget $300', category: ['tablet'], budget: { amount: 300, currency: null }, requirements: [['10']] },
  { draft: 'Either a Dyson V15 or a Shark cordless vacuum, max 450 EUR', category: ['vacuum', 'aspirapolvere'], budget: { amount: 450, currency: 'EUR', hard: true }, requirements: [['cordless']] },
  { draft: 'baby', category: null, clarification: true },
  { draft: 'garden', category: null, clarification: true },
  { draft: 'something for my kitchen', category: null, clarification: true },
  { draft: 'laptop', category: ['laptop'] },
];

const words = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const mentions = (text: string, options: string[]) => options.some(option => words(text).includes(words(option)));

interface Score { checks: number; passed: number; invented: number; dropped: number; failures: number; ms: number[] }

function score(result: InstantClassification, raw: InstantClassification | null, expected: Case, issues: string[]) {
  let checks = 0, passed = 0, invented = 0;
  const check = (ok: boolean, label: string) => { checks++; if (ok) passed++; else issues.push(label); };
  if (expected.category) check(!!result.category && mentions(result.category.value, expected.category), `category ${result.category?.value ?? 'missing'}`);
  else if (result.category) { invented++; issues.push(`unexpected category ${result.category.value}`); }
  if (expected.budget) {
    check(result.budget?.amount === expected.budget.amount, `budget ${result.budget?.amount ?? 'missing'}`);
    check((result.budget?.currency ?? null) === expected.budget.currency, `currency ${result.budget?.currency ?? 'none'}`);
    if (expected.budget.hard !== undefined && result.budget) check(result.budget.hard === expected.budget.hard, `budget ${result.budget.hard ? 'firm' : 'flexible'}`);
  } else if (result.budget) { invented++; issues.push(`unexpected budget ${result.budget.amount}`); }
  if (expected.condition) check(result.condition?.value === expected.condition, `condition ${result.condition?.value ?? 'missing'}`);
  else if (result.condition) { invented++; issues.push(`unexpected condition ${result.condition.value}`); }
  for (const options of expected.requirements ?? []) check(result.requirements.some(r => mentions(r.label, options)), `requirement ${options[0]} missing`);
  if (expected.clarification) check(!!result.clarification, 'clarification missing');
  // Hints the model returned that grounding removed.
  const dropped = raw ? (['category', 'budget', 'condition'] as const).filter(key => raw[key] && !result[key]).length + raw.requirements.length - result.requirements.length : 0;
  if (dropped) issues.push(`${dropped} dropped by grounding`);
  return { checks, passed, invented, dropped };
}

async function evaluate(base: Settings, model: Settings['INSTANT_CLASSIFIER_MODEL']) {
  let raw: InstantClassification | null = null;
  // Capture the provider's answer before grounding, to count what grounding drops.
  const capture: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    try {
      const data = await response.clone().json() as { result?: { response?: unknown } };
      const value = data.result?.response;
      raw = (typeof value === 'string' ? JSON.parse(value) : value) as InstantClassification;
    } catch { raw = null; }
    return response;
  };
  const classifier = new InstantClassifier({ ...base, INSTANT_CLASSIFIER_MODEL: model }, capture);
  const total: Score = { checks: 0, passed: 0, invented: 0, dropped: 0, failures: 0, ms: [] };
  const lines: string[] = [];
  for (const [index, expected] of CASES.entries()) {
    const issues: string[] = [];
    raw = null;
    const started = Date.now();
    try {
      const result = await classifier.classify(`eval-${index}`, expected.draft);
      total.ms.push(Date.now() - started);
      const s = score(result, raw, expected, issues);
      total.checks += s.checks; total.passed += s.passed; total.invented += s.invented; total.dropped += s.dropped;
    } catch (error) {
      total.failures++;
      issues.push(`failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    lines.push(`  ${issues.length ? '✗' : '✓'} ${expected.draft}${issues.length ? `\n      ${issues.join('; ')}` : ''}`);
    if (issues.length && process.env.EVAL_VERBOSE) lines.push(`      raw: ${JSON.stringify(raw)}`);
  }
  const ms = [...total.ms].sort((a, b) => a - b);
  console.log(`\n${model}`);
  console.log(`  checks passed ${total.passed}/${total.checks} (${Math.round(100 * total.passed / Math.max(1, total.checks))}%), invented hints ${total.invented}, dropped by grounding ${total.dropped}, failed calls ${total.failures}, median ${ms[Math.floor(ms.length / 2)] ?? '-'} ms`);
  console.log(lines.join('\n'));
}

const base = settings({ ...process.env, NODE_ENV: 'test', FAIRBUY_MODE: 'live', INSTANT_CLASSIFIER_PROVIDER: 'cloudflare' });
const models = (process.argv.slice(2).length ? process.argv.slice(2) : ['@cf/meta/llama-3.1-8b-instruct-fp8-fast', '@cf/meta/llama-3.2-3b-instruct']) as Settings['INSTANT_CLASSIFIER_MODEL'][];
for (const model of models) await evaluate(base, model);
