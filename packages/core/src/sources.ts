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

// The admin API and the persisted overrides share this validation. The built-in
// catalog is not parsed at startup: it is code reviewed with the repository.
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

const PRODUCT_VERTICALS: Vertical[] = ['computers', 'electronics', 'home', 'fashion', 'sports', 'books', 'auto', 'general'];
const MAX_SELLERS = 8;
const MAX_SPECS = 3;
const MAX_REFERENCES = 4;

function entry(
  domain: string,
  name: string,
  role: SourceRole,
  verticals: Vertical[],
  countries: string[] | 'global',
  priority: 1 | 2 | 3,
  note?: string,
): SourceEntry {
  return { domain, name, roles: [role], verticals, countries, priority, ...(note ? { note } : {}) };
}

export const DEFAULT_SOURCE_CATALOG: SourceEntry[] = [
  // General marketplaces and classifieds. They apply to product verticals,
  // but not to food delivery, where the comparison unit is a basket.
  entry('amazon.it', 'Amazon.it', 'marketplace', PRODUCT_VERTICALS, ['IT'], 3),
  entry('amazon.de', 'Amazon.de', 'marketplace', PRODUCT_VERTICALS, ['DE', 'AT'], 3),
  entry('amazon.fr', 'Amazon.fr', 'marketplace', PRODUCT_VERTICALS, ['FR'], 3),
  entry('amazon.co.uk', 'Amazon.co.uk', 'marketplace', PRODUCT_VERTICALS, ['GB'], 3),
  entry('amazon.es', 'Amazon.es', 'marketplace', PRODUCT_VERTICALS, ['ES'], 3),
  entry('amazon.com', 'Amazon.com', 'marketplace', PRODUCT_VERTICALS, ['US'], 3),
  entry('ebay.it', 'eBay.it', 'marketplace', PRODUCT_VERTICALS, ['IT'], 3),
  entry('ebay.de', 'eBay.de', 'marketplace', PRODUCT_VERTICALS, ['DE', 'AT'], 3),
  entry('ebay.fr', 'eBay.fr', 'marketplace', PRODUCT_VERTICALS, ['FR'], 3),
  entry('ebay.co.uk', 'eBay.co.uk', 'marketplace', PRODUCT_VERTICALS, ['GB'], 3),
  entry('ebay.com', 'eBay.com', 'marketplace', PRODUCT_VERTICALS, ['US'], 3),
  entry('ebay.ch', 'eBay.ch', 'marketplace', PRODUCT_VERTICALS, ['CH'], 2),
  entry('ricardo.ch', 'Ricardo', 'marketplace', PRODUCT_VERTICALS, ['CH'], 3, 'Swiss marketplace for new and used goods'),
  entry('tutti.ch', 'Tutti', 'marketplace', PRODUCT_VERTICALS, ['CH'], 2),
  entry('subito.it', 'Subito', 'marketplace', PRODUCT_VERTICALS, ['IT'], 3),
  entry('leboncoin.fr', 'Leboncoin', 'marketplace', PRODUCT_VERTICALS, ['FR'], 3),
  entry('kleinanzeigen.de', 'Kleinanzeigen', 'marketplace', PRODUCT_VERTICALS, ['DE'], 3),
  entry('willhaben.at', 'Willhaben', 'marketplace', PRODUCT_VERTICALS, ['AT'], 2),
  entry('vinted.com', 'Vinted', 'marketplace', ['fashion', 'general'], ['IT', 'DE', 'FR', 'GB', 'US', 'ES'], 2),
  entry('etsy.com', 'Etsy', 'marketplace', PRODUCT_VERTICALS, 'global', 1),
  entry('catawiki.com', 'Catawiki', 'marketplace', PRODUCT_VERTICALS, 'global', 1),
  entry('kaufland.de', 'Kaufland', 'marketplace', PRODUCT_VERTICALS, ['DE'], 2),
  entry('cdiscount.com', 'Cdiscount', 'marketplace', PRODUCT_VERTICALS, ['FR'], 2),
  entry('otto.de', 'Otto', 'marketplace', PRODUCT_VERTICALS, ['DE'], 3),
  entry('argos.co.uk', 'Argos', 'marketplace', PRODUCT_VERTICALS, ['GB'], 3),
  entry('johnlewis.com', 'John Lewis', 'marketplace', PRODUCT_VERTICALS, ['GB'], 3),
  entry('very.co.uk', 'Very', 'marketplace', PRODUCT_VERTICALS, ['GB'], 2),
  entry('walmart.com', 'Walmart', 'marketplace', PRODUCT_VERTICALS, ['US'], 3),
  entry('target.com', 'Target', 'marketplace', PRODUCT_VERTICALS, ['US'], 3),

  // Switzerland: electronics, computers and home.
  entry('digitec.ch', 'Digitec', 'seller', ['computers', 'electronics'], ['CH'], 3),
  entry('galaxus.ch', 'Galaxus', 'seller', ['computers', 'electronics', 'home'], ['CH'], 3),
  entry('brack.ch', 'Brack', 'seller', ['computers', 'electronics'], ['CH'], 2),
  entry('microspot.ch', 'Microspot', 'seller', ['computers', 'electronics'], ['CH'], 2),
  entry('mediamarkt.ch', 'MediaMarkt Schweiz', 'seller', ['computers', 'electronics', 'home'], ['CH'], 2),
  entry('fust.ch', 'Fust', 'seller', ['computers', 'electronics', 'home'], ['CH'], 2),
  entry('interdiscount.ch', 'Interdiscount', 'seller', ['electronics', 'home'], ['CH'], 2),
  entry('wog.ch', 'WOG', 'seller', ['computers'], ['CH'], 2),

  // Italy: electronics, computers and home.
  entry('mediaworld.it', 'MediaWorld', 'seller', ['computers', 'electronics', 'home'], ['IT'], 3),
  entry('unieuro.it', 'Unieuro', 'seller', ['computers', 'electronics', 'home'], ['IT'], 3),
  entry('euronics.it', 'Euronics', 'seller', ['computers', 'electronics', 'home'], ['IT'], 2),
  entry('trony.it', 'Trony', 'seller', ['computers', 'electronics', 'home'], ['IT'], 2),
  entry('monclick.it', 'Monclick', 'seller', ['computers', 'electronics'], ['IT'], 2),
  entry('eprice.it', 'ePrice', 'seller', ['computers', 'electronics'], ['IT'], 2),
  entry('yeppon.it', 'Yeppon', 'seller', ['computers', 'electronics'], ['IT'], 2),

  // Germany, Austria, France, the UK and the US.
  entry('mediamarkt.de', 'MediaMarkt Deutschland', 'seller', ['computers', 'electronics', 'home'], ['DE'], 3),
  entry('saturn.de', 'Saturn', 'seller', ['computers', 'electronics', 'home'], ['DE'], 3),
  entry('notebooksbilliger.de', 'Notebooksbilliger', 'seller', ['computers'], ['DE'], 2),
  entry('alternate.de', 'Alternate', 'seller', ['computers', 'electronics'], ['DE'], 2),
  entry('cyberport.de', 'Cyberport', 'seller', ['computers', 'electronics'], ['DE'], 2),
  entry('mindfactory.de', 'Mindfactory', 'seller', ['computers'], ['DE'], 2),
  entry('caseking.de', 'Caseking', 'seller', ['computers'], ['DE'], 1),
  entry('mediamarkt.at', 'MediaMarkt Österreich', 'seller', ['computers', 'electronics', 'home'], ['AT'], 3),
  entry('fnac.com', 'Fnac', 'seller', ['computers', 'electronics', 'books', 'home'], ['FR'], 3),
  entry('darty.com', 'Darty', 'seller', ['computers', 'electronics', 'home'], ['FR'], 3),
  entry('boulanger.com', 'Boulanger', 'seller', ['computers', 'electronics', 'home'], ['FR'], 3),
  entry('currys.co.uk', 'Currys', 'seller', ['computers', 'electronics', 'home'], ['GB'], 3),
  entry('ao.com', 'AO', 'seller', ['electronics', 'home'], ['GB'], 2),
  entry('bestbuy.com', 'Best Buy', 'seller', ['computers', 'electronics', 'home'], ['US'], 3),
  entry('newegg.com', 'Newegg', 'seller', ['computers', 'electronics'], ['US'], 2),
  entry('bhphotovideo.com', 'B&H Photo Video', 'seller', ['computers', 'electronics'], ['US'], 2),

  // Specification and review references. These can support an attribute but
  // must never become the offer URL or the price source.
  entry('openicecat.com', 'Open Icecat', 'spec', ['computers', 'electronics'], 'global', 3, 'Open product-specification catalog; not a shop'),
  entry('icecat.com', 'Icecat', 'spec', ['computers', 'electronics'], 'global', 2, 'Product-specification catalog; not a shop'),
  entry('gsmarena.com', 'GSMArena', 'spec', ['electronics'], 'global', 2, 'Phone specifications; not a shop'),
  entry('techpowerup.com', 'TechPowerUp', 'spec', ['computers'], 'global', 1, 'GPU/CPU database; not a shop'),
  entry('notebookcheck.net', 'Notebookcheck', 'review', ['computers'], 'global', 2, 'Laptop tests and specifications; not a shop'),
  entry('rtings.com', 'RTINGS', 'review', ['electronics', 'home'], 'global', 2, 'Independent product tests; not a shop'),
  entry('pcmag.com', 'PCMag', 'review', ['computers', 'electronics'], 'global', 1),
  entry('tomshardware.com', 'Tom\'s Hardware', 'review', ['computers'], 'global', 1),
  entry('dxomark.com', 'DXOMARK', 'review', ['electronics'], 'global', 1),

  // Price comparison. Useful to find models and sellers, never an offer.
  entry('toppreise.ch', 'Toppreise', 'comparison', PRODUCT_VERTICALS, ['CH'], 2),
  entry('idealo.de', 'idealo.de', 'comparison', PRODUCT_VERTICALS, ['DE'], 2),
  entry('idealo.it', 'idealo.it', 'comparison', PRODUCT_VERTICALS, ['IT'], 2),
  entry('idealo.fr', 'idealo.fr', 'comparison', PRODUCT_VERTICALS, ['FR'], 2),
  entry('idealo.co.uk', 'idealo.co.uk', 'comparison', PRODUCT_VERTICALS, ['GB'], 2),
  entry('idealo.es', 'idealo.es', 'comparison', PRODUCT_VERTICALS, ['ES'], 2),
  entry('geizhals.de', 'Geizhals', 'comparison', ['computers', 'electronics', 'home'], ['DE'], 2),
  entry('geizhals.at', 'Geizhals.at', 'comparison', ['computers', 'electronics', 'home'], ['AT'], 2),
  entry('trovaprezzi.it', 'Trovaprezzi', 'comparison', PRODUCT_VERTICALS, ['IT'], 2),

  // Food delivery. Menus and fees are location- and basket-specific, so these
  // are discovery hints only; the prompt requires a grounded same-basket basis.
  entry('ubereats.com', 'Uber Eats', 'marketplace', ['food_delivery'], ['CH', 'IT', 'DE', 'FR', 'GB', 'US', 'ES'], 3),
  entry('glovoapp.com', 'Glovo', 'marketplace', ['food_delivery'], ['IT', 'ES', 'FR', 'PT'], 3),
  entry('deliveroo.co.uk', 'Deliveroo UK', 'marketplace', ['food_delivery'], ['GB'], 3),
  entry('deliveroo.it', 'Deliveroo Italia', 'marketplace', ['food_delivery'], ['IT'], 3),
  entry('deliveroo.fr', 'Deliveroo France', 'marketplace', ['food_delivery'], ['FR'], 3),
  entry('deliveroo.ie', 'Deliveroo Ireland', 'marketplace', ['food_delivery'], ['IE'], 2),
  entry('deliveroo.be', 'Deliveroo Belgium', 'marketplace', ['food_delivery'], ['BE'], 2),
  entry('just-eat.co.uk', 'Just Eat UK', 'marketplace', ['food_delivery'], ['GB'], 3),
  entry('just-eat.it', 'Just Eat Italia', 'marketplace', ['food_delivery'], ['IT'], 3),
  entry('just-eat.fr', 'Just Eat France', 'marketplace', ['food_delivery'], ['FR'], 2),
  entry('lieferando.de', 'Lieferando', 'marketplace', ['food_delivery'], ['DE'], 3),
  entry('foodora.it', 'foodora', 'marketplace', ['food_delivery'], ['IT'], 2),
  entry('doordash.com', 'DoorDash', 'marketplace', ['food_delivery'], ['US'], 3),
  entry('grubhub.com', 'Grubhub', 'marketplace', ['food_delivery'], ['US'], 2),
  entry('thefork.com', 'TheFork', 'comparison', ['food_delivery'], ['CH', 'IT', 'FR', 'ES', 'GB', 'US'], 2, 'Restaurant discovery and booking; not a delivery offer'),
  entry('opentable.com', 'OpenTable', 'comparison', ['food_delivery'], ['US', 'GB', 'DE', 'FR', 'IT', 'ES'], 1),

  // Fashion.
  entry('zalando.ch', 'Zalando Schweiz', 'seller', ['fashion'], ['CH'], 3),
  entry('zalando.it', 'Zalando Italia', 'seller', ['fashion'], ['IT'], 3),
  entry('zalando.de', 'Zalando Deutschland', 'seller', ['fashion'], ['DE', 'AT'], 3),
  entry('zalando.fr', 'Zalando France', 'seller', ['fashion'], ['FR'], 3),
  entry('zalando.co.uk', 'Zalando UK', 'seller', ['fashion'], ['GB'], 2),
  entry('asos.com', 'ASOS', 'seller', ['fashion'], ['GB', 'IT', 'DE', 'FR', 'US', 'ES'], 2),
  entry('zara.com', 'Zara', 'seller', ['fashion'], 'global', 2),
  entry('hm.com', 'H&M', 'seller', ['fashion'], 'global', 2),
  entry('uniqlo.com', 'Uniqlo', 'seller', ['fashion'], ['IT', 'FR', 'DE', 'GB', 'US', 'ES'], 2),
  entry('yoox.com', 'YOOX', 'seller', ['fashion'], ['IT', 'DE', 'FR', 'GB', 'US'], 2),
  entry('farfetch.com', 'Farfetch', 'seller', ['fashion'], 'global', 1),

  // Home, DIY and garden.
  entry('ikea.com', 'IKEA', 'seller', ['home'], ['CH', 'IT', 'DE', 'AT', 'FR', 'GB', 'US', 'ES'], 3),
  entry('wayfair.com', 'Wayfair', 'seller', ['home'], ['US', 'GB', 'DE'], 2),
  entry('manomano.fr', 'ManoMano France', 'seller', ['home'], ['FR'], 2),
  entry('manomano.it', 'ManoMano Italia', 'seller', ['home'], ['IT'], 2),
  entry('leroymerlin.it', 'Leroy Merlin Italia', 'seller', ['home'], ['IT'], 2),
  entry('leroymerlin.fr', 'Leroy Merlin France', 'seller', ['home'], ['FR'], 2),
  entry('hornbach.ch', 'Hornbach Schweiz', 'seller', ['home'], ['CH'], 2),
  entry('hornbach.de', 'Hornbach Deutschland', 'seller', ['home'], ['DE', 'AT'], 2),
  entry('bauhaus.info', 'Bauhaus', 'seller', ['home'], ['CH', 'DE', 'AT'], 2),
  entry('obi.de', 'OBI', 'seller', ['home'], ['DE'], 2),
  entry('castorama.fr', 'Castorama', 'seller', ['home'], ['FR'], 2),
  entry('screwfix.com', 'Screwfix', 'seller', ['home'], ['GB'], 2),

  // Sports and outdoor.
  entry('decathlon.ch', 'Decathlon Schweiz', 'seller', ['sports'], ['CH'], 3),
  entry('decathlon.it', 'Decathlon Italia', 'seller', ['sports'], ['IT'], 3),
  entry('decathlon.de', 'Decathlon Deutschland', 'seller', ['sports'], ['DE'], 3),
  entry('decathlon.fr', 'Decathlon France', 'seller', ['sports'], ['FR'], 3),
  entry('decathlon.co.uk', 'Decathlon UK', 'seller', ['sports'], ['GB'], 3),
  entry('bike24.com', 'Bike24', 'seller', ['sports'], ['DE', 'AT', 'CH', 'FR', 'IT'], 2),
  entry('alltricks.com', 'Alltricks', 'seller', ['sports'], ['FR', 'IT', 'DE', 'GB', 'ES'], 2),
  entry('canyon.com', 'Canyon', 'seller', ['sports'], 'global', 2),
  entry('rei.com', 'REI', 'seller', ['sports'], ['US'], 3),
  entry('bergfreunde.de', 'Bergfreunde', 'seller', ['sports'], ['DE', 'AT', 'CH'], 1),

  // Books.
  entry('orellfuessli.ch', 'Orell Füssli', 'seller', ['books'], ['CH'], 3),
  entry('payot.ch', 'Payot', 'seller', ['books'], ['CH'], 2),
  entry('ibs.it', 'IBS', 'seller', ['books'], ['IT'], 3),
  entry('feltrinelli.it', 'La Feltrinelli', 'seller', ['books'], ['IT'], 2),
  entry('mondadori.it', 'Mondadori', 'seller', ['books'], ['IT'], 2),
  entry('hoepli.it', 'Hoepli', 'seller', ['books'], ['IT'], 2),
  entry('thalia.de', 'Thalia', 'seller', ['books'], ['DE'], 3),
  entry('waterstones.com', 'Waterstones', 'seller', ['books'], ['GB'], 3),
  entry('barnesandnoble.com', 'Barnes & Noble', 'seller', ['books'], ['US'], 3),

  // Cars and tyres.
  entry('autoscout24.ch', 'AutoScout24 Schweiz', 'marketplace', ['auto'], ['CH'], 3),
  entry('autoscout24.it', 'AutoScout24 Italia', 'marketplace', ['auto'], ['IT'], 3),
  entry('autoscout24.de', 'AutoScout24 Deutschland', 'marketplace', ['auto'], ['DE'], 3),
  entry('autoscout24.fr', 'AutoScout24 France', 'marketplace', ['auto'], ['FR'], 3),
  entry('autoscout24.at', 'AutoScout24 Österreich', 'marketplace', ['auto'], ['AT'], 3),
  entry('mobile.de', 'mobile.de', 'marketplace', ['auto'], ['DE'], 3),
  entry('automobile.it', 'Automobile.it', 'marketplace', ['auto'], ['IT'], 2),
  entry('carwow.co.uk', 'Carwow', 'comparison', ['auto'], ['GB'], 1),
  entry('quattroruote.it', 'Quattroruote', 'review', ['auto'], ['IT'], 1),
  entry('parkers.co.uk', 'Parkers', 'review', ['auto'], ['GB'], 1),
  entry('kbb.com', 'Kelley Blue Book', 'review', ['auto'], ['US'], 1),
];

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
export function sourcePlan(config: ShoppingConfig, catalog: SourceEntry[] = DEFAULT_SOURCE_CATALOG): SourcePlan {
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

/** Merge persisted overrides onto the built-in catalog, one entry per domain. */
export function mergeSourceCatalog(defaults: SourceEntry[] = DEFAULT_SOURCE_CATALOG, overrides: SourceEntry[]): SourceEntry[] {
  const byDomain = new Map(defaults.map(source => [source.domain, source]));
  for (const entry of overrides) byDomain.set(entry.domain, entry);
  return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
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
