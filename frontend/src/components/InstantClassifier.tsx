import { useInstantClassifier } from '../useInstantClassifier';

export default function InstantClassifier({ text, enabled }: { text: string; enabled: boolean }) {
  const preview = useInstantClassifier(text, enabled);
  const result = preview.result;
  const chips: { label: string; evidence: string }[] = [];
  if (result?.category) chips.push({ label: result.category.value, evidence: result.category.evidence });
  if (result?.budget) {
    const budget = result.budget;
    chips.push({ label: `${budget.hard ? 'Budget ≤' : 'Budget around'} ${budget.currency ?? '(currency?)'} ${budget.amount.toLocaleString()}`, evidence: budget.evidence });
  }
  if (result?.condition) chips.push({ label: result.condition.value, evidence: result.condition.evidence });
  for (const requirement of result?.requirements ?? []) chips.push({ label: `${requirement.hard ? 'Must: ' : 'Prefer: '}${requirement.label}`, evidence: requirement.evidence });
  return <div className="instant-classifier" aria-label="Instant classifier">
    <div className="instant-classifier-heading"><strong>Instant classifier</strong><span className="micro">Draft only</span></div>
    <p className="micro">After a pause, your draft is sent to Cloudflare’s Meta Llama. Edit your message to correct hints; nothing is added to your brief until you send.</p>
    <div className="instant-classifier-result" role="status" aria-live="polite" aria-atomic="true">
      {preview.pending && <p className="micro">Reading your draft…</p>}
      {preview.unavailable && <p className="micro">Preview unavailable. You can still send your message.</p>}
      {!!chips.length && <ul className="instant-classifier-chips">{chips.map((chip, index) => <li key={index} title={`From your text: “${chip.evidence}”`}>{chip.label}</li>)}</ul>}
      {result?.clarification && <p className="instant-classifier-question">{result.clarification}</p>}
      {result && !chips.length && !result.clarification && <p className="micro">No clear shopping details yet. Send your message to explore together.</p>}
    </div>
  </div>;
}
