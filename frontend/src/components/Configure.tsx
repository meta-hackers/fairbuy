import { useState } from 'react';
import { currencyForCountry, type ShoppingConfig } from '@fairbuy/core';
import CountrySelect from './CountrySelect';
import CurrencySelect from './CurrencySelect';
export default function Configure({ config, onChange, onSearch, busy }: {
  config: ShoppingConfig; onChange: (config: ShoppingConfig) => void; onSearch: () => void; busy: boolean;
}) {
  const [custom, setCustom] = useState('');
  const update = (patch: Partial<ShoppingConfig>) => onChange({ ...config, ...patch });
  const valid = !!(config.category?.trim() && config.purpose?.trim() && config.country?.match(/^[A-Z]{2}$/) && (config.budgetMax === null || config.budgetMax > 0));
  return <section className="panel config-panel" aria-label="Shopping configuration">
    <div className="section-heading"><div><div className="eyebrow">YOUR SEARCH, YOUR TERMS</div><h2>A brief that feels like you.</h2></div><span className="step-mark">02</span></div>
    <fieldset disabled={busy} className="plain-fieldset">
      <div className="field-grid"><label>Product category<input value={config.category ?? ''} maxLength={100} onChange={e => update({ category: e.target.value || null })} placeholder="e.g. laptop" /></label>
        <label>Country<CountrySelect ariaLabel="Country" value={config.country ?? ''} describedBy="country-hint" onChange={country => update({ country: country || null, city: null, currency: currencyForCountry(country) ?? config.currency })} /><span className="micro" id="country-hint">Its local currency is selected when supported.</span></label></div>
      <label>What you’ll use it for<textarea rows={2} maxLength={500} value={config.purpose ?? ''} onChange={e => update({ purpose: e.target.value || null })} /></label>
      <div className="field-grid budget-fields"><label>Budget ceiling <span className="optional">optional</span><input type="number" min="1" max="1000000" value={config.budgetMax ?? ''} onChange={e => update({ budgetMax: e.target.value ? Number(e.target.value) : null })} placeholder="No ceiling" /></label>
        <label>Currency<CurrencySelect value={config.currency} onChange={currency => update({ currency })} /></label></div>
      <label className="check-row"><input type="checkbox" checked={config.budgetHard} onChange={e => update({ budgetHard: e.target.checked })} />My budget is a hard limit, not a preference</label>
      <label>City / region <span className="optional">optional, no exact address needed</span><input value={config.city ?? ''} maxLength={120} onChange={e => update({ city: e.target.value || null })} placeholder="e.g. Milan" /></label>
      <div className="requirements-heading"><h3>What matters to you</h3><span className="micro">Preferences can bend. Must-haves can’t.</span></div>
      <ul className="requirement-list">{config.requirements.map((req, i) => <li key={i}>
        <div><span>{req.label}</span>{!req.attribute && <small>Interpretation unconfirmed · kept in the search brief</small>}</div>
        <select aria-label={`Priority for ${req.label}`} value={req.hard ? 'hard' : 'soft'} onChange={e => update({ requirements: config.requirements.map((r, n) => n === i ? { ...r, hard: e.target.value === 'hard' } : r) })}><option value="soft">Preference</option><option value="hard">Must-have</option></select>
        <button className="icon-button" aria-label={`Remove ${req.label}`} onClick={() => update({ requirements: config.requirements.filter((_, n) => n !== i) })}>×</button>
      </li>)}</ul>
      <form className="add-requirement" onSubmit={event => { event.preventDefault(); if (custom.trim() && config.requirements.length < 20) { update({ requirements: [...config.requirements, { label: custom.trim(), hard: false, attribute: null, op: null, value: null, unit: null }] }); setCustom(''); } }}>
        <label className="sr-only" htmlFor="custom-requirement">Add a requirement</label><input id="custom-requirement" value={custom} maxLength={300} onChange={e => setCustom(e.target.value)} placeholder="Anything else? Add a preference…" /><button className="button secondary" disabled={!custom.trim() || config.requirements.length >= 20}>Add</button>
      </form>
    </fieldset>
    <div className="config-bottom"><p className="micro">You’re in control. AI research starts only when you’re ready.</p><button className="button primary" onClick={onSearch} disabled={busy || !valid}>Find products <span aria-hidden="true">→</span></button></div>
  </section>;
}
