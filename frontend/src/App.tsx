import { useCallback, useEffect, useRef, useState } from 'react';
import { ASK_QUESTION_CAP, DISCOVERY_MIN_PRODUCTS, DROP_REASONS, activeProducts, askRounds, latestRound, missingForSearch, roundOutcome, sellerSearchFor, type Product, type ShoppingConfig, type ShoppingLocation, type ShoppingSession } from '@fairbuy/core';
import { api, type Bootstrap } from './api';
import Chat from './components/Chat';
import Brief from './components/Brief';
import Configure from './components/Configure';
import ProductCard from './components/ProductCard';
import PreviousResults from './components/PreviousResults';
import DiscoveryActivity from './components/DiscoveryActivity';
import LearnModal from './components/LearnModal';
import Buy from './components/Buy';
import LocationBar from './components/LocationBar';
import { useGeolocation } from './useGeolocation';
import { setDiagnosticSession } from './telemetry';

type Stage = ShoppingSession['stage'];
const titles: Record<Stage, [string, string]> = {
  ask: ['A good buy starts with', 'a better question.'], configure: ['Review your brief.', 'Then find products.'],
  discovery: ['Compare products.', 'Choose what fits.'], buy: ['Your choice.', 'On your terms.'],
};
function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 1) return 'under 1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}
function useClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
const emptyTitle = {
  found: 'No grounded matches this time.',
  nothing_retrieved: 'The search returned no pages.',
  nothing_grounded: 'No offer could be verified.',
  all_excluded: 'Every offer found was ruled out.',
} as const;
export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null); const [session, setSession] = useState<ShoppingSession | null>(null);
  useEffect(() => {
    setDiagnosticSession(session?.id ?? null);
    return () => setDiagnosticSession(null);
  }, [session?.id]);
  const [stage, setStage] = useState<Stage>('ask'); const [draft, setDraft] = useState<ShoppingConfig | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [learning, setLearning] = useState<{ product: Product | null } | null>(null); const [accessToken, setAccessToken] = useState('');
  const [refinement, setRefinement] = useState(''); const [missingQuery, setMissingQuery] = useState('');
  const [manualLocation, setManualLocation] = useState<ShoppingLocation | null>(null);
  const currentConfig = stage === 'configure' ? draft : session?.config;
  const geolocation = useGeolocation(!!boot && !boot.accessRequired && stage === 'ask' && !currentConfig?.country && !manualLocation);
  const suggestedLocation = manualLocation ?? geolocation.location;
  const initialLocation = suggestedLocation?.currency ? suggestedLocation : null;
  const locationAttempt = useRef(''); const sellerAttempt = useRef('');
  const shoppingLocation: ShoppingLocation | null = currentConfig?.country
    ? { country: currentConfig.country, city: currentConfig.city, currency: currentConfig.currency } : suggestedLocation;
  const heading = useRef<HTMLHeadingElement>(null);
  const chooseLatestLocation = useRef(chooseLocation);
  const accept = useCallback((next: ShoppingSession, navigate = true) => {
    setSession(next); setDraft(next.config); if (navigate) setStage(next.stage);
  }, []);
  const load = useCallback(async () => {
    try { const data = await api<Bootstrap>('/bootstrap'); setBoot(data); if (data.session) accept(data.session); }
    catch (e) { setError((e as Error).message); }
  }, [accept]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [stage]);
  const round = session ? latestRound(session) : undefined;
  const products = session ? activeProducts(session) : [];
  const selected = products.find(p => p.id === session?.selectedProductId);
  const sellerSearch = session ? sellerSearchFor(session, selected?.id) : null;
  const sellerSearching = !!sellerSearch && ['queued', 'running'].includes(sellerSearch.status);
  const searching = !!round && ['queued', 'running'].includes(round.status);
  const polling = searching || sellerSearching;
  const clock = useClock(searching);
  const searchStarted = round?.startedAt ?? round?.createdAt;
  const searchTime = round && searchStarted
    ? round.durationMs ?? (round.finishedAt ? Math.max(0, Date.parse(round.finishedAt) - Date.parse(searchStarted)) : searching ? Math.max(0, clock - Date.parse(searchStarted)) : null)
    : null;
  const timingLabel = round?.status === 'queued' ? 'queued' : searching ? 'searching' : 'took';
  useEffect(() => {
    if (!session || !polling) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await api<ShoppingSession>(`/sessions/${session.id}`);
        if (!cancelled) { setSession(current => current && current.id === next.id && next.version >= current.version ? next : current); setError(''); }
      } catch (e) { if (!cancelled) setError((e as Error).message); }
    }, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session?.id, polling]);
  // Landing in Buy starts one strong, same-market search for other sellers of
  // the chosen model. The spinner card represents the next seller slot until
  // the result arrives; a failed search is retried only on explicit request.
  useEffect(() => {
    if (stage !== 'buy' || !session || !selected) return;
    if (sellerSearch && sellerSearch.status !== 'failed') return;
    const key = `${session.id}:${selected.id}`;
    if (sellerAttempt.current === key) return;
    sellerAttempt.current = key;
    let cancelled = false;
    void api<ShoppingSession>(`/sessions/${session.id}/sellers`, 'POST', { productId: selected.id })
      .then(next => { if (!cancelled) { accept(next, false); setError(''); } })
      .catch(error => {
        // The POST only queues the job. A failure here is validation, access or
        // connectivity, so allow the next Buy landing to try again.
        if (!cancelled) { sellerAttempt.current = ''; setError((error as Error).message); }
      });
    return () => { cancelled = true; };
  }, [stage, session?.id, selected?.id, sellerSearch?.id, sellerSearch?.status, accept]);
  useEffect(() => {
    if (!session || session.config.country || !initialLocation || busy || searching || stage !== 'ask') return;
    const key = `${session.id}:${JSON.stringify(initialLocation)}`;
    if (locationAttempt.current === key) return;
    locationAttempt.current = key;
    setBusy(true);
    void api<ShoppingSession>(`/sessions/${session.id}/location`, 'PATCH', { ...initialLocation, onlyIfMissing: true })
      .then(next => accept(next, false)).catch(error => setError((error as Error).message)).finally(() => setBusy(false));
  }, [session, initialLocation, busy, searching, stage, accept]);
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); return true; } catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  async function ensureSession() {
    if (session) return session;
    const created = await api<ShoppingSession>('/sessions', 'POST', initialLocation ? { location: initialLocation } : {}); accept(created); return created;
  }
  async function chooseLocation(location: ShoppingLocation) {
    if (busy || searching) return false;
    geolocation.cancel();
    if (stage === 'configure' && draft) {
      setDraft({ ...draft, ...location, currency: location.currency ?? draft.currency }); setManualLocation(location); return true;
    }
    return perform(async () => {
      if (session) accept(await api<ShoppingSession>(`/sessions/${session.id}/location`, 'PATCH', location), stage === 'buy');
      setManualLocation(location);
    });
  }
  chooseLatestLocation.current = chooseLocation;
  const send = (phase: 'ask' | 'configure', message: string) => perform(async () => {
    const current = await ensureSession();
    // A user may start chatting before granting permission. Seed a late result on
    // the next message, but never replace a country supplied in the conversation.
    if (phase === 'ask' && !current.config.country && initialLocation) {
      await api(`/sessions/${current.id}/location`, 'PATCH', { ...initialLocation, onlyIfMissing: true });
    }
    if (phase === 'configure' && draft) await api(`/sessions/${current.id}/configure`, 'PUT', draft);
    accept(await api<ShoppingSession>(`/sessions/${current.id}/${phase === 'ask' ? 'ask' : 'configure/chat'}`, 'POST', { message }));
  });
  async function findProducts() {
    if (!session || !draft) return;
    await perform(async () => {
      const saved = await api<ShoppingSession>(`/sessions/${session.id}/configure`, 'PUT', draft); accept(saved, false);
      accept(await api<ShoppingSession>(`/sessions/${session.id}/discovery`, 'POST'));
      setNotice('');
    });
  }
  async function retrySellerSearch() {
    if (!session || !selected) return;
    sellerAttempt.current = `${session.id}:${selected.id}`;
    await perform(async () => accept(await api<ShoppingSession>(`/sessions/${session.id}/sellers`, 'POST', { productId: selected.id }), false));
  }
  async function navigate(next: Stage) {
    if (busy || searching || next === stage) return;
    if (stage === 'configure' && draft && session && JSON.stringify(draft) !== JSON.stringify(session.config)) {
      if (!await perform(async () => { accept(await api<ShoppingSession>(`/sessions/${session.id}/configure`, 'PUT', draft), false); })) return;
    }
    if (session) {
      await perform(async () => { accept(await api<ShoppingSession>(`/sessions/${session.id}/stage`, 'PATCH', { stage: next })); setNotice(''); });
    } else { setStage(next); setNotice(''); }
  }
  const visibleProducts = products.map(product => ({
    product, ranked: (round?.ranking?.ranked ?? []).filter(r => product.offers.some(o => o.id === r.offerId)),
  })).filter(p => p.ranked.length).sort((a, b) => a.ranked[0].rank - b.ranked[0].rank);
  const stale = !!round && !!session && JSON.stringify(round.context.config) !== JSON.stringify(session.config);
  const unavailable = busy || searching;
  return <div className="app-shell">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><a className="brand" href="/" aria-label="FairBuy home"><span className="brand-icon" aria-hidden="true">◇</span>fairbuy<span className="brand-dot">.</span></a>
      <nav className="progress" aria-label="Shopping steps"><ol>{([
      ['ask', '01', 'Ask'], ['configure', '02', 'Configure'], ['discovery', '03', 'Discovery'], ['buy', '04', 'Buy'],
    ] as const).map(([key, number, label]) => <li key={key} className={stage === key ? 'current' : ''}>
      <button aria-current={stage === key ? 'step' : undefined} disabled={unavailable || (key === 'configure' && !session?.ready) || (key === 'discovery' && !session?.rounds.length) || (key === 'buy' && !selected)} onClick={() => { void navigate(key); }}><span className="step-number">{number}</span>{label}</button>
      {key === 'discovery' && <><span className="learn-arrow" aria-hidden="true">↔</span><button className={`learn-nav ${learning ? 'active' : ''}`} disabled={unavailable || !session?.rounds.length} onClick={() => setLearning({ product: null })}>Learn</button></>}
    </li>)}</ol></nav>
      <div className="header-right"><button className="text-button new-search" disabled={unavailable || !session} onClick={() => { void perform(async () => {
        if (session) await api(`/sessions/${session.id}`, 'DELETE');
        setSession(null); setDraft(null); setStage('ask'); setNotice(''); setRefinement('');
      }); }}>New search <span aria-hidden="true">↗</span></button></div></header>
    {boot?.mode === 'demo' && <div className="mode-banner" role="note"><strong>Scripted preview</strong><span>Fictional products, prices and sellers. No live AI or current offers.{!boot.persistent && ' Changes are lost when the server restarts.'}</span></div>}
    <main id="main">
      <div className="page-heading"><div>
        <h1 ref={heading} tabIndex={-1}>{titles[stage][0]}<br /><em>{titles[stage][1]}</em></h1></div>
        {boot && !boot.accessRequired && <LocationBar location={shoppingLocation} pending={geolocation.pending} message={geolocation.message} busy={unavailable}
          onSave={chooseLocation} onLocate={() => { void geolocation.locate().then(location => { if (location?.currency) void chooseLatestLocation.current(location); }); }} />}
      </div>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {!boot && <div className="panel loading-state" role="status">{error ? <button className="button secondary" onClick={() => { void load(); }}>Reconnect</button> : <><span className="spinner" />Getting things ready…</>}</div>}
      {boot?.accessRequired && <form className="access-panel panel" onSubmit={event => { event.preventDefault(); void perform(async () => { await api('/access', 'POST', { token: accessToken }); setAccessToken(''); await load(); }); }}>
        <span className="eyebrow">A PRIVATE SHOPPING SPACE</span><h2>Welcome to FairBuy.</h2><p className="muted">Enter the app password for this deployment to continue.</p><label htmlFor="access-token">App password</label><input type="password" autoComplete="current-password" id="access-token" value={accessToken} onChange={e => setAccessToken(e.target.value)} /><button className="button primary" disabled={busy || !accessToken}>Let’s begin →</button>
      </form>}
      {boot && !boot.accessRequired && <>
        {!boot.aiConfigured && <div className="notice"><span aria-hidden="true">ⓘ</span><p>The app is ready for setup. Add <code>MODEL_API_KEY</code> in Render to enable Ask, Configure and web discovery. Your key never goes to the browser.</p></div>}
        {stage === 'ask' && <><div className="ask-layout"><div><Chat messages={session?.askMessages ?? []} busy={busy} onSend={message => send('ask', message)} disabled={!boot.aiConfigured} instantClassifier={boot.instantClassifierConfigured} />
          <div className="ask-bottom">{session && !session.ready && askRounds(session) >= ASK_QUESTION_CAP && <p className="micro">To continue, add the {missingForSearch(session.config).join(', ')}.</p>}<button className="button primary" disabled={!session?.ready || unavailable} onClick={() => { void navigate('configure'); }}>Continue to Configure <span aria-hidden="true">→</span></button></div></div><Brief session={session} /></div></>}
        {stage === 'configure' && draft && session && <div className="configure-layout"><Configure config={draft} onChange={setDraft} onSearch={() => { void findProducts(); }} busy={busy} /><div className="configure-aside"><Chat compact messages={session.configureMessages} busy={busy} onSend={message => send('configure', message)} disabled={!boot.aiConfigured} />{!!session.feedback.length && <div className="panel"><h3>Also learned along the way</h3>{session.feedback.map(f => <p className="micro" key={f.id}>{f.reason}</p>)}</div>}</div></div>}
        {stage === 'discovery' && session && <section aria-label="Product discovery">
          <div className="discovery-toolbar"><div><span className="status-dot" /><strong>{visibleProducts.length} {visibleProducts.length === 1 ? 'option' : 'options'}{searching ? ' · searching' : ''}</strong><span className="micro">{session.config.category} · {session.config.country} · search {round?.number ?? 0}{searchTime !== null && ` · ${timingLabel} ${formatDuration(searchTime)}`}{!searching && round && ` · ${round.sources.length} sources`}</span></div><div className="toolbar-actions"><button className="text-button" disabled={unavailable} onClick={() => { void navigate('configure'); }}>Edit brief</button><button className="button secondary" disabled={unavailable} onClick={() => { void perform(async () => accept(await api<ShoppingSession>(`/sessions/${session.id}/discovery`, 'POST'))); }}>Refresh search ↻</button></div></div>
          {notice && <div className="success-banner" role="status">✓ {notice}</div>}
          {stale && !searching && <div className="notice"><p>Your brief changed. These results reflect the previous configuration. Refresh search before choosing a product.</p></div>}
          {searching && <div className="search-progress panel" role="status"><span className="spinner large" /><div><h2>{round?.status === 'queued' ? 'Your research is queued.' : 'Finding source-backed offers…'}</h2>{round?.status !== 'queued' && <p className="muted">You can compare results as they arrive.</p>}</div></div>}
          {round && <DiscoveryActivity round={round} />}
          {round?.status === 'failed' && <div className="error-banner" role="alert"><p>{round.error} Your brief and feedback are saved. Use Refresh search to retry.{round.durationMs !== null && ` Search stopped after ${formatDuration(round.durationMs)}.`}</p></div>}
          {round && (round.products.length > 0 || round.status === 'complete') && <>
            {(round.ranking?.warnings ?? []).filter(w => !/^\d+ preferences? cannot be checked automatically and (?:does|do) not affect scores\.$/.test(w)).map((w, i) => <p className="micro ranking-warning" key={i}>{w}</p>)}
            <div className="product-grid">{visibleProducts.map(({ product, ranked }, i) => <ProductCard key={product.id} product={product} sessionId={session.id} category={round.context.config.category ?? ''} ranked={ranked} index={i} busy={unavailable || stale}
              onLearn={() => setLearning({ product })} onSelect={() => { void perform(async () => accept(await api<ShoppingSession>(`/sessions/${session.id}/select`, 'POST', { productId: product.id }))); }} />)}</div>
            {round.status === 'complete' && visibleProducts.length > 0 && visibleProducts.length < DISCOVERY_MIN_PRODUCTS && <div className="notice"><p>Fewer than {DISCOVERY_MIN_PRODUCTS} grounded options met your brief. Try broadening your budget or requirements to see more; we won’t invent offers to fill the page.</p></div>}
            {round.status === 'complete' && !visibleProducts.length && <div className="empty-state panel"><span aria-hidden="true">◌</span><h2>{emptyTitle[roundOutcome(round)]}</h2><p>{roundOutcome(round) === 'nothing_grounded' ? `The search returned ${round.sources.length} ${round.sources.length === 1 ? 'page' : 'pages'}, but none had a seller offer we could check against your brief. ` : roundOutcome(round) === 'nothing_retrieved' ? 'Nothing could be checked. ' : 'Every offer that was found is listed below with the reason it was ruled out. '}Try relaxing a must-have, adding context, or broadening your budget. We won’t invent an offer just to fill the page.</p><button className="button secondary" onClick={() => { void navigate('configure'); }}>Review my brief →</button></div>}
            {!!(round.ranking?.excluded.length || round.dropped?.length) && <details className="panel exclusions" open={!visibleProducts.length}><summary>Why these results</summary>
              {!!round.ranking?.excluded.length && <><h3>Excluded by your brief ({round.ranking.excluded.length})</h3><ul>{round.ranking.excluded.map(ex => { const offer = round.products.flatMap(p => p.offers).find(o => o.id === ex.offerId); return <li key={ex.offerId}><strong>{offer?.title} · {offer?.seller}</strong>: {ex.reasons.join('; ')}</li>; })}</ul></>}
              {!!round.dropped?.length && <><h3>Found but not usable ({round.dropped.length})</h3><ul>{round.dropped.map((d, i) => <li key={i}><strong>{d.product}{d.seller ? ` · ${d.seller}` : ''}</strong>{d.host ? ` (${d.host})` : ''}: {DROP_REASONS[d.reason]}</li>)}</ul></>}
              {!!round.sources.length && <p className="micro">Searched {round.sources.length} {round.sources.length === 1 ? 'page' : 'pages'}. A product that never appeared on them is not listed here: it was not found, not rejected.</p>}
            </details>}
            {round.status === 'complete' && <section className="panel missing-check" aria-labelledby="missing-check-title">
              <h3 id="missing-check-title">Looking for a specific product?</h3>
              <form onSubmit={event => { event.preventDefault(); const query = missingQuery.trim(); if (query.length < 2) return; void perform(async () => { accept(await api<ShoppingSession>(`/sessions/${session.id}/missing`, 'POST', { query })); setMissingQuery(''); }); }}>
                <label className="sr-only" htmlFor="missing-query">Product name or reference</label>
                <input id="missing-query" value={missingQuery} maxLength={120} placeholder="e.g. Omega Speedmaster 310.30" onChange={event => setMissingQuery(event.target.value)} />
                <button className="button secondary" disabled={unavailable || missingQuery.trim().length < 2}>Why isn’t it here?</button>
              </form>
              {(() => { const answer = round.missingQuestions?.at(-1); return answer && <div className="missing-answer" role="status">
                <p><span className="micro">“{answer.query}”</span><br /><strong>{answer.summary}</strong></p>
                {!!answer.reasons.length && <ul>{answer.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
                {!!answer.nextSteps.length && <><p className="micro">What you can do</p><ul>{answer.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul></>}
                {answer.searched && <p className="micro">{answer.searched}</p>}
                {answer.nextSteps.some(n => n.includes('Configure')) && <button className="text-button" onClick={() => { void navigate('configure'); }}>Review my brief →</button>}
              </div>; })()}
            </section>}
            {!!round.sources.length && <details className="panel sources"><summary>All research sources ({round.sources.length})</summary><ul>{round.sources.map(s => <li key={s.url}><a href={s.url} rel="noopener noreferrer" target="_blank">{s.title} ↗</a></li>)}</ul></details>}
          </>}
          <PreviousResults session={session} activeIds={new Set(visibleProducts.map(item => item.product.id))} />
          {!!session.feedback.length && <details className="panel feedback-history" open><summary>What we’ve learned ({session.feedback.length})</summary><ul>{session.feedback.map(f => <li key={f.id}><div><strong>{f.productName ? `Not for you: ${f.productName}` : 'A new detail'}</strong><p>{f.reason}</p></div><button className="text-button" disabled={unavailable} onClick={() => { void perform(async () => { accept(await api<ShoppingSession>(`/sessions/${session.id}/learn/${f.id}`, 'DELETE')); setNotice('Feedback removed. A fresh search will restore eligible options.'); }); }}>Undo</button></li>)}</ul></details>}
          <form className="discovery-refinement panel" onSubmit={async event => {
            event.preventDefault();
            const reason = refinement.trim();
            if (!reason || unavailable) return;
            if (await perform(async () => {
              accept(await api<ShoppingSession>(`/sessions/${session.id}/learn`, 'POST', { productId: null, reason }));
              setNotice('Request saved. Searching again with your brief and all your feedback.');
            })) setRefinement('');
          }}>
            <label htmlFor="discovery-refinement">Steer your results</label>
            <p className="muted" id="discovery-refinement-help">Add a brand or requirement to search again with your existing brief.</p>
            <textarea id="discovery-refinement" aria-describedby="discovery-refinement-help" rows={2} maxLength={1500} value={refinement} onChange={event => setRefinement(event.target.value)} disabled={busy} placeholder="e.g. Include Moulinex products too, or only show dishwasher-safe options." />
            <div className="refinement-actions">{searching && <p className="micro">Submit when this search finishes.</p>}<button className="button secondary" disabled={unavailable || !refinement.trim()}>Update results <span aria-hidden="true">↗</span></button></div>
          </form>
        </section>}
        {stage === 'buy' && selected && session && <Buy product={selected} session={session} sellerSearch={sellerSearch} onRetrySellerSearch={() => { void retrySellerSearch(); }} onBack={() => { void navigate('discovery'); }} />}
      </>}
    </main>
    <footer className="site-footer"><div className="footer-signoff"><span className="brand">fairbuy<span className="brand-dot">.</span></span></div><details><summary>Privacy, evidence & how it works</summary>
      <p><strong>How it works.</strong> Tell us what you need, refine your brief, and explore products with sources and trade-offs. Your feedback helps shape the next search. You decide what to buy and complete any purchase with the seller.</p>
      <p><strong>Evidence limits.</strong> AI extraction is not independent verification. Prices, stock and seller claims may be stale or incomplete; market coverage is not guaranteed. Scores are not a quality or safety guarantee. Prices exclude shipping and delivery. Check the seller’s current terms before buying.</p>
      <p><strong>Your searches.</strong> No account is needed. An HttpOnly browser cookie keeps your searches separate from other visitors’ searches. Clearing cookies removes your access, and searches cannot be recovered on another device. “New search” closes your current search but does not erase its history: administrators can still access it. Records do not expire automatically; permanent deletion requires backoffice maintenance.</p>
      <p><strong>Error diagnostics.</strong> If an image or JavaScript operation fails, the browser sends limited technical metadata to FairBuy: error category, search/product identifiers when available, or script filename and position. A random trace ID links related browser and server events. Diagnostics are available only to administrators; retention is managed outside the app, with no automatic expiry or cleanup in the application. Session-linked events are also removed when that search is permanently deleted. Reports do not include chat text, error messages, full URLs, or console output. Hosting logs and database backups have separate retention policies.</p>
      <p><strong>AI and search providers.</strong> Live requests and research are sent to Meta Model API and, when selected, Brave. Provider response storage is disabled, but providers’ own retention policies still apply. Do not enter sensitive personal information or payment details.</p>
      <p><strong>Product images.</strong> If a public image host refuses a download, FairBuy may try the free wsrv.nl image proxy. Its servers receive the full image URL, including any query parameters, but no FairBuy cookies, chat text or login credentials. The proxy may cache the image and applies its own retention policies. When no real photo loads, we show an AI-generated category illustration, not a photo of the specific product. If enabled, Cloudflare Workers AI receives a product’s name and category to choose existing artwork when local matching finds no category; it receives no chat history, location, seller URLs or credentials from your search.</p>
      <p><strong>Suggestions while you type.</strong> When Instant classification is enabled, your unsent draft is sent to Cloudflare-hosted Meta Llama after a 600 ms pause. These suggestions do not change your confirmed brief. The classifier does not receive your conversation history or separately stored location. FairBuy temporarily keeps up to 100 previews, isolated by visitor, in memory for five minutes. Provider retention policies still apply.</p>
      <p><strong>Your location.</strong> Location access is optional. With your browser’s permission, rounded coordinates are sent to OpenStreetMap’s Nominatim service to suggest your city and country. FairBuy does not save precise coordinates or street addresses. Only your shopping city, country and chosen currency enter your brief. You can enter or change these yourself.</p>
    </details></footer>
    {learning && session && <LearnModal product={learning.product} busy={busy} error={error} onClose={() => setLearning(null)} onApply={reason => perform(async () => {
      accept(await api<ShoppingSession>(`/sessions/${session.id}/learn`, 'POST', { productId: learning.product?.id ?? null, reason }));
      // Close immediately after the feedback is accepted; the preserved shortlist
      // and its refreshed ranking are already part of the returned session.
      setLearning(null); setNotice('Feedback saved. Fresh search, with everything we’ve learned.');
    })} />}
  </div>;
}
