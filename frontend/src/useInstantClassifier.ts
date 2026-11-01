import { useEffect, useRef, useState } from 'react';
import { InstantClassificationSchema, type InstantClassification } from '@fairbuy/core';
import { api } from './api';

interface Preview { text: string; result: InstantClassification | null; pending: boolean; unavailable: boolean }
const empty: Preview = { text: '', result: null, pending: false, unavailable: false };
export function useInstantClassifier(draft: string, enabled: boolean) {
  const text = draft.trim();
  const [preview, setPreview] = useState<Preview>(empty);
  const sequence = useRef(0);
  const resumeAt = useRef(0);
  useEffect(() => {
    const current = ++sequence.current;
    if (!enabled || text.length < 3) { setPreview(empty); return; }
    if (Date.now() < resumeAt.current) { setPreview({ text, result: null, pending: false, unavailable: true }); return; }
    const controller = new AbortController();
    setPreview({ text, result: null, pending: true, unavailable: false });
    const timer = setTimeout(() => {
      void api<unknown>('/instant-classifier', 'POST', { text }, controller.signal).then(value => {
        const result = InstantClassificationSchema.parse(value);
        if (current === sequence.current && !controller.signal.aborted) setPreview({ text, result, pending: false, unavailable: false });
      }).catch(() => {
        if (current !== sequence.current || controller.signal.aborted) return;
        // Don't hammer an exhausted allowance or retry failed drafts automatically.
        resumeAt.current = Date.now() + 60000;
        setPreview({ text, result: null, pending: false, unavailable: true });
      });
    }, 600);
    return () => { clearTimeout(timer); controller.abort(); sequence.current++; };
  }, [text, enabled]);
  // Hide old hints synchronously, before the effect for a changed draft runs.
  return enabled && preview.text === text && text.length >= 3 ? preview : empty;
}
