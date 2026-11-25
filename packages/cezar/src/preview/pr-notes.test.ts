import { describe, expect, it } from 'vitest';
import { buildPrBody, previewNotesSection } from '../server/forge/github.ts';

describe('test notes in the draft PR body (spec 2026-11-24-preview-environments)', () => {
  const notes = '## What changed\n- Invoices paginate\n\n## What to check\n- [ ] Log in as admin@example.com / admin123 and open /invoices';

  it('nests the notes under one Testing heading and masks the seeded passwords', () => {
    const section = previewNotesSection(notes, ['admin123']);
    expect(section).toMatch(/^## Testing\n\n### What changed/);
    expect(section).toContain('### What to check');
    expect(section).toContain('admin@example.com / •••');
    expect(section).not.toContain('admin123');
  });

  it('is empty without notes, and the body is then unchanged', () => {
    expect(previewNotesSection(undefined)).toBe('');
    expect(buildPrBody('', 'the task', '')).toBe(buildPrBody('', 'the task'));
  });

  it('sits before the cezar footer', () => {
    const body = buildPrBody('', 'the task', previewNotesSection(notes, []));
    expect(body.indexOf('## Testing')).toBeGreaterThan(body.indexOf('## Goal'));
    expect(body.indexOf('## Testing')).toBeLessThan(body.indexOf('made with cezar'));
  });
});
