import { z } from 'zod';
import type { ShoppingConfig } from './shopping';

/**
 * Curated discovery hints. This is not evidence: it only tells the research
 * model which kinds of sites are worth searching for a category and country.
 * Every offer still has to be grounded in an actual returned search result.
 */
export const SOURCE_VERTICALS = ['computers', 'electronics', 'food_delivery', 'fashion', 'home', 'sports', 'books', 'auto', 'general'] as const;
export type Vertical = (typeof SOURCE_VERTICALS)[number];

export const SOURCE_ROLES = ['seller', 'marketplace', 'spec', 'review', 'comparison'] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

// Seed data, the admin API and the persisted catalog share this validation.
// The seed script validates the whole file before writing any database row.
export const SourceEntrySchema = z.object({
  domain: z.string().trim().min(3).max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i, 'Use a lowercase hostname such as shop.example.ch')
    .transform(value => value.toLowerCase()),
  name: z.string().trim().min(1).max(120),
  roles: z.array(z.enum(SOURCE_ROLES)).min(1).max(SOURCE_ROLES.length)
    .refine(values => new Set(values).size === values.length, 'Roles must be unique'),
  verticals: z.array(z.enum(SOURCE_VERTICALS)).min(1).max(SOURCE_VERTICALS.length)
    .refine(values => new Set(values).size === values.length, 'Verticals must be unique'),
  countries: z.union([
    z.literal('global'),
    z.array(z.string().regex(/^[A-Z]{2}$/, 'Use uppercase ISO two-letter country codes')).min(1).max(60)
      .refine(values => new Set(values).size === values.length, 'Countries must be unique'),
  ]),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  note: z.string().trim().max(300).optional(),
  // Absent means enabled; the flag lets admins hide a source without losing its
  // role history (a disabled spec source is still not an offer URL).
  enabled: z.boolean().optional(),
}).strict();
export type SourceEntry = z.infer<typeof SourceEntrySchema>;

export interface SourceHint {
  domain: string;
  name: string;
  role: SourceRole;
  note?: string;
}

export interface SourcePlan {
  vertical: Vertical;
  /** Domains that can host an offer and its price. */
  sellers: SourceHint[];
  /** Datasheets, specification databases and manufacturer-style references. Never an offer. */
  specs: SourceHint[];
  /** Reviews and price-comparison sites. Useful context, never an offer. */
  references: SourceHint[];
  /** Hosts that must never be used as an offer URL or price source. */
  nonSellerDomains: string[];
}

const MAX_SELLERS = 8;
const MAX_SPECS = 3;
const MAX_REFERENCES = 4;

const VERTICAL_ORDER: Exclude<Vertical, 'general'>[] = ['computers', 'electronics', 'food_delivery', 'fashion', 'home', 'sports', 'books', 'auto'];

const VERTICAL_KEYWORDS: Record<Exclude<Vertical, 'general'>, string[]> = {
  computers: [
    'laptop', 'notebook', 'computer', 'pc', 'desktop', 'workstation', 'macbook', 'thinkpad', 'chromebook',
    'monitor', 'gpu', 'cpu', 'ram', 'ssd', 'keyboard', 'mouse', 'gaming pc', 'ordinateur', 'portatile',
    'rechner', 'pc fisso', 'computer portatile',
  ],
  electronics: [
    'phone', 'smartphone', 'iphone', 'galaxy', 'pixel', 'tv', 'television', 'televisore', 'camera',
    'fotocamera', 'mirrorless', 'dslr', 'headphone', 'cuffie', 'earbuds', 'speaker', 'diffusore',
    'console', 'playstation', 'xbox', 'nintendo', 'tablet', 'ipad', 'smartwatch', 'apple watch',
    'washing machine', 'lavatrice', 'fridge', 'frigorifero', 'dishwasher', 'lavastoviglie', 'fernseher',
    'handy', 'kopfhorer', 'staubsauger', 'aspirapolvere', 'elettrodomestico', 'elettronica', 'electronics',
    'food processor', 'robot da cucina', 'kuchenmaschine',
  ],
  food_delivery: [
    'food delivery', 'food order', 'food', 'restaurant', 'ristorante', 'pizza', 'pizzeria', 'sushi',
    'burger', 'hamburger', 'takeaway', 'take-away', 'takeout', 'menu', 'groceries', 'grocery',
    'supermarket', 'supermercato', 'spesa', 'cibo', 'mangiare', 'consegna', 'essen', 'lieferung',
    'nahrung', 'nourriture', 'livraison', 'repas', 'courses', 'asporto', 'domicilio',
  ],
  fashion: [
    'clothing', 'clothes', 'shoes', 'sneakers', 'jacket', 'dress', 'jeans', 'shirt', 't-shirt',
    'fashion', 'bag', 'handbag', 'watch', 'sunglasses', 'vestiti', 'abbigliamento', 'scarpe',
    'giacca', 'vestito', 'borsa', 'occhiali da sole', 'kleidung', 'schuhe', 'jacke', 'kleid',
    'tasche', 'vêtements', 'chaussures', 'veste', 'robe', 'sac',
  ],
  home: [
    'furniture', 'mobili', 'mobile', 'divano', 'sofa', 'couch', 'bed', 'letto', 'mattress',
    'materasso', 'desk', 'scrivania', 'chair', 'sedia', 'table', 'tavolo', 'lamp', 'lampada',
    'kitchen', 'cucina', 'garden', 'giardino', 'diy', 'fai da te', 'drill', 'trapano', 'bett',
    'stuhl', 'tisch', 'lampe', 'kuche', 'garten', 'meuble', 'canape', 'lit', 'chaise', 'cuisine',
    'jardin', 'bricolage',
  ],
  sports: [
    'bike', 'bicycle', 'bici', 'bicicletta', 'e-bike', 'ebike', 'running', 'corsa', 'fitness',
    'palestra', 'dumbbell', 'manubri', 'tent', 'tenda', 'hiking', 'trekking', 'ski', 'sci',
    'snowboard', 'fahrrad', 'laufschuhe', 'zelt', 'velo', 'course a pied', 'tente',
  ],
  books: ['book', 'libro', 'novel', 'romanzo', 'textbook', 'manuale', 'buch', 'livre'],
  auto: [
    'car', 'auto', 'automobile', 'tire', 'tyre', 'pneumatici', 'pneumatico', 'motorcycle', 'moto',
    'scooter', 'reifen', 'voiture', 'pneu',
  ],
};

