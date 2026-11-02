import { describe, expect, it } from 'vitest';
import { AskQuestionSchema, formatQuestionAnswer } from './shopping';

const condition = {
  prompt: 'What condition are you open to?',
  options: [
    { id: 'new', label: 'New only' },
    { id: 'used', label: 'Used is fine' },
    { id: 'refurbished', label: 'Refurbished is fine' },
  ],
  multiSelect: false,
  allowFreeText: true,
};

describe('Ask structured questions (issue #17)', () => {
  it('accepts a bounded single-select question and defaults free text on', () => {
    expect(AskQuestionSchema.parse(condition)).toEqual(condition);
    expect(AskQuestionSchema.parse({ ...condition, allowFreeText: undefined }).allowFreeText).toBe(true);
  });

  it('accepts a multi-select question', () => {
    expect(AskQuestionSchema.safeParse({ ...condition, multiSelect: true }).success).toBe(true);
  });

  it.each([false, true])('rejects duplicate option ids when multiSelect=%s', multiSelect => {
    expect(AskQuestionSchema.safeParse({
      ...condition, multiSelect,
      options: [{ id: 'same', label: 'New only' }, { id: 'same', label: 'Used is fine' }],
    }).success).toBe(false);
  });

  it('rejects empty prompts, fewer than two options, too many options, and oversized labels', () => {
    const invalid = [
      { ...condition, prompt: '' },
      { ...condition, options: [condition.options[0]] },
      { ...condition, options: [...condition.options, ...condition.options, ...condition.options].slice(0, 7) },
      { ...condition, options: [{ id: 'new', label: 'x'.repeat(161) }, condition.options[1]] },
      { ...condition, options: [{ id: '', label: 'New' }, condition.options[1]] },
    ];
    for (const input of invalid) expect(AskQuestionSchema.safeParse(input).success).toBe(false);
  });

  it('formats selected labels and free text exactly like a typed answer', () => {
    expect(formatQuestionAnswer(condition.options, ['new'], '')).toBe('New only');
    expect(formatQuestionAnswer(condition.options, ['new', 'used'], '')).toBe('New only, Used is fine');
    expect(formatQuestionAnswer(condition.options, [], 'Open box is fine')).toBe('Open box is fine');
    expect(formatQuestionAnswer(condition.options, ['refurbished'], '  must arrive by Friday  ')).toBe('Refurbished is fine — must arrive by Friday');
    expect(formatQuestionAnswer(condition.options, ['missing-id'], '')).toBe('');
  });
});
