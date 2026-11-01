import { useEffect, useState } from 'react';
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
  const requirements = preview.result?.requirements ?? [];
  if (!preview.pending && !requirements.length) return null;
  return (
    <div className="instant-classifier" aria-label="Instant classifier">
      {preview.pending ? (
        <Dots />
      ) : (
        <ul className="instant-classifier-chips">
          {requirements.map((requirement, index) => (
            <li key={index} title={`From your text: “${requirement.evidence}”`}>
              {requirement.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
