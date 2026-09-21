export type TouchContact = { id: number; x: number; y: number };

export type ActionPhase = 'press' | 'repeat';
export type ActionCommand =
  | { t: 'k'; a: 'special'; key: string; operationId: string; phase: ActionPhase; actionSequence: number }
  | { t: 'k'; a: 'combo'; key: string; mods: string[]; operationId: string; phase: ActionPhase; actionSequence: number }
  | { t: 'k'; a: 'cancel'; operationId: string; phase: 'cancel' };

export type Command =
  | { t: 'm' | 's'; dx: number; dy: number }
  | { t: 'b'; btn: 'l' | 'r'; a: 'down' | 'up' }
  | { t: 'k'; a: 'text'; text: string }
  | { t: 'k'; a: 'special'; key: string }
  | { t: 'k'; a: 'combo'; key: string; mods: string[] }
  | ActionCommand
  | { t: 'g'; name: 'overview' | 'apps' }
  | { t: 't'; c: TouchContact[]; cancel?: false }
  | { t: 't'; c: []; cancel: true }
  | { t: 'ping' };

export type ActionReceiptState = 'executed' | 'admitted' | 'rejected' | 'uncertain' | 'cancelled';
export type ActionReceiptPhase = 'press' | 'repeat' | 'cancel';
export type ActionReceipt = {
  t: 'receipt'; operationId: string; phase: ActionReceiptPhase; state: ActionReceiptState;
  repeatCount: number; replayed?: boolean; detail?: string; sessionEpoch?: string;
};

export function parseActionReceipt(value: unknown): ActionReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (r.t !== 'receipt' || typeof r.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.operationId)
    || (r.phase !== 'press' && r.phase !== 'repeat' && r.phase !== 'cancel')
    || (r.state !== 'executed' && r.state !== 'admitted' && r.state !== 'rejected'
      && r.state !== 'uncertain' && r.state !== 'cancelled')
    || !Number.isInteger(r.repeatCount) || (r.repeatCount as number) < 0) return null;
  if (r.replayed !== undefined && typeof r.replayed !== 'boolean') return null;
  if (r.detail !== undefined && (typeof r.detail !== 'string' || !/^[a-z_]{1,96}$/.test(r.detail))) return null;
  if (r.sessionEpoch !== undefined && (typeof r.sessionEpoch !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(r.sessionEpoch))) return null;
  return {
    t: 'receipt', operationId: r.operationId, phase: r.phase, state: r.state,
    repeatCount: r.repeatCount, ...(r.replayed === undefined ? {} : { replayed: r.replayed }),
    ...(r.detail === undefined ? {} : { detail: r.detail }),
    ...(r.sessionEpoch === undefined ? {} : { sessionEpoch: r.sessionEpoch }),
  } as ActionReceipt;
}

// Preserve native dictation/autocorrection: reconcile the complete text change.
export function textCommands(previous: string, next: string): Command[] {
  const before = Array.from(previous), after = Array.from(next);
  let common = 0;
  while (common < before.length && before[common] === after[common]) common++;
  const commands: Command[] = before.slice(common).map(() => ({ t: 'k', a: 'special', key: 'Backspace' }));
  // Phone Return adds a line in chat composers. Never pass a bare newline to
  // the Linux text injector, where it becomes an unmodified Enter (submit).
  const lines = after.slice(common).join('').split(/\r\n|\r|\n/);
  lines.forEach((line, index) => {
    if (index) commands.push({ t: 'k', a: 'combo', mods: ['shift'], key: 'Enter' });
    if (line) commands.push({ t: 'k', a: 'text', text: line });
  });
  return commands;
}
