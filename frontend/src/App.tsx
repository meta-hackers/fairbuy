import { useCallback, useEffect, useRef, useState } from 'react';
import { activeProducts, latestRound, type Product, type ShoppingConfig, type ShoppingSession } from '@fairbuy/core';
import { api, type Bootstrap } from './api';
import Chat from './components/Chat';
import Brief from './components/Brief';
import Configure from './components/Configure';
import ProductCard from './components/ProductCard';
import LearnModal from './components/LearnModal';
import Buy from './components/Buy';

type Stage = ShoppingSession['stage'];
const titles: Record<Stage, [string, string]> = {
  ask: ['A good buy starts with', 'a better question.'], configure: ['A little clarity.', 'A much better fit.'],
  discovery: ['Less searching.', 'More finding.'], buy: ['Your choice.', 'On your terms.'],
};
export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null); const [session, setSession] = useState<ShoppingSession | null>(null);
  const [stage, setStage] = useState<Stage>('ask'); const [draft, setDraft] = useState<ShoppingConfig | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [learning, setLearning] = useState<{ product: Product | null } | null>(null); const [accessToken, setAccessToken] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
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
  const searching = !!round && ['queued', 'running'].includes(round.status);
  useEffect(() => {
    if (!session || !searching) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await api<ShoppingSession>(`/sessions/${session.id}`);
        if (!cancelled) { setSession(current => current && current.id === next.id && next.version >= current.version ? next : current); setError(''); }
      } catch (e) { if (!cancelled) setError((e as Error).message); }
    }, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session?.id, searching]);
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); return true; } catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  async function ensureSession() {
    if (session) return session;
    const created = await api<ShoppingSession>('/sessions', 'POST'); accept(created); return created;
  }
  const send = (phase: 'ask' | 'configure', message: string) => perform(async () => {
    const current = await ensureSession();
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
  async function navigate(next: Stage) {
    if (busy || searching || next === stage) return;
    if (stage === 'configure' && draft && session && JSON.stringify(draft) !== JSON.stringify(session.config)) {
      if (!await perform(async () => { accept(await api<ShoppingSession>(`/sessions/${session.id}/configure`, 'PUT', draft), false); })) return;
    }
    if (session) {
      await perform(async () => { accept(await api<ShoppingSession>(`/sessions/${session.id}/stage`, 'PATCH', { stage: next })); setNotice(''); });
    } else { setStage(next); setNotice(''); }
  }
  const products = session ? activeProducts(session) : [];
  const visibleProducts = products.map(product => ({
    product, ranked: (round?.ranking?.ranked ?? []).filter(r => product.offers.some(o => o.id === r.offerId)),
  })).filter(p => p.ranked.length).sort((a, b) => a.ranked[0].rank - b.ranked[0].rank);
  const selected = products.find(p => p.id === session?.selectedProductId);
  const stale = !!round && !!session && JSON.stringify(round.context.config) !== JSON.stringify(session.config);
  const unavailable = busy || searching;
  return <div className="app-shell">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><a className="brand" href="/" aria-label="FairBuy home"><span className="brand-icon" aria-hidden="true">◇</span>fairbuy<span className="brand-dot">.</span></a>
      <div className="header-right"><span className="header-tagline">Buy less on impulse. More on purpose.</span><button className="text-button new-search" disabled={unavailable || !session} onClick={() => { void perform(async () => {
        if (session) await api(`/sessions/${session.id}`, 'DELETE');
        setSession(null); setDraft(null); setStage('ask'); setNotice('');
      }); }}>New search <span aria-hidden="true">↗</span></button></div></header>
    {boot?.mode === 'demo' && <div className="mode-banner" role="note"><strong>Scripted preview</strong><span>Fictional products, prices and sellers. No live AI or current offers.{!boot.persistent && ' Changes are lost when the server restarts.'}</span></div>}
    <nav className="progress" aria-label="Shopping steps"><ol>{([
      ['ask', '01', 'Ask'], ['configure', '02', 'Configure'], ['discovery', '03', 'Discovery'], ['buy', '04', 'Buy'],
    ] as const).map(([key, number, label]) => <li key={key} className={stage === key ? 'current' : ''}>
      <button aria-current={stage === key ? 'step' : undefined} disabled={unavailable || (key === 'configure' && !session?.ready) || (key === 'discovery' && !session?.rounds.length) || (key === 'buy' && !selected)} onClick={() => { void navigate(key); }}><span className="step-number">{number}</span>{label}</button>
      {key === 'discovery' && <><span className="learn-arrow" aria-hidden="true">↔</span><button className={`learn-nav ${learning ? 'active' : ''}`} disabled={unavailable || !session?.rounds.length} onClick={() => setLearning({ product: null })}>Learn</button></>}
    </li>)}</ol><span className="progress-note">A more considered kind of shopping.</span></nav>
    <main id="main">
      <div className="page-heading"><div><div className="eyebrow">{stage === 'ask' ? 'YOUR AI SHOPPING COMPANION' : stage === 'configure' ? 'GOOD DETAILS. BETTER DISCOVERIES.' : stage === 'discovery' ? 'CURATED AROUND YOU' : 'THE FINAL SAY IS YOURS'}</div>
        <h1 ref={heading} tabIndex={-1}>{titles[stage][0]}<br /><em>{titles[stage][1]}</em></h1></div>
        <p className="heading-aside">{stage === 'ask' ? 'Not a wall of products. A conversation that leads to the right ones.' : stage === 'configure' ? 'Fine-tune what matters. We’ll take it from here.' : stage === 'discovery' ? 'Explore, react, refine. Your feedback makes the next search smarter.' : 'Real information. Clear trade-offs. Your decision.'}</p>
      </div>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {!boot && <div className="panel loading-state" role="status">{error ? <button className="button secondary" onClick={() => { void load(); }}>Reconnect</button> : <><span className="spinner" />Getting things ready…</>}</div>}
      {boot?.accessRequired && <form className="access-panel panel" onSubmit={event => { event.preventDefault(); void perform(async () => { await api('/access', 'POST', { token: accessToken }); setAccessToken(''); await load(); }); }}>
        <span className="eyebrow">A PRIVATE SHOPPING SPACE</span><h2>Welcome to FairBuy.</h2><p className="muted">Enter the access token from this deployment’s Render environment to continue.</p><label htmlFor="access-token">Deployment access token</label><input type="password" autoComplete="current-password" id="access-token" value={accessToken} onChange={e => setAccessToken(e.target.value)} /><button className="button primary" disabled={busy || !accessToken}>Let’s begin →</button>
      </form>}
      {boot && !boot.accessRequired && <>
        {!boot.aiConfigured && <div className="notice"><span aria-hidden="true">ⓘ</span><p>The app is ready for setup. Add <code>MODEL_API_KEY</code> in Render to enable Ask, Configure and web discovery. Your key never goes to the browser.</p></div>}
        {stage === 'ask' && <><div className="ask-layout"><div><Chat messages={session?.askMessages ?? []} busy={busy} onSend={message => send('ask', message)} disabled={!boot.aiConfigured} />
          <div className="ask-bottom"><p className="micro">Just the details we need. No payment information. No exact address.</p><button className="button primary" disabled={!session?.ready || unavailable} onClick={() => { void navigate('configure'); }}>Continue to Configure <span aria-hidden="true">→</span></button></div></div><Brief session={session} /></div>
          <div className="principles"><div><span>01 / UNDERSTAND</span><h3>Your needs come first.</h3><p>We ask before we recommend.</p></div><div><span>02 / EXPLAIN</span><h3>No mystery recommendations.</h3><p>Sources, trade-offs and unknowns stay visible.</p></div><div><span>03 / RESPECT</span><h3>You make the call.</h3><p>No auto-checkouts. No pressure.</p></div></div></>}
        {stage === 'configure' && draft && session && <div className="configure-layout"><Configure config={draft} onChange={setDraft} onSearch={() => { void findProducts(); }} busy={busy} /><div className="configure-aside"><Chat compact messages={session.configureMessages} busy={busy} onSend={message => send('configure', message)} disabled={!boot.aiConfigured} /><p className="aside-note">Your brief is a starting point, not a box. You can keep refining it after seeing products.</p>{!!session.feedback.length && <div className="panel"><h3>Also learned along the way</h3>{session.feedback.map(f => <p className="micro" key={f.id}>{f.reason}</p>)}</div>}</div></div>}
        {stage === 'discovery' && session && <section aria-label="Product discovery">
          <div className="discovery-toolbar"><div><span className="status-dot" /><strong>{searching ? 'Finding your next good fit' : `${visibleProducts.length} options worth a closer look`}</strong><span className="micro">{session.config.category} · {session.config.country} · search {round?.number ?? 0}</span></div><div className="toolbar-actions"><button className="text-button" disabled={unavailable} onClick={() => { void navigate('configure'); }}>Edit brief</button><button className="button secondary" disabled={unavailable} onClick={() => { void perform(async () => accept(await api<ShoppingSession>(`/sessions/${session.id}/discovery`, 'POST'))); }}>Refresh search ↻</button></div></div>
          {notice && <div className="success-banner" role="status">✓ {notice}</div>}
          {stale && !searching && <div className="notice"><p>Your brief changed. These results reflect the previous configuration. Refresh search before choosing a product.</p></div>}
          {searching && <div className="search-progress panel" role="status"><span className="spinner large" /><div><h2>{round?.status === 'queued' ? 'Your research is queued.' : 'Looking beyond the obvious.'}</h2><p className="muted">{round?.status === 'queued' ? 'A fresh discovery session will begin shortly.' : 'Searching the web, reading sources, and checking your requirements. This can take a minute or two.'}</p><p className="micro">Context carried forward: {round?.context.previousProducts.length ?? 0} previous products · {round?.context.discardedProducts.length ?? 0} discarded · {session.feedback.length} feedback entries</p></div></div>}
          {round?.status === 'failed' && <div className="error-banner" role="alert"><p>{round.error} Your brief and feedback are saved. Use Refresh search to retry.</p></div>}
          {round?.status === 'complete' && <>
            <p className="research-summary">{round.summary}</p>
            {boot.mode === 'live' && <p className="evidence-disclaimer">AI-extracted web evidence, not independently verified. Search snippets may be stale; unknown charges are never assumed to be zero.</p>}
            {(round.ranking?.warnings ?? []).map((w, i) => <p className="micro ranking-warning" key={i}>{w}</p>)}
            <div className="product-grid">{visibleProducts.map(({ product, ranked }, i) => <ProductCard key={product.id} product={product} ranked={ranked} index={i} busy={unavailable || stale}
              onLearn={() => setLearning({ product })} onSelect={() => { void perform(async () => accept(await api<ShoppingSession>(`/sessions/${session.id}/select`, 'POST', { productId: product.id }))); }} />)}</div>
            {!visibleProducts.length && <div className="empty-state panel"><span aria-hidden="true">◌</span><h2>No grounded matches this time.</h2><p>Try relaxing a must-have, adding context, or broadening your budget. We won’t invent an offer just to fill the page.</p><button className="button secondary" onClick={() => { void navigate('configure'); }}>Review my brief →</button></div>}
            {!!round.ranking?.excluded.length && <details className="panel exclusions"><summary>Why {round.ranking.excluded.length} offers were excluded</summary><ul>{round.ranking.excluded.map(ex => { const offer = round.products.flatMap(p => p.offers).find(o => o.id === ex.offerId); return <li key={ex.offerId}><strong>{offer?.title} · {offer?.seller}</strong>: {ex.reasons.join('; ')}</li>; })}</ul></details>}
            {!!round.sources.length && <details className="panel sources"><summary>All research sources ({round.sources.length})</summary><ul>{round.sources.map(s => <li key={s.url}><a href={s.url} rel="noopener noreferrer" target="_blank">{s.title} ↗</a></li>)}</ul></details>}
            <div className="learn-callout"><div><span className="eyebrow">A LITTLE CLOSER, EVERY TIME</span><h2>Something not quite right?</h2><p>Tell us what you’ve learned. We’ll start a fresh search, not forget the last one.</p></div><button className="button secondary" disabled={unavailable} onClick={() => setLearning({ product: null })}>Refine with feedback ↻</button></div>
          </>}
          {!!session.feedback.length && <details className="panel feedback-history" open><summary>What we’ve learned ({session.feedback.length})</summary><ul>{session.feedback.map(f => <li key={f.id}><div><strong>{f.productName ? `Not for you: ${f.productName}` : 'A new detail'}</strong><p>{f.reason}</p></div><button className="text-button" disabled={unavailable} onClick={() => { void perform(async () => { accept(await api<ShoppingSession>(`/sessions/${session.id}/learn/${f.id}`, 'DELETE')); setNotice('Feedback removed. A fresh search will restore eligible options.'); }); }}>Undo</button></li>)}</ul></details>}
        </section>}
        {stage === 'buy' && selected && session && <Buy product={selected} session={session} onBack={() => { void navigate('discovery'); }} />}
      </>}
    </main>
    <footer className="site-footer"><div className="footer-signoff"><span className="brand">fairbuy<span className="brand-dot">.</span></span><p>Choose the best purchase.<br />Not just the lowest price.</p></div><details><summary>Privacy & how it works</summary><p>Anonymous searches are isolated by an HttpOnly browser cookie, not a login. Search data expires after 7 days. “New search” deletes the current search and history. Clearing cookies loses access; there is no cross-device recovery. Live requests and research are sent to Meta Model API and, if selected, Brave. Response storage is disabled; provider retention policies still apply. Never share sensitive information or payment details.</p><p>FairBuy researches and explains; it does not certify products, guarantee prices, or complete transactions.</p></details><span className="footer-meta">Made for more considered choices.</span></footer>
    {learning && session && <LearnModal product={learning.product} busy={busy} error={error} onClose={() => setLearning(null)} onApply={reason => perform(async () => {
      accept(await api<ShoppingSession>(`/sessions/${session.id}/learn`, 'POST', { productId: learning.product?.id ?? null, reason })); setNotice('Feedback saved. Fresh search, with everything we’ve learned.');
    })} />}
  </div>;
}
