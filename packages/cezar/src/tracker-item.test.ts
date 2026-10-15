import { describe, expect, it } from 'vitest';
import { draftPrTitle, trackerItemIssue, withTicketLink, withTicketPrefix } from './tracker-item.ts';

const item = { kind: 'youtrack' as const, id: 'TERM-396', url: 'https://altflow.youtrack.cloud/issue/TERM-396', title: 'Fix the export' };
const association = {
  kind: 'youtrack' as const,
  source: { id: 'src', webUrl: 'https://altflow.youtrack.cloud' },
  externalId: '0-1',
  externalName: 'AltFlowMetrics',
};

describe('withTicketPrefix', () => {
  it('prefixes once and leaves text that already opens with the id', () => {
    expect(withTicketPrefix('cezar autosave (pre-PR)', 'TERM-396')).toBe('[TERM-396] cezar autosave (pre-PR)');
    expect(withTicketPrefix('[TERM-396] done', 'TERM-396')).toBe('[TERM-396] done');
    expect(withTicketPrefix('TERM-396: done', 'TERM-396')).toBe('TERM-396: done');
    expect(withTicketPrefix('TERM-396 done', 'TERM-396')).toBe('TERM-396 done');
  });

  it('does not mistake a longer id for this one', () => {
    expect(withTicketPrefix('TERM-3961 done', 'TERM-396')).toBe('[TERM-396] TERM-3961 done');
  });

  it('is the identity without a ticket', () => {
    expect(withTicketPrefix('anything', undefined)).toBe('anything');
  });
});

describe('draftPrTitle', () => {
  it('keeps the pre-ticket behavior for a task with no ticket', () => {
    expect(draftPrTitle({ title: 'Run title' })).toBe('Run title');
    expect(draftPrTitle({ title: 'Run title' }, 'Node title')).toBe('Node title');
  });

  it('opens with [ID] and defaults to the ticket summary', () => {
    expect(draftPrTitle({ title: 'Work on tracker ticket [TERM-396]: Fix the export', trackerItem: item })).toBe('[TERM-396] Fix the export');
  });

  it('prefers an explicit title, then the user rename, then the run title', () => {
    expect(draftPrTitle({ title: 'x', trackerItem: item }, 'Node title')).toBe('[TERM-396] Node title');
    expect(draftPrTitle({ title: 'Renamed', titleOrigin: 'user', trackerItem: item })).toBe('[TERM-396] Renamed');
    expect(draftPrTitle({ title: 'Run title', trackerItem: { ...item, title: undefined } })).toBe('[TERM-396] Run title');
  });
});

describe('withTicketLink', () => {
  it('puts the ticket link on top, and only for a ticket task', () => {
    expect(withTicketLink('## Goal', item)).toBe(`YouTrack: [TERM-396](${item.url})\n\n## Goal`);
    expect(withTicketLink('## Goal', undefined)).toBe('## Goal');
  });
});

describe('trackerItemIssue', () => {
  it('accepts a ticket on the associated YouTrack instance', () => {
    expect(trackerItemIssue(item, association)).toBeNull();
  });

  it('rejects a missing, other-kind or other-instance association', () => {
    expect(trackerItemIssue(item, null)).toMatch(/no youtrack tracker/);
    expect(trackerItemIssue(item, { ...association, kind: 'jira' })).toMatch(/no youtrack tracker/);
    expect(trackerItemIssue(item, { ...association, source: { id: 'src', webUrl: 'https://other.youtrack.cloud' } })).toMatch(/not on the associated/);
  });
});
