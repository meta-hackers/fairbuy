import { useState } from 'react';
import { CurrencySchema, currencyForCountry, type ShoppingLocation } from '@fairbuy/core';

const countries = new Intl.DisplayNames(['en'], { type: 'region' });
function countryName(code: string) { return /^[A-Z]{2}$/.test(code) ? countries.of(code) ?? code : code; }
export default function LocationBar({ location, pending, message, busy, onLocate, onSave }: {
  location: ShoppingLocation | null; pending: boolean; message: string; busy: boolean;
  onLocate: () => void; onSave: (location: ShoppingLocation) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [country, setCountry] = useState(''); const [city, setCity] = useState('');
  const [currency, setCurrency] = useState<ShoppingLocation['currency']>('EUR');
  function edit() {
    setCountry(location?.country ?? ''); setCity(location?.city ?? ''); setCurrency(location?.currency ?? 'EUR'); setEditing(true);
  }
  return <section className="location-panel" aria-label="Shopping location">
    <div className="location-summary"><div><strong>{location
      ? `Shopping in ${[location.city, countryName(location.country)].filter(Boolean).join(', ')} · ${location.currency ?? 'choose currency'}`
      : 'Where are you shopping?'}</strong>
      <p className="micro" role="status">{pending ? 'Finding your location… You can keep shopping.' : message || (location
        ? location.currency ? 'City and country only. Your shopping location is always editable.' : 'The local currency is not supported yet. Choose EUR, CHF, USD or GBP manually.'
        : 'Allow location access to suggest your city, country and currency, or set them manually.')}</p></div>
      <div className="location-actions"><button className="text-button" disabled={busy || pending} onClick={onLocate}>Use my location</button><button className="button secondary" disabled={busy} onClick={edit}>{location ? 'Change location' : 'Set location'}</button></div>
    </div>
    {editing && <form className="location-editor" onSubmit={event => {
      event.preventDefault(); void onSave({ country, city: city.trim() || null, currency }).then(saved => { if (saved) setEditing(false); });
    }}><fieldset className="plain-fieldset" disabled={busy}>
      <div className="location-fields"><label>Shopping country code<input autoFocus value={country} maxLength={2} placeholder="CH" onChange={event => {
        const code = event.target.value.toUpperCase(); if (code !== country) setCity(''); setCountry(code);
        const suggested = currencyForCountry(code); if (suggested) setCurrency(suggested);
      }} aria-describedby="location-country-hint" /><span className="micro" id="location-country-hint">Two letters: IT, CH, GB, US…</span></label>
        <label>Shopping city <span className="optional">optional</span><input value={city} maxLength={120} onChange={event => setCity(event.target.value)} placeholder="City or region" /></label>
        <label>Shopping currency<select value={currency ?? 'EUR'} onChange={event => setCurrency(event.target.value as ShoppingLocation['currency'])}>{CurrencySchema.options.map(code => <option key={code}>{code}</option>)}</select></label></div>
      {country.length === 2 && !currencyForCountry(country) && <p className="micro">Choose a supported shopping currency; no exchange rate is assumed.</p>}
      <div className="location-actions"><button type="button" className="text-button" onClick={() => setEditing(false)}>Cancel</button><button className="button primary" disabled={!/^[A-Z]{2}$/.test(country)}>Save location</button></div>
    </fieldset></form>}
    <p className="location-credit micro">Automatic lookup uses rounded coordinates via <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>. No exact address is saved.</p>
  </section>;
}
