import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { previewPortsPath } from '../paths.ts';
import { allocatePorts, listAllocations, markEvicted, previewMax, previewPortRange, previewsHoldingPorts, releasePorts, takeEviction } from './ports.ts';

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CEZ_HOME;
  home = mkdtempSync(join(tmpdir(), 'cez-ports-'));
  process.env.CEZ_HOME = home;
});
afterEach(() => {
  process.env.CEZ_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const free = async () => true;
const range = { from: 41000, to: 41009 };

describe('preview port allocation', () => {
  it('gives two runs disjoint ports and records them workspace-wide', async () => {
    const a = await allocatePorts({ runId: 'a', composeProject: 'cez-p-a', count: 2, host: '127.0.0.1', range, probe: free });
    const b = await allocatePorts({ runId: 'b', composeProject: 'cez-q-b', count: 2, host: '127.0.0.1', range, probe: free });
    expect(a).toEqual([41000, 41001]);
    expect(b).toEqual([41002, 41003]);
    expect(listAllocations().map((x) => x.runId)).toEqual(['a', 'a', 'b', 'b']);
  });

  it('skips a port something else is listening on', async () => {
    const got = await allocatePorts({ runId: 'a', composeProject: 'p', count: 1, host: '127.0.0.1', range, probe: async (p) => p !== 41000 });
    expect(got).toEqual([41001]);
  });

  it('keeps a run\'s ports across a restart, so bookmarked URLs keep working', async () => {
    const first = await allocatePorts({ runId: 'a', composeProject: 'p', count: 2, host: '127.0.0.1', range, probe: free });
    const again = await allocatePorts({ runId: 'a', composeProject: 'p', count: 2, host: '127.0.0.1', range, probe: async () => false });
    expect(again).toEqual(first);
  });

  it('returns null when the range is full', async () => {
    expect(await allocatePorts({ runId: 'a', composeProject: 'p', count: 11, host: '127.0.0.1', range, probe: free })).toBeNull();
  });

  it('frees ports on release (idempotent)', async () => {
    await allocatePorts({ runId: 'a', composeProject: 'p', count: 2, host: '127.0.0.1', range, probe: free });
    releasePorts('a');
    releasePorts('a');
    expect(listAllocations()).toEqual([]);
    expect(await allocatePorts({ runId: 'b', composeProject: 'p', count: 1, host: '127.0.0.1', range, probe: free })).toEqual([41000]);
  });

  it('treats a corrupt ledger as empty instead of failing', async () => {
    writeFileSync(previewPortsPath(), '{not json');
    expect(listAllocations()).toEqual([]);
    expect(await allocatePorts({ runId: 'a', composeProject: 'p', count: 1, host: '127.0.0.1', range, probe: free })).toEqual([41000]);
  });

  it('reads CEZ_PREVIEW_PORTS, and falls back to the default on a malformed value', () => {
    expect(previewPortRange({ CEZ_PREVIEW_PORTS: '50000-50010' })).toEqual({ from: 50000, to: 50010 });
    expect(previewPortRange({ CEZ_PREVIEW_PORTS: '50010-50000' })).toEqual({ from: 41000, to: 41999 });
    expect(previewPortRange({ CEZ_PREVIEW_PORTS: 'lots' })).toEqual({ from: 41000, to: 41999 });
    expect(previewPortRange({})).toEqual({ from: 41000, to: 41999 });
  });
});

describe('the preview limit ledger', () => {
  it('lists one entry per preview, oldest first', async () => {
    await allocatePorts({ runId: 'b', composeProject: 'pb', count: 2, host: 'h', range, probe: free, now: () => '2026-01-02' })
    await allocatePorts({ runId: 'a', composeProject: 'pa', count: 1, host: 'h', range, probe: free, now: () => '2026-01-01' })
    expect(previewsHoldingPorts().map((p) => p.runId)).toEqual(['a', 'b'])
  })

  it('an eviction mark is taken exactly once', () => {
    markEvicted('x')
    expect(takeEviction('x')).toBe(true)
    expect(takeEviction('x')).toBe(false)
    expect(takeEviction('never')).toBe(false)
  })

  it('reads CEZ_PREVIEW_MAX, defaulting to 4', () => {
    expect(previewMax({})).toBe(4)
    expect(previewMax({ CEZ_PREVIEW_MAX: '2' })).toBe(2)
    expect(previewMax({ CEZ_PREVIEW_MAX: '0' })).toBe(4)
    expect(previewMax({ CEZ_PREVIEW_MAX: 'many' })).toBe(4)
  })
})
