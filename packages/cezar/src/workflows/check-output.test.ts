import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { CHECK_OUTPUT_HEAD, CHECK_OUTPUT_TAIL, createCheckOutputCollector } from './check-output.ts';
import { RunManager } from './run.ts';

describe('createCheckOutputCollector', () => {
  it('returns output under the cap byte-identical, however it was chunked', () => {
    const text = 'é✓ line\n'.repeat(1_500).slice(0, CHECK_OUTPUT_HEAD + CHECK_OUTPUT_TAIL);
    for (const size of [1, 7, 4_000, 50_000]) {
      const collector = createCheckOutputCollector();
      for (let i = 0; i < text.length; i += size) collector.push(text.slice(i, i + size));
      expect(collector.text()).toBe(text);
    }
    expect(createCheckOutputCollector().text()).toBe('');
  });

  it('keeps the head and the tail of long output and says how much it dropped', () => {
    const collector = createCheckOutputCollector(10, 20);
    const text = `HEAD______${'x'.repeat(1_000)}${'y'.repeat(10)}FAILED 3 tests`;
    for (let i = 0; i < text.length; i += 13) collector.push(text.slice(i, i + 13));
    const dropped = text.length - 30;
    expect(collector.text()).toBe(`HEAD______\n… (${dropped} chars truncated) …\n${text.slice(-20)}`);
  });

  it('stays bounded while streaming far more than the cap', () => {
    const collector = createCheckOutputCollector(10, 20);
    for (let i = 0; i < 10_000; i++) collector.push('0123456789');
    collector.push('SUMMARY');
    expect(collector.text().endsWith('SUMMARY')).toBe(true);
    expect(collector.text().length).toBeLessThan(80);
  });
});

/** Through the real `runCheckStep`: both the streamed event and the `{{nodes.<id>.output}}` value. */
describe('RunManager check step output', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  type Seam = {
    runCheckStep(
      state: { cwd: string; interrupt?: () => void },
      step: { id: string; command: string },
      emit: (event: { type: string; [k: string]: unknown }) => void,
    ): Promise<{ ok: boolean; output: string; exitCode: number }>;
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-check-output-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const run = async (command: string) => {
    const events: { type: string; [k: string]: unknown }[] = [];
    const result = await (manager as unknown as Seam).runCheckStep({ cwd: repoRoot }, { id: 'check', command }, (e) => events.push(e));
    const event = events.find(e => e.type === 'check-output');
    return { result, eventText: event?.text as string };
  };

  it('keeps the failure summary a test runner prints at the end of long output', async () => {
    const { result, eventText } = await run(`for i in $(seq 1 5000); do echo "test_$i ... ok"; done; echo "FAILED (failures=2)"; exit 1`);
    expect(result.ok).toBe(false);
    expect(result.output.startsWith('test_1 ... ok')).toBe(true);
    expect(result.output).toMatch(/… \(\d+ chars truncated\) …/);
    expect(result.output.endsWith('FAILED (failures=2)')).toBe(true);
    expect(eventText).toBe(result.output);
  });

  it('passes short output through unchanged', async () => {
    const { result, eventText } = await run(`printf '  first\\nsecond  \\n\\n'`);
    expect(result).toEqual({ ok: true, output: 'first\nsecond', exitCode: 0 });
    expect(eventText).toBe('first\nsecond');
  });
});
