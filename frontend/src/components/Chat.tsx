import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage } from '@fairbuy/core';
export default function Chat({ messages, busy, onSend, compact = false, disabled = false }: {
  messages: ChatMessage[]; busy: boolean; onSend: (message: string) => Promise<boolean>; compact?: boolean; disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [messages.length, busy]);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || busy || disabled) return;
    const sent = text.trim();
    if (await onSend(sent)) setText('');
  };
  return <section className={`chat ${compact ? 'chat--compact' : ''}`} aria-label={compact ? 'Configure assistant' : 'Ask assistant'}>
    <div className="chat-heading"><span className="spark" aria-hidden="true">✳</span><strong>{compact ? 'A little help, if you need it.' : 'Your shopping conversation'}</strong><span className="micro">{compact ? 'Configure assistant' : 'Ask assistant'}</span></div>
    <div className="chat-log" role="log" aria-label="Conversation" aria-live="polite">
      {!messages.length && <div className="chat-welcome">
        <p>{compact ? '“I need it to fit in my carry-on.”' : 'What are you looking for?'}</p>
        <span>{compact ? 'Add a detail in your own words. I’ll help update your brief.' : 'Tell me what you have in mind, what you’ll use it for, and anything that matters. We’ll figure out the details together.'}</span>
      </div>}
      {messages.map((message, i) => <div className={`message message--${message.role}`} key={i}>
        <span className="message-role">{message.role === 'user' ? 'You' : 'FairBuy'}</span><p>{message.content}</p>
      </div>)}
      {busy && <p className="thinking" role="status"><span className="spinner" aria-hidden="true" />Thinking about your request…</p>}
      <div ref={end} />
    </div>
    <form className="composer" onSubmit={event => { void send(event); }}>
      <label className="sr-only" htmlFor={compact ? 'configure-message' : 'ask-message'}>{compact ? 'Additional requirements' : 'Your message'}</label>
      <textarea id={compact ? 'configure-message' : 'ask-message'} value={text} maxLength={3000} rows={compact ? 3 : 3}
        placeholder={compact ? 'Tell me one more thing…' : 'e.g. A laptop for coding, around €700. I travel a lot.'}
        disabled={busy || disabled} onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <div className="composer-bottom"><span className="micro">Enter to send · Shift + Enter for a new line</span><button className="button primary" type="submit" disabled={busy || disabled || !text.trim()}>{compact ? 'Update brief' : 'Send message'} <span aria-hidden="true">↗</span></button></div>
    </form>
  </section>;
}
