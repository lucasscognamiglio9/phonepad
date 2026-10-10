export const CURSOR_POINTS = 28;
export type CursorState = { visible: boolean; x: number; y: number; hx: number; hy: number; w: number; h: number; sourceWidth: number; sourceHeight: number; imageId: string; image: string; capturedAtUs?: number };

type CursorShape = Pick<CursorState, 'imageId' | 'image' | 'w' | 'h' | 'hx' | 'hy'>;

/** One receiver per peer. Shape delivery never holds up position delivery. */
export class CursorReceiver {
  private sequence = -1;
  private shapes = new Map<string, CursorShape>();
  private lastShape: CursorShape | null = null;
  private current: CursorState | null = null;

  private shape(m: CursorState): CursorShape | null {
    if (!/^[0-9a-f]{16}$/.test(m.imageId)
      || ![m.hx, m.hy, m.w, m.h].every(Number.isFinite)
      || m.w < 1 || m.h < 1 || m.w > 256 || m.h > 256
      || m.hx < 0 || m.hy < 0 || m.hx > m.w || m.hy > m.h
      || typeof m.image !== 'string' || m.image.length > 60000
      || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(m.image)) return null;
    return {imageId: m.imageId, image: m.image, w: m.w, h: m.h, hx: m.hx, hy: m.hy};
  }

  private remember(shape: CursorShape) {
    this.shapes.delete(shape.imageId);
    this.shapes.set(shape.imageId, shape);
    if (this.shapes.size > 4) this.shapes.delete(this.shapes.keys().next().value!);
  }

  private visible(): CursorState | null {
    const current = this.current;
    if (!current || !current.visible) return current;
    const exact = this.shapes.get(current.imageId);
    if (exact) this.lastShape = {...exact, w: current.w, h: current.h, hx: current.hx, hy: current.hy};
    // Keep the last confirmed shape during a lost/delayed shape change. Its
    // own dimensions/hotspot stay together; only the real position advances.
    const shape = this.lastShape;
    return shape ? {...current, ...shape} : {...current, visible: false, image: ''};
  }

  accept(text: unknown): CursorState | null {
    if (typeof text !== 'string' || text.length > 65536) return null;
    try {
      const m = JSON.parse(text);
      if (m.t === 'cursor-image' && m.version === 2) {
        const shape = this.shape(m);
        if (!shape) return null;
        this.remember(shape);
        return this.current?.visible && this.current.imageId === shape.imageId ? this.visible() : null;
      }
      if (m.t !== 'cursor' || (m.version !== 1 && m.version !== 2)
        || !Number.isSafeInteger(m.sequence) || m.sequence <= this.sequence
        || typeof m.visible !== 'boolean') return null;
      if (![m.sourceWidth, m.sourceHeight].every(v => Number.isInteger(v) && v > 0 && v <= 16384)) return null;
      const clock = Number.isSafeInteger(m.capturedAtUs) && m.capturedAtUs > 0 ? {capturedAtUs:m.capturedAtUs} : {};
      if (!m.visible) {
        this.sequence = m.sequence;
        this.current = {visible:false,x:0,y:0,hx:0,hy:0,w:1,h:1,sourceWidth:m.sourceWidth,sourceHeight:m.sourceHeight,imageId:'',image:'',...clock};
        return this.current;
      }
      if (![m.x,m.y,m.hx,m.hy,m.w,m.h].every(Number.isFinite)
        || m.w<1 || m.h<1 || m.w>256 || m.h>256 || m.hx<0 || m.hy<0
        || m.hx>m.w || m.hy>m.h || Math.abs(m.x)>32768 || Math.abs(m.y)>32768
        || !/^[0-9a-f]{16}$/.test(m.imageId)) return null;
      if (m.image !== undefined) {
        const shape = this.shape(m);
        if (!shape || m.version !== 1) return null;
        this.remember(shape);
      }
      this.sequence = m.sequence;
      this.current = {visible:true,x:m.x,y:m.y,hx:m.hx,hy:m.hy,w:m.w,h:m.h,sourceWidth:m.sourceWidth,sourceHeight:m.sourceHeight,imageId:m.imageId,image:'',...clock};
      return this.visible();
    } catch { return null; }
  }
}

/** Interpolate confirmed positions on the UI clock, with a bounded delay. */
export function cursorTransitionMs(previous: CursorState | null, next: CursorState | null, elapsed: number) {
  if (!previous?.visible || !next?.visible || previous.sourceWidth !== next.sourceWidth
    || previous.sourceHeight !== next.sourceHeight) return 0;
  return Math.max(8, Math.min(48, Number.isFinite(elapsed) ? elapsed : 16));
}

/** Transform only the hotspot position. Bitmap dimensions remain in UI points. */
export function cursorPlacement(cursor: CursorState | null, width: number, height: number, scale=1, panX=0, panY=0, points?: number) {
  'worklet';
  if (!cursor?.visible || !cursor.image || width<=0 || height<=0) return {opacity:0,left:0,top:0,width:1,height:1};
  const fit=Math.min(width/cursor.sourceWidth,height/cursor.sourceHeight);
  // Resolve captured defaults inside the worklet, after its closure is restored.
  const size=(points ?? CURSOR_POINTS)/Math.max(cursor.w,cursor.h);
  const x=width/2+(cursor.x-cursor.sourceWidth/2)*fit*scale+panX;
  const y=height/2+(cursor.y-cursor.sourceHeight/2)*fit*scale+panY;
  return {opacity:cursor.x>=0&&cursor.y>=0&&cursor.x<cursor.sourceWidth&&cursor.y<cursor.sourceHeight?1:0,left:x-cursor.hx*size,top:y-cursor.hy*size,width:cursor.w*size,height:cursor.h*size};
}

/** Cursor movement bypasses React reconciliation and the video component. */
export class CursorFeed {
  current: CursorState | null = null;
  private listeners = new Set<(cursor: CursorState | null) => void>();
  publish = (cursor: CursorState | null) => {
    this.current = cursor;
    for (const listener of this.listeners) listener(cursor);
  };
  subscribe(listener: (cursor: CursorState | null) => void) {
    this.listeners.add(listener); listener(this.current);
    return () => { this.listeners.delete(listener); };
  }
}
