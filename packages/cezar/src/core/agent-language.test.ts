import { describe, expect, it } from 'vitest';
import { agentLanguagePromptFor } from './agent-language.ts';

describe('agentLanguagePromptFor', () => {
  it('pins Polish for replies and questions, but not code or commits', () => {
    const part = agentLanguagePromptFor('pl');
    expect(part).toContain('in Polish');
    expect(part).toContain('CEZ:ASK');
    expect(part).toContain('commit messages');
  });

  it.each([['en'], [undefined], [''], ['de'], ['toString'], [42]])(
    'adds nothing for %s — the default path stays byte-identical',
    (language) => {
      expect(agentLanguagePromptFor(language)).toBeUndefined();
    },
  );
});
