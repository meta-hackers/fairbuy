import { useEffect, useState } from 'react';
import { instantHints } from '@fairbuy/core';
import { useInstantClassifier } from '../useInstantClassifier';

const FRAMES = ['.', '..', '...'];

function Dots() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 400);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="instant-classifier-dots" role="status" aria-label="Analysing your message">
      <span aria-hidden="true">{FRAMES[frame]}</span>
    </span>
  );
}

export default function InstantClassifier({ text, enabled }: { text: string; enabled: boolean }) {
  const preview = useInstantClassifier(text, enabled);
  if (!enabled || text.trim().length < 3) return null;
  const hints = preview.result ? instantHints(preview.result) : [];
  const question = preview.result?.clarification ?? null;
  if (!preview.pending && !hints.length && !question) return null;
  return (
    <div className="instant-classifier" aria-label="Instant classifier">
      {preview.pending ? (
        <Dots />
      ) : (
        <>
          {!!hints.length && <ul className="instant-classifier-chips">
            {hints.map((hint, index) => (
              <li key={index} title={`From your text: “${hint.evidence}”`}>
                <span className="instant-classifier-kind">{hint.kind}</span> {hint.text}
              </li>
            ))}
          </ul>}
          {question && <p className="instant-classifier-question">{question}</p>}
        </>
      )}
    </div>
  );
}
