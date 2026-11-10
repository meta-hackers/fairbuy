import type { ShoppingSession } from '@fairbuy/core';
export default function Brief({ session }: { session: ShoppingSession | null }) {
  const config = session?.config;
  const entries = [
    ['Looking for', config?.category], ['For', config?.purpose],
    ['Budget', config && (config.budgetMin != null || config.budgetMax !== null) ? `${config.currency} ${(config.budgetMin ?? 0).toLocaleString()} – ${config.budgetMax?.toLocaleString() ?? 'No maximum'}` : null],
    ['Shopping in', [config?.city, config?.country].filter(Boolean).join(', ')],
  ];
  return <aside className="brief panel">
    <div className="eyebrow">THE BIG PICTURE</div><h2>Your brief, taking shape.</h2>
    <p className="muted">A few good details make all the difference.</p>
    <dl>{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={value ? '' : 'unknown'}>{value || 'Let’s find out'}</dd></div>)}</dl>
    {!!config?.requirements.length && <div className="brief-requirements">{config.requirements.slice(0, 5).map((r, i) => <span className="tag" key={i}>{r.label}</span>)}</div>}
    <div className={`brief-status ${session?.ready ? 'is-ready' : ''}`}><span aria-hidden="true">{session?.ready ? '✓' : '◌'}</span>{session?.ready ? 'Ready for your review' : 'No rush. We’ll get it right.'}</div>
    {!!session?.missing.length && !session.ready && <p className="micro">Still useful to know: {session.missing.join(' · ')}</p>}
  </aside>;
}
