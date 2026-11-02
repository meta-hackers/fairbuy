import { useEffect, useState } from 'react';
import { currencyForCountry, type ShoppingLocation } from '@fairbuy/core';
import { countryName } from '../countries';
import CountrySelect from './CountrySelect';
import CurrencySelect from './CurrencySelect';
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
  // A currency or country changed in the chat updates the session config. Keep an
  // open editor in sync with that top-panel value too.
  useEffect(() => {
    if (!editing) return;
    setCountry(location?.country ?? ''); setCity(location?.city ?? ''); setCurrency(location?.currency ?? 'EUR');
  }, [editing, location?.country, location?.city, location?.currency]);
  return <section className="location-panel" aria-label="Shopping location">
    <div className="location-summary"><div><strong>{location
      ? `Shopping in ${[location.city, countryName(location.country)].filter(Boolean).join(', ')} · ${location.currency ?? 'choose currency'}`
      : 'Where are you shopping?'}</strong>
      <p className="micro" role="status">{pending ? 'Finding your location… You can keep shopping.' : message || (location
        ? location.currency ? '' : 'The local currency is not supported yet. Choose a supported shopping currency manually.'
        : 'Allow location access to suggest your city, country and currency, or set them manually.')}</p></div>
      <div className="location-actions"><button className="text-button" disabled={busy || pending} onClick={onLocate}>Use my location</button><button className="button secondary" disabled={busy} onClick={edit}>{location ? 'Change location' : 'Set location'}</button></div>
    </div>
    {editing && <form className="location-editor" onSubmit={event => {
      event.preventDefault(); void onSave({ country, city: city.trim() || null, currency }).then(saved => { if (saved) setEditing(false); });
    }}><fieldset className="plain-fieldset" disabled={busy}>
      <div className="location-fields"><label>Shopping country<CountrySelect autoFocus ariaLabel="Shopping country" value={country} describedBy="location-country-hint" onChange={code => {
        if (code !== country) setCity(''); setCountry(code);
        const suggested = currencyForCountry(code); if (suggested) setCurrency(suggested);
      }} /><span className="micro" id="location-country-hint">Its local currency is selected when supported.</span></label>
        <label>Shopping city <span className="optional">optional</span><input value={city} maxLength={120} onChange={event => setCity(event.target.value)} placeholder="City or region" /></label>
        <label>Shopping currency<CurrencySelect value={currency ?? 'EUR'} onChange={setCurrency} /></label></div>
      {country.length === 2 && !currencyForCountry(country) && <p className="micro">Choose a supported shopping currency; no exchange rate is assumed.</p>}
      <div className="location-actions"><button type="button" className="text-button" onClick={() => setEditing(false)}>Cancel</button><button className="button primary" disabled={!/^[A-Z]{2}$/.test(country)}>Save location</button></div>
    </fieldset></form>}
  </section>;
}
