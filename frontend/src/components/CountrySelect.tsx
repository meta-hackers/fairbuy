import { COUNTRIES } from '../countries';

export default function CountrySelect({ id, value, onChange, disabled = false, autoFocus = false, describedBy, ariaLabel }: {
  id?: string; value: string; onChange: (code: string) => void; disabled?: boolean; autoFocus?: boolean; describedBy?: string; ariaLabel?: string;
}) {
  return <select id={id} value={value} disabled={disabled} autoFocus={autoFocus} aria-describedby={describedBy} aria-label={ariaLabel}
    onChange={event => onChange(event.target.value)}>
    <option value="">Select a country</option>
    {COUNTRIES.map(country => <option key={country.code} value={country.code}>
      {country.name} ({country.code}) {country.flag}
    </option>)}
  </select>;
}
