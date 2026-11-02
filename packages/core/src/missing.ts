// Answers "why isn't this product here?" from stored round data only (issue #23).
// No model is asked: every sentence comes from a recorded reason or count.
import { DROP_REASONS, activeProducts, effectiveConfig, latestRound, type ShoppingSession } from './shopping';

export type MissingCause = 'shown' | 'discarded' | 'excluded' | 'dropped' | 'mentioned' | 'not_retrieved' | 'unknown';
export interface MissingExplanation {
  query: string; cause: MissingCause; product: string | null;
  summary: string; reasons: string[]; nextSteps: string[]; searched: string;
}
export interface MissingQuestion extends MissingExplanation { at: string }
/** Questions kept per round, newest last. */
export const MAX_MISSING_QUESTIONS = 20;

const STOPWORDS = new Set(['the', 'a', 'an', 'for', 'of', 'with', 'and', 'or', 'il', 'lo', 'la', 'un', 'una', 'di', 'da', 'per', 'con', 'der', 'die', 'das', 'ein', 'eine', 'le', 'les', 'des', 'du', 'el', 'los', 'las', 'de', 'y']);
const words = (text: string) => (text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter(word => word.length > 1 && !STOPWORDS.has(word));
const digits = (text: string) => text.replace(/\D/g, '');

/**
 * Whether `text` names the product the user asked about: most of the query's words,
 * or its reference number (e.g. 310.30.42.50.01.001) with punctuation ignored.
 */
export function mentionsProduct(query: string, text: string): boolean {
  const wanted = words(query);
  if (!wanted.length) return false;
  const reference = digits(query);
  if (reference.length >= 5 && digits(text).includes(reference)) return true;
  const have = new Set(words(text));
  const found = wanted.filter(word => have.has(word)).length;
  return found >= Math.min(2, wanted.length) && found / wanted.length >= 0.6;
}

function stepsForExclusion(reasons: string[]): string[] {
  const steps = new Set<string>();
  for (const reason of reasons) {
    if (/budget/i.test(reason)) steps.add('Raise the budget or make it flexible in Configure.');
    else if (/Different currency/.test(reason)) steps.add('Switch the currency in Configure to the one this seller uses.');
    else if (/^Seller serves/.test(reason)) steps.add('Check the shopping country in Configure: sellers that only serve other countries are excluded.');
    else if (/Sold out/.test(reason)) steps.add('Refresh the search later: it may be back in stock.');
    else if (/is excluded by your requirements/.test(reason)) steps.add('Remove the brand exclusion in Configure.');
    else steps.add('Turn the failing must-have into a preference in Configure.');
  }
  return [...steps];
}

export function explainMissing(session: ShoppingSession, query: string): MissingExplanation {
  const round = latestRound(session);
  const answer = (cause: MissingCause, product: string | null, summary: string, reasons: string[], nextSteps: string[], searched = '') =>
    ({ query, cause, product, summary, reasons, nextSteps, searched });
  if (!round) return answer('unknown', null, 'No search has run yet, so there is nothing to check.', [], ['Start a search from Configure.']);
  const config = effectiveConfig(round.context);
  const pages = round.sources.length;
  // The scripted demo checks a synthetic catalog, not web pages.
  const demo = round.products.some(p => p.offers.some(o => o.mode === 'fixture'));
  const searched = `${demo ? 'Checked the synthetic demo catalog' : `Searched ${pages} ${pages === 1 ? 'page' : 'pages'}`} for ${config.category ?? 'products'}${config.country ? ` in ${config.country}` : ''}, prices in ${config.currency}${config.budgetMax !== null ? `, budget ${config.budgetHard ? 'up to' : 'around'} ${config.budgetMax}` : ''}.`;
  if (round.status === 'queued' || round.status === 'running') return answer('unknown', null, 'The search is still running. Ask again when it finishes.', [], [], searched);

  const ranked = new Set(round.ranking?.ranked.map(r => r.offerId) ?? []);
  const shown = activeProducts(session).find(p => mentionsProduct(query, p.name) && p.offers.some(o => ranked.has(o.id)));
  if (shown) return answer('shown', shown.name, `${shown.name} is among your current results.`, [], [], searched);

  const removed = session.feedback.find(f => f.productName && mentionsProduct(query, f.productName))
    ?? round.context.discardedProducts.map(p => ({ productName: p.name, reason: '' })).find(p => mentionsProduct(query, p.productName));
  if (removed) {
    return answer('discarded', removed.productName, `You removed ${removed.productName} earlier with feedback.`,
      removed.reason ? [`Your feedback: “${removed.reason}”`] : [], ['Undo that feedback in “What we’ve learned” to bring it back.'], searched);
  }

  const found = round.products.find(p => mentionsProduct(query, p.name));
  if (found) {
    const reasons = [...new Set((round.ranking?.excluded ?? []).filter(e => found.offers.some(o => o.id === e.offerId)).flatMap(e => e.reasons))];
    return answer('excluded', found.name, `${found.name} was found, but every offer for it was ruled out by your brief.`, reasons, stepsForExclusion(reasons), searched);
  }

  const dropped = (round.dropped ?? []).filter(d => mentionsProduct(query, d.product));
  if (dropped.length) {
    const reasons = [...new Set(dropped.map(d => `${d.seller ?? d.host ?? 'An offer'}: ${DROP_REASONS[d.reason]}`))];
    const steps = new Set(dropped.map(d => d.reason === 'not_a_seller'
      ? 'Only specification or review pages listed it. Add a seller you trust as a preference and refresh the search.'
      : d.reason === 'previously_discarded' ? 'Undo that feedback in “What we’ve learned” to bring it back.'
      : 'Refresh the search: the page it came from could not be verified this time.'));
    return answer('dropped', dropped[0].product, `${dropped[0].product} was found, but no offer for it could be verified.`, reasons, [...steps], searched);
  }

  const page = round.sources.find(s => mentionsProduct(query, `${s.title} ${s.url}`));
  if (page) {
    return answer('mentioned', null, 'A page mentioning it was retrieved, but no seller offer for it could be verified.', [`Retrieved page: ${page.title}`],
      ['Add the exact model name to your brief in Configure and refresh the search.'], searched);
  }
  if (demo) return answer('not_retrieved', null, 'It is not in the synthetic demo catalog.', [], ['Try the live app to search the web for it.'], searched);
  if (!pages) {
    return answer('unknown', null, 'This search returned no pages, so we cannot tell whether it is available for your brief.', [],
      ['Refresh the search, or broaden the category, budget or must-haves in Configure.'], searched);
  }
  return answer('not_retrieved', null, `It did not appear on any of the ${pages} pages this search returned: it was not found, rather than rejected.`, [],
    ['Add the exact model name to your brief in Configure and refresh the search.', 'If it is sold elsewhere, check the shopping country and currency.'], searched);
}
