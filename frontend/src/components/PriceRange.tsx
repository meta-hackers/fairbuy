import { useState, type CSSProperties } from 'react';
import type { ShoppingConfig } from '@fairbuy/core';
import { money } from './ProductCard';

const LIMIT = 1000000;
export default function PriceRange({ config, onChange }: { config: ShoppingConfig; onChange: (patch: Partial<ShoppingConfig>) => void }) {
  const [scale, setScale] = useState(() => Math.min(LIMIT, Math.max(1000, (config.budgetMax ?? config.budgetMin ?? 500) * 2)));
  const ceiling = Math.max(scale, config.budgetMax ?? 0, config.budgetMin ?? 0);
  const minimum = config.budgetMin ?? 0;
  const maximum = config.budgetMax ?? ceiling;
  const style = { '--range-start': `${minimum / ceiling * 100}%`, '--range-end': `${maximum / ceiling * 100}%` } as CSSProperties;
  return <div className="price-range" role="group" aria-label="Price range">
    <div className="price-range-heading"><span>Price range <span className="optional">optional</span></span><button type="button" className="text-button" onClick={() => onChange({ budgetMin: null, budgetMax: null })}>Clear limits</button></div>
    <div className="price-range-values"><span>{money(minimum * 100, config.currency)}</span><span>{config.budgetMax === null ? 'No maximum' : money(maximum * 100, config.currency)}</span></div>
    <div className="price-range-slider" style={style}>
      <div className="price-range-track" />
      <input type="range" aria-label="Minimum price" min={0} max={ceiling} step={1} value={minimum} aria-valuemax={maximum} aria-valuetext={money(minimum * 100, config.currency)} onChange={event => onChange({ budgetMin: Math.min(Number(event.target.value), maximum) })} style={{ zIndex: minimum === ceiling ? 3 : 1 }} />
      <input type="range" aria-label="Maximum price" min={0} max={ceiling} step={1} value={maximum} aria-valuemin={minimum} aria-valuetext={config.budgetMax === null ? 'No maximum' : money(maximum * 100, config.currency)} onChange={event => onChange({ budgetMax: Math.max(1, minimum, Number(event.target.value)) })} />
    </div>
    {ceiling < LIMIT && <button type="button" className="text-button" onClick={() => setScale(Math.min(LIMIT, ceiling * 10))}>Widen slider range</button>}
  </div>;
}
