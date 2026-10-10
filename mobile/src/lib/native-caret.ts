import type { ArrowKey } from './control-layout';

// iOS's Space trackpad navigates UITextInput positions, including newlines.
// Supply local, non-deliverable context only when the actual draft is empty.
// The explicit line width stays below the narrowest supported editor width.
export const CARET_COLUMNS = 20;
export const CARET_ROWS = 9;
export const CARET_CONTEXT = Array(CARET_ROWS).fill(' '.repeat(CARET_COLUMNS)).join('\n');
export const CARET_ORIGIN = Math.floor(CARET_ROWS / 2) * (CARET_COLUMNS + 1) + Math.floor(CARET_COLUMNS / 2);
export type CaretSelection = { start: number; end: number };

export function caretMovement(previous: number, next: CaretSelection): ArrowKey[] {
  if (!Number.isInteger(previous) || previous < 0 || previous > CARET_CONTEXT.length || next.start !== next.end || !Number.isInteger(next.start) || next.start < 0 || next.start > CARET_CONTEXT.length) return [];
  const delta = next.start - previous;
  // Moving one character across a newline stays one horizontal action.
  if (Math.abs(delta) <= CARET_COLUMNS / 2) return Array<ArrowKey>(Math.abs(delta)).fill(delta < 0 ? 'ArrowLeft' : 'ArrowRight');
  const stride = CARET_COLUMNS + 1;
  const rows = Math.floor(next.start / stride) - Math.floor(previous / stride);
  const columns = next.start % stride - previous % stride;
  // Ignore invalid/unbounded callbacks rather than enqueue a burst of remote keys.
  if (Math.abs(rows) > 4 || Math.abs(columns) > CARET_COLUMNS) return [];
  return [
    ...Array<ArrowKey>(Math.abs(rows)).fill(rows < 0 ? 'ArrowUp' : 'ArrowDown'),
    ...Array<ArrowKey>(Math.abs(columns)).fill(columns < 0 ? 'ArrowLeft' : 'ArrowRight'),
  ];
}

/** Extract only the inserted user text, never the virtual navigation context. */
export function caretInsertion(text: string): string {
  let start = 0;
  while (start < CARET_CONTEXT.length && start < text.length && CARET_CONTEXT[start] === text[start]) start++;
  let oldEnd = CARET_CONTEXT.length, newEnd = text.length;
  while (oldEnd > start && newEnd > start && CARET_CONTEXT[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
  return text.slice(start, newEnd);
}

export function caretAtBoundary(position: number) {
  const column = position % (CARET_COLUMNS + 1);
  return position <= CARET_COLUMNS || position >= CARET_CONTEXT.length - CARET_COLUMNS || column === 0 || column === CARET_COLUMNS;
}
