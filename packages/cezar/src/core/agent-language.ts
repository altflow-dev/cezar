import type { WorkspaceUiState } from '@open-mercato/cezar-contract';
import { readWorkspaceUiState } from '../workspace/ui-state.ts';

/**
 * The language agents speak to the user in — the cockpit's own language, mirrored into
 * `~/.cezar/ui-state.json` (`language`) by the cockpit, so it is discovered, never configured.
 *
 * Workflow, skill and handoff prompts are written in English, so without a word on language an
 * agent drifts between the task's language and the prompt's: a Polish task got Polish answers on
 * one step and English questions on the next. English is the default and adds NOTHING to the
 * prompt — the zero-config path is byte-identical to what it was.
 *
 * Only what the agent says to the PERSON is pinned. Code, identifiers, commands and commit
 * messages stay in the repository's own conventions: a Polish cockpit is not a request to
 * rewrite an English codebase.
 */
const LANGUAGE_PROMPTS: Partial<Record<NonNullable<WorkspaceUiState['language']>, string>> = {
  pl: `## Language (cezar)
Always communicate with the user in Polish. Every reply, summary, progress update, review comment,
handoff summary and every question you ask the user must be written in Polish, even when the task,
a skill, the workflow or these instructions are in English. That includes CEZ:ASK questions: write
each question, header, option label and option description in Polish (the JSON keys stay as
specified). Keep code, identifiers, file paths, shell commands, commit messages and code comments
in the repository's existing conventions.`,
};

/** The system-prompt part for a language, or `undefined` when none is needed (English, unset). */
export function agentLanguagePromptFor(language: unknown): string | undefined {
  return typeof language === 'string' && Object.hasOwn(LANGUAGE_PROMPTS, language)
    ? LANGUAGE_PROMPTS[language as keyof typeof LANGUAGE_PROMPTS]
    : undefined;
}

/** Read on demand, never cached, never throws: switching the cockpit language applies to the
 *  next agent session without a restart, and a missing/corrupt ui-state means "no instruction". */
export async function agentLanguagePrompt(): Promise<string | undefined> {
  return agentLanguagePromptFor((await readWorkspaceUiState()).language);
}
