import type { SourceEntry, SourceRole, Vertical } from '@fairbuy/core';

// Seed data for the discovery source catalog. This file is data, not app logic:
// edit it with the catalog seed script or the backoffice, then run
// `npm run catalog:seed` to persist changes. The seed script validates every
// entry with SourceEntrySchema before writing.
const PRODUCT_VERTICALS: Vertical[] = ['computers', 'electronics', 'home', 'fashion', 'sports', 'books', 'auto', 'general'];

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

export const SOURCE_CATALOG_SEED: SourceEntry[] = [
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
