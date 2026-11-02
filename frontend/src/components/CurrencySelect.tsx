import { COMMON_CURRENCIES, CurrencySchema, type Currency } from '@fairbuy/core';

const currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' });
const common = new Set<Currency>(COMMON_CURRENCIES);
function label(code: Currency) {
  const name = currencyNames.of(code);
  return name ? `${name} (${code})` : code;
}

export default function CurrencySelect({ id, value, onChange, disabled = false }: {
  id?: string; value: Currency; onChange: (currency: Currency) => void; disabled?: boolean;
}) {
  return <select id={id} value={value} disabled={disabled} onChange={event => onChange(event.target.value as Currency)}>
    <optgroup label="Common currencies">
      {COMMON_CURRENCIES.map(code => <option key={code} value={code}>{label(code)}</option>)}
    </optgroup>
    <optgroup label="More currencies">
      {CurrencySchema.options.filter(code => !common.has(code)).map(code => <option key={code} value={code}>{label(code)}</option>)}
    </optgroup>
  </select>;
}
