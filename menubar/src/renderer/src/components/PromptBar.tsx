// PromptBar.tsx — Text input that writes to the PTY as if typed + Enter.
// Supports multi-line (Shift+Enter) and command history (↑/↓).

import { useState, useRef, useCallback, type KeyboardEvent } from 'react';

interface Props {
  onSubmit: (text: string) => void;
}

export default function PromptBar({ onSubmit }: Props): JSX.Element {
  const [value,   setValue]   = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = useCallback((): void => {
    const text = value.trim();
    if (!text) return;
    onSubmit(text);
    setHistory((h) => [text, ...h].slice(0, 200));
    setHistIdx(-1);
    setValue('');
    // Auto-resize back to 1 row
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [value, onSubmit]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'ArrowUp' && value === '') {
      e.preventDefault();
      const next = Math.min(histIdx + 1, history.length - 1);
      if (next >= 0) { setHistIdx(next); setValue(history[next]); }
      return;
    }
    if (e.key === 'ArrowDown' && histIdx >= 0) {
      e.preventDefault();
      const next = histIdx - 1;
      if (next < 0) { setHistIdx(-1); setValue(''); }
      else          { setHistIdx(next); setValue(history[next]); }
    }
  };

  // Auto-grow textarea height
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setValue(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 100)}px`;
  };

  return (
    <div className="prompt-bar">
      <span className="prompt-chevron">›</span>
      <textarea
        ref={textareaRef}
        className="prompt-input"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Prompt or command… (Enter to send, Shift+Enter for newline)"
        rows={1}
        spellCheck={false}
      />
      <button
        className="prompt-send"
        onClick={submit}
        disabled={!value.trim()}
        title="Send (Enter)"
      >
        ⏎
      </button>
    </div>
  );
}
