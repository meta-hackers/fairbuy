import { useEffect, useRef, useState } from 'react';
import type { Product } from '@fairbuy/core';
export default function LearnModal({ product, busy, error, onClose, onApply }: {
  product: Product | null; busy: boolean; error: string; onClose: () => void; onApply: (reason: string) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState(''); const [chip, setChip] = useState('');
  const text = [chip, reason.trim()].filter(Boolean).join('. ');
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
  return <dialog className="learn-modal" ref={dialog} aria-labelledby="learn-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="modal-top"><span className="eyebrow">DISCOVERY ↔ LEARN</span><button className="icon-button" aria-label="Close feedback" disabled={busy} onClick={onClose}>×</button></div>
    <div className="learn-symbol" aria-hidden="true">↻</div><h2 id="learn-title">Every “not quite” gets us closer.</h2>
    <p className="muted">{product ? `What doesn’t feel right about ${product.name}?` : 'What else have you learned about what you want?'}</p>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="feedback-chips">{['I’d like to spend less', 'I need something more portable', 'Missing a feature I need'].map(label => <button className="chip" key={label} aria-pressed={chip === label} disabled={busy} onClick={() => setChip(chip === label ? '' : label)}>{label}</button>)}</div>
    <form onSubmit={async event => { event.preventDefault(); if (text && !busy && await onApply(text)) onClose(); }}>
      <label htmlFor="feedback-reason">Tell us a little more <span className="optional">{chip ? 'optional' : 'or choose a reason above'}</span></label>
      <textarea id="feedback-reason" autoFocus rows={4} maxLength={1500} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} placeholder="e.g. I cycle to work, so it needs to weigh less than 1.5 kg." />
      <div className="learn-note"><span aria-hidden="true">✳</span><p>A fresh AI search will keep your original brief, earlier products, discarded options, and all your feedback.{product && ' This product will leave your shortlist.'}</p></div>
      <div className="modal-actions"><button type="button" className="text-button" disabled={busy} onClick={onClose}>Keep exploring</button><button className="button primary" disabled={busy || !text.trim()}>{busy ? 'Learning…' : 'Apply & search again'} <span aria-hidden="true">↗</span></button></div>
    </form>
  </dialog>;
}
