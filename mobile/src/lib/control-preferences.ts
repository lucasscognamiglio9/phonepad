import { Buffer } from 'buffer';
import { File, Paths } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
export type ControlPreferences = { mode: 'direct' | 'trackpad'; gain: number; cursorScale: number };
export const CONTROL_RANGES = { gain: { min: .5, max: 4 }, cursorScale: { min: .5, max: 1.5 } } as const;
type PreferenceKey = keyof typeof CONTROL_RANGES;
// A shared adjustment scale: 50 is minimum, 100 is the standard midpoint,
// and 150 is maximum. Keep stored physical values unchanged across versions.
export function controlPercentage(key: PreferenceKey, value: number) {
 const range = CONTROL_RANGES[key];
 return 50 + 100 * (value - range.min) / (range.max - range.min);
}
export function controlValue(key: PreferenceKey, percentage: number) {
 const range = CONTROL_RANGES[key];
 return range.min + (Math.min(150, Math.max(50, percentage)) - 50) / 100 * (range.max - range.min);
}
export const DEFAULT_CONTROL_PREFERENCES: ControlPreferences = { mode: 'trackpad', gain: controlValue('gain',100), cursorScale: controlValue('cursorScale',100) };
export function parseControlPreferences(value: unknown): ControlPreferences {
 const v = value as Partial<ControlPreferences> | null;
 return { mode: v?.mode === 'direct' ? 'direct' : 'trackpad', gain: typeof v?.gain === 'number' && Number.isFinite(v.gain) ? Math.min(CONTROL_RANGES.gain.max, Math.max(CONTROL_RANGES.gain.min, v.gain)) : DEFAULT_CONTROL_PREFERENCES.gain, cursorScale: typeof v?.cursorScale === 'number' && Number.isFinite(v.cursorScale) ? Math.min(CONTROL_RANGES.cursorScale.max, Math.max(CONTROL_RANGES.cursorScale.min, v.cursorScale)) : DEFAULT_CONTROL_PREFERENCES.cursorScale };
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