function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Light plural folding for English and the Latin-script keywords in the catalog. */
function stem(token: string): string {
  return token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
}

export function classifyVertical(config: Pick<ShoppingConfig, 'category' | 'purpose'>): Vertical {
  const text = normalize(`${config.category ?? ''} ${config.purpose ?? ''}`);
  if (!text) return 'general';
  const tokens = new Set(text.split(' ').filter(Boolean));
  const stems = new Set([...tokens].map(stem));
  let best: { vertical: Vertical; score: number } = { vertical: 'general', score: 0 };
  for (const vertical of VERTICAL_ORDER) {
    let score = 0;
    for (const keyword of VERTICAL_KEYWORDS[vertical]) {
      if (keyword.includes(' ')) {
        if (` ${text} `.includes(` ${keyword} `)) score += 2;
      } else if (tokens.has(keyword) || stems.has(keyword) || stems.has(stem(keyword))) {
        score += 1;
      }
    }
    if (score > best.score) best = { vertical, score };
  }
  return best.vertical;
}

function countryMatches(source: SourceEntry, country: string | null): boolean {
  return source.countries === 'global' || (country !== null && source.countries.includes(country));
}

function hint(source: SourceEntry): SourceHint {
  const role = source.roles.find(value => value === 'seller' || value === 'marketplace') ?? source.roles[0];
  return { domain: source.domain, name: source.name, role, ...(source.note ? { note: source.note } : {}) };
}

/**
 * Deterministically selects a small set of seller, specification and reference
 * hints for the brief. The research model still searches freely; the plan is
 * guidance, not evidence and not an allowlist.
 */
export function sourcePlan(config: ShoppingConfig, catalog: SourceEntry[] = []): SourcePlan {
  const vertical = classifyVertical(config);
  const active = catalog.filter(source => source.enabled !== false);
  const matched = active
    .filter(source => source.verticals.includes(vertical) && countryMatches(source, config.country))
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  const sellers = matched.filter(source => source.roles.includes('seller') || source.roles.includes('marketplace'));
  const specs = matched.filter(source => source.roles.includes('spec'));
  const references = matched.filter(source => source.roles.includes('review') || source.roles.includes('comparison'));
  // Role is intrinsic to the domain, not to this brief: a specification or
  // review host must never become an offer URL for any category. A domain is a
  // non-seller only if no catalog entry gives it an offer role. Disabled entries
  // keep their role knowledge, so hiding a datasheet does not make it a shop.
  const rolesByDomain = new Map<string, Set<SourceRole>>();
  for (const source of catalog) {
    rolesByDomain.set(source.domain, new Set([...(rolesByDomain.get(source.domain) ?? []), ...source.roles]));
  }
  return {
    vertical,
    sellers: sellers.slice(0, MAX_SELLERS).map(hint),
    specs: specs.slice(0, MAX_SPECS).map(hint),
    references: references.slice(0, MAX_REFERENCES).map(hint),
    nonSellerDomains: [...rolesByDomain.entries()]
      .filter(([, roles]) => !roles.has('seller') && !roles.has('marketplace'))
      .map(([domain]) => domain),
  };
}

/** Validate a seed file as a whole: every entry must be valid and domains unique. */
export function validateSourceCatalog(entries: SourceEntry[]): SourceEntry[] {
  const parsed = entries.map(entry => SourceEntrySchema.parse(entry));
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (seen.has(entry.domain)) throw new Error(`Duplicate source domain: ${entry.domain}`);
    seen.add(entry.domain);
  }
  return parsed;
}

/** Dot-boundary host match, so `notgalaxus.ch` never matches `galaxus.ch`. */
export function hostInDomains(host: string, domains: string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return domains.some(domain => normalized === domain || normalized.endsWith(`.${domain}`));
}

export function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
}

export function isNonSellerHost(url: string, plan: SourcePlan): boolean {
  const host = hostOf(url);
  return host !== null && hostInDomains(host, plan.nonSellerDomains);
}

export function isPlannedSellerHost(url: string, plan: SourcePlan): boolean {
  const host = hostOf(url);
  return host !== null && hostInDomains(host, plan.sellers.map(source => source.domain));
}
