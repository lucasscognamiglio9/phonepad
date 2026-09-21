import { Buffer } from 'buffer';
import { File, Paths } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
export type ControlPreferences = { mode: 'direct' | 'trackpad'; gain: number };
export const DEFAULT_CONTROL_PREFERENCES: ControlPreferences = { mode: 'trackpad', gain: 1 };
export function parseControlPreferences(value: unknown): ControlPreferences {
 const v = value as Partial<ControlPreferences> | null;
 return { mode: v?.mode === 'direct' ? 'direct' : 'trackpad', gain: typeof v?.gain === 'number' && Number.isFinite(v.gain) ? Math.min(2, Math.max(.5, v.gain)) : 1 };
}
function settingsFile(origin: string, slot: string) {
 return new File(Paths.document, `.phonepad-controls-${bytesToHex(sha256(Buffer.from(origin, 'utf8')))}-${slot}.json`);
}
function journal(origin: string) {
 return ['a','b'].flatMap(slot => {
  try { const f=settingsFile(origin,slot); if(!f.exists)return []; const v=JSON.parse(f.textSync());
   if(v.version!==1||!Number.isSafeInteger(v.revision)||v.revision<1)return [];
   return [{slot,revision:v.revision,preferences:parseControlPreferences(v)}];
  } catch {return [];}
 }).sort((a,b)=>b.revision-a.revision);
}
export function loadControlPreferences(origin: string): ControlPreferences {
 return journal(origin)[0]?.preferences ?? { ...DEFAULT_CONTROL_PREFERENCES };
}
export function saveControlPreferences(origin: string, value: ControlPreferences) {
 const current=journal(origin)[0], revision=(current?.revision??0)+1;
 if(!Number.isSafeInteger(revision))throw Error('Revisión agotada');
 settingsFile(origin,current?.slot==='a'?'b':'a').write(JSON.stringify({version:1,revision,...parseControlPreferences(value)}));
}
