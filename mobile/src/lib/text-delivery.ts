import type { Connection } from './connection';
import { offerTextToHostClipboard } from './clipboard-transfer';
import { primaryModifier } from './control-layout';

// A verified rejection means no text was inserted. Never paste a second time
// after a lost receipt, a dispatch, or an uncertain result.
export async function deliverText(connection: Connection, text: string): Promise<{state: string}> {
  const epoch = connection.capabilities?.sessionEpoch;
  if (connection.inputCapabilities?.preferredDelivery === 'clipboard-paste' && connection.canClipboard && connection.canInput) {
    if (connection.literal.pending || connection.literal.busy) throw Error('Revisá el envío anterior antes de continuar.');
    return clipboardText(connection, text, epoch);
  }
  const receipt = await connection.literal.send(text);
  if (receipt.state !== 'rejected' || !connection.canClipboard || !connection.canInput) return receipt;
  connection.literal.acknowledged();
  return clipboardText(connection, text, epoch);
}

async function clipboardText(connection: Connection, text: string, epoch: string | null | undefined): Promise<{state:string}> {
  await offerTextToHostClipboard(connection, text, new AbortController().signal);
  if (!epoch || epoch !== connection.capabilities?.sessionEpoch || !connection.canInput) return {state: 'rejected'};
  const result = await pasteToHost(connection);
  return {state: result === 'executed' ? 'dispatched' : result};
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
