import type { Connection } from './connection';
import { primaryModifier } from './control-layout';

// A verified rejection means no text was inserted. Never paste a second time
// after a lost receipt, a dispatch, or an uncertain result.
export async function deliverText(connection: Connection, text: string): Promise<{state: string}> {
  // The host owns insertion and any temporary clipboard lease. Permanent
  // clipboard transfer is a separate, explicit action.
  if (!connection.canInput) return {state: 'rejected'};
  return connection.literal.send(text);
}

export async function pasteToHost(connection: Connection): Promise<'executed' | 'rejected' | 'uncertain'> {
  const epoch = connection.capabilities?.sessionEpoch;
  if (!epoch || !connection.canInput || !connection.canClipboard) return 'rejected';
  const operation = connection.pressAction({t:'k',a:'combo',mods:[primaryModifier(connection.capabilities?.hostPlatform)],key:'v'});
  if (!operation) return 'rejected';
  let result;
  try { result = await connection.waitFinalActionReceipt(operation); } catch { return 'uncertain'; }
  if (epoch !== connection.capabilities?.sessionEpoch || !result || result.replayed) return 'uncertain';
  if (result.state === 'executed') return 'executed';
  return result.state === 'rejected' || result.state === 'cancelled' ? 'rejected' : 'uncertain';
}
