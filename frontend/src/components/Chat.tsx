import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { formatQuestionAnswer, type AskQuestion, type ChatMessage } from '@fairbuy/core';
import InstantClassifier from './InstantClassifier';

function AskQuestionCard({ question, answered, busy, disabled, onSend, onAnswered }: {
  question: AskQuestion; answered: boolean; busy: boolean; disabled: boolean;
  onSend: (message: string) => Promise<boolean>; onAnswered: () => void;
}) {
  const group = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const active = !answered && !busy && !disabled && !submitting;
  const answer = formatQuestionAnswer(question.options, selected, other);
  const toggle = (id: string) => setSelected(current =>
    question.multiSelect ? (current.includes(id) ? current.filter(value => value !== id) : [...current, id]) : [id]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!active || !answer) return;
    setSubmitting(true);
    try {
      if (await onSend(answer)) { setSelected([]); setOther(''); onAnswered(); }
    } finally { setSubmitting(false); }
  };
  return <form className={`ask-question${answered ? ' ask-question--answered' : ''}`} onSubmit={event => { void submit(event); }}>
    <fieldset disabled={!active}>
      <legend>{question.prompt}</legend>
      <div className="ask-question-options">
        {question.options.map(option => <label className="ask-question-option" key={option.id}>
          <input type={question.multiSelect ? 'checkbox' : 'radio'} name={group} value={option.id}
            checked={selected.includes(option.id)} onChange={() => toggle(option.id)} disabled={!active} />
          <span>{option.label}</span>
        </label>)}
      </div>
      <label className="ask-question-other">Other <span className="optional">(optional)</span>
        <input type="text" value={other} maxLength={500} placeholder="Type a different answer"
          disabled={!active} onChange={event => setOther(event.target.value)} />
      </label>
      {!answered && <div className="ask-question-actions">
        <button className="button primary" type="submit" disabled={!active || !answer}>{submitting ? 'Sending…' : 'Send answer'}</button>
        <span className="micro">Or ignore these options and type a message below.</span>
      </div>}
    </fieldset>
  </form>;
}

export default function Chat({ messages, busy, onSend, compact = false, disabled = false, instantClassifier = false }: {
  messages: ChatMessage[]; busy: boolean; onSend: (message: string) => Promise<boolean>; compact?: boolean; disabled?: boolean; instantClassifier?: boolean;
}) {
  const [text, setText] = useState('');
  const [composing, setComposing] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [restoreFocus, setRestoreFocus] = useState(false);
  useEffect(() => {
    // Focus only after React has committed the enabled composer. An animation
    // frame can run before that commit and silently focus a disabled textarea.
    if (!restoreFocus || busy || disabled) return;
    composer.current?.focus();
    setRestoreFocus(false);
  }, [restoreFocus, busy, disabled]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [messages.length, busy]);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || busy || disabled) return;
    const sent = text.trim();
    if (await onSend(sent)) setText('');
  };
  return <section className={`chat ${compact ? 'chat--compact' : ''}`} aria-label={compact ? 'Configure assistant' : 'Ask assistant'}>
    {compact && <div className="chat-heading"><span className="spark" aria-hidden="true">✳</span><strong>A little help, if you need it.</strong><span className="micro">Configure assistant</span></div>}
    <div className="chat-log" role="log" aria-label="Conversation" aria-live="polite">
      {!messages.length && <div className="chat-welcome">
        <p>{compact ? '“I need it to fit in my carry-on.”' : 'What are you looking for?'}</p>
        <span>{compact ? 'Add a detail in your own words. I’ll help update your brief.' : 'Tell me what you have in mind, what you’ll use it for, and anything that matters. We’ll figure out the details together.'}</span>
      </div>}
      {messages.map((message, i) => <div className={`message message--${message.role}`} key={i}>
        <span className="message-role">{message.role === 'user' ? 'You' : 'FairBuy'}</span><p>{message.content}</p>
        {message.role === 'assistant' && message.question && <AskQuestionCard question={message.question}
          answered={messages.slice(i + 1).some(later => later.role === 'user')} busy={busy} disabled={disabled}
          onSend={onSend} onAnswered={() => setRestoreFocus(true)} />}
      </div>)}
      {busy && <p className="thinking" role="status"><span className="spinner" aria-hidden="true" />Thinking about your request…</p>}
      <div ref={end} />
    </div>
    <form className="composer" onSubmit={event => { void send(event); }}>
      <label className="sr-only" htmlFor={compact ? 'configure-message' : 'ask-message'}>{compact ? 'Additional requirements' : 'Your message'}</label>
      <textarea ref={composer} id={compact ? 'configure-message' : 'ask-message'} value={text} maxLength={3000} rows={compact ? 3 : 3}
        placeholder={compact ? 'Tell me one more thing…' : 'e.g. A laptop for coding, around €700. I travel a lot.'}
        disabled={busy || disabled} onChange={event => setText(event.target.value)}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <div className="composer-bottom">
        {instantClassifier && <div className="instant-classifier-slot"><InstantClassifier text={text} enabled={!busy && !disabled && !composing} /></div>}
        <button className="button primary" type="submit" disabled={busy || disabled || !text.trim()}>{compact ? 'Update brief' : 'Send message'} <span aria-hidden="true">↗</span></button>
      </div>
    </form>
  </section>;
}
