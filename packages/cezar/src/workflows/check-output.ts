/**
 * Bounded capture of a check step's output.
 *
 * Test runners (pytest, Django, tsc, vitest) print the verdict — the failing names and the summary
 * line — at the END, so keeping only the first N chars handed the fixer agent a page of progress
 * dots and none of what failed. This keeps the head (the command's own banner, early errors) and
 * the tail (the summary), and drops the middle with a marker that says how much went missing.
 *
 * Memory stays bounded while streaming: the tail is trimmed back to `tailCap` whenever it grows
 * past twice that, so a check that prints gigabytes holds at most ~3× `tailCap` chars at once.
 * Output whose total fits in `headCap + tailCap` is returned exactly as received.
 */
export const CHECK_OUTPUT_HEAD = 4_000;
export const CHECK_OUTPUT_TAIL = 16_000;

export interface CheckOutputCollector {
  push(text: string): void;
  text(): string;
}

export function createCheckOutputCollector(headCap = CHECK_OUTPUT_HEAD, tailCap = CHECK_OUTPUT_TAIL): CheckOutputCollector {
  let head = '';
  let tail = '';
  let total = 0;
  return {
    push(text) {
      total += text.length;
      if (head.length < headCap) {
        const room = headCap - head.length;
        head += text.slice(0, room);
        text = text.slice(room);
      }
      if (!text) return;
      tail += text;
      if (tail.length > tailCap * 2) tail = tail.slice(-tailCap);
    },
    text() {
      if (total <= headCap + tailCap) return head + tail;
      const dropped = total - headCap - tailCap;
      return `${head}\n… (${dropped} chars truncated) …\n${tail.slice(-tailCap)}`;
    },
  };
}
