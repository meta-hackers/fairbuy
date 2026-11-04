import type { AIProvider, ConversationResult, DiscoveryActivityProgress, DiscoveryProgress, SellerSearchProgress, SellerSearchResult } from './provider';
import { productId } from './provider';
import { CurrencySchema, type ChatMessage, type DiscoveryContext, type Product, type ShoppingConfig } from '@fairbuy/core';

// An explicit, offline scripted preview, NEVER an automatic fallback for live AI.
export class DemoAIProvider implements AIProvider {
  ensureConfigured() {}
  async converse(phase: 'ask' | 'configure', messages: ChatMessage[], current: ShoppingConfig): Promise<ConversationResult> {
    const config = structuredClone(current);
    const users = messages.filter(m => m.role === 'user');
    const text = users.map(m => m.content).join(' ');
    config.category = 'laptop'; config.purpose = users[0]?.content.slice(0, 500) ?? 'Everyday development';
    if (/italy|italia|milan/i.test(text)) { if (config.country !== 'IT') config.city = null; config.country = 'IT'; config.currency = 'EUR'; }
    if (/switzerland|zurich|swiss/i.test(text)) { if (config.country !== 'CH') config.city = null; config.country = 'CH'; config.currency = 'CHF'; }
    // The scripted preview still honours an explicit currency code in the latest
    // message so the location panel can mirror the same session config as live mode.
    const latest = users.at(-1)?.content ?? '';
    const requested = latest.match(/\b[A-Z]{3}\b/gi)?.reverse().map(code => code.toUpperCase())
      .find(code => CurrencySchema.safeParse(code).success);
    if (requested) config.currency = CurrencySchema.parse(requested);
    const budget = text.match(/(?:€|EUR|CHF|budget|max|under)\s*(\d{2,5})/i) ?? text.match(/(\d{2,5})\s*(?:€|EUR|CHF)/i);
    if (budget) config.budgetMax = Number(budget[1]);
    if (!config.requirements.length) config.requirements = [{ label: 'At least 16 GB RAM', hard: false, attribute: 'ramGb', op: '>=', value: 16, unit: 'GB' }];
    return {
      config, ready: !!config.country, missing: config.country ? [] : ['Country'],
      reply: phase === 'configure' ? 'Scripted preview: your manual settings are preserved. In live mode a smaller AI model incorporates this additional requirement.'
        : config.country ? 'Your example brief is ready. Review the budget and requirements in Configure, then explore the fictional laptop catalog.'
        : 'This is a scripted preview with fictional laptops, not a live AI. In which country will you shop? Try “Italy, budget €700”.',
    };
  }
  async learn(_context: DiscoveryContext, reason: string) {
    return { summary: 'Feedback added to the fresh search.', requirements: [{ label: reason.slice(0, 300), hard: false, attribute: null, op: null, value: null, unit: null }] };
  }
  async discover(context: DiscoveryContext, onProgress?: DiscoveryProgress, onActivity?: DiscoveryActivityProgress) {
    await onActivity?.('Comparing the fictional preview catalog with your requirements. No live websites are searched.');
    const names = ['Aster 14', 'Kite Studio 15', 'Nori Air 13', 'Vale Pro 14', 'Moss Book 14', 'Fern Studio 14'];
    const discarded = new Set(context.discardedProducts.map(p => p.id));
    const products: Product[] = names.map((name, i) => ({
      id: productId(name), name, summary: ['A balanced refurbished notebook for everyday work.', 'More memory and a larger screen, with extra weight.', 'A small, light notebook with less memory.', 'A premium notebook with room to grow.', 'A compact notebook with a mid-range price.', 'An everyday notebook with a little more storage.'][i],
      why: i === 0 ? 'Its stated 16 GB RAM aligns with the example preference, with a complete fictional final price.' : 'An alternative trade-off in the synthetic catalog. No live recommendation is implied.',
      tradeoffs: [i === 2 ? 'Only 8 GB RAM; below the example preference.' : 'Battery health is unknown; verify it with the seller.'],
      imageUrl: null,
      offers: [0, 1].map(seller => {
        const evidence = [{ sourceType: 'user_input' as const, ref: 'Synthetic fixture — invented for offline preview', at: '2026-01-01T00:00:00.000Z' }];
        return {
          schemaVersion: 1 as const, id: `demo-${i}-${seller}`, category: 'laptop', mode: 'fixture' as const, provenanceUrl: '',
          fetchedAt: '2026-01-01T00:00:00.000Z', title: name, seller: seller ? 'Bright Parcel (fictional)' : 'Lantern Lane (fictional)', availability: 'available' as const,
          condition: { status: 'seller_claim' as const, value: 'refurbished' as const, evidence },
          price: { currency: context.config.currency, amountCents: [59000, 67000, 48000, 82000, 54000, 62000][i] + seller * 1800 },
          attributes: { ramGb: { status: 'seller_claim' as const, value: { kind: 'number' as const, value: [16, 32, 8, 32, 16, 16][i], unit: 'GB' }, evidence } },
          missing: ['Battery health', 'Warranty and returns'], evidence,
        };
      }),
    })).filter(p => !discarded.has(p.id));
    const summary = `Synthetic catalog, not current offers. Fresh discovery session with ${context.previousProducts.length} previously found products and ${context.feedback.length} feedback entries.`;
    for (let i = 0; i < products.length; i++) await onProgress?.({ products: products.slice(0, i + 1), sources: [], summary });
    return { products, sources: [], summary };
  }
  async findSellers(_context: DiscoveryContext, product: Product, onProgress?: SellerSearchProgress, onActivity?: DiscoveryActivityProgress) {
    await onActivity?.('Checking the fictional preview catalog for other sellers of the same product. No live websites are searched.');
    // The scripted catalog deliberately has no extra sellers, so the preview
    // never invents an offer just to fill the spinner slot.
    const result: SellerSearchResult = { offers: [], sources: [], summary: `No additional fictional sellers of ${product.name} are in the scripted preview.` };
    await onProgress?.(result);
    return result;
  }
}
