import type { Connection } from './connection';
import { primaryModifier } from './control-layout';

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
