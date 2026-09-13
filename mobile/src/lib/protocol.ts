export type TouchContact = { id: number; x: number; y: number };

export type Command =
  | { t: 'm' | 's'; dx: number; dy: number }
  | { t: 'b'; btn: 'l' | 'r'; a: 'down' | 'up' }
  | { t: 'k'; a: 'text'; text: string }
  | { t: 'k'; a: 'special'; key: string }
  | { t: 'k'; a: 'combo'; key: string; mods: string[] }
  | { t: 'g'; name: 'overview' | 'apps' }
  | { t: 't'; c: TouchContact[]; cancel?: false }
  | { t: 't'; c: []; cancel: true }
  | { t: 'ping' };

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
