export const CURSOR_POINTS = 28;
export type CursorState = { visible: boolean; x: number; y: number; hx: number; hy: number; w: number; h: number; sourceWidth: number; sourceHeight: number; imageId: string; image: string };

/** One receiver per video session. No cursor prediction or remote input. */
export class CursorReceiver {
  private sequence = -1;
  private imageId = '';
  private image = '';
  accept(text: unknown): CursorState | null {
    if (typeof text !== 'string' || text.length > 65536) return null;
    try {
      const m = JSON.parse(text);
      if (m.t !== 'cursor' || m.version !== 1 || !Number.isSafeInteger(m.sequence) || m.sequence <= this.sequence || typeof m.visible !== 'boolean') return null;
      if (![m.sourceWidth,m.sourceHeight].every(v => Number.isInteger(v) && v > 0 && v <= 16384)) return null;
      if (!m.visible) { this.sequence=m.sequence; return { visible:false,x:0,y:0,hx:0,hy:0,w:1,h:1,sourceWidth:m.sourceWidth,sourceHeight:m.sourceHeight,imageId:'',image:'' }; }
      if (![m.x,m.y,m.hx,m.hy,m.w,m.h].every(Number.isFinite) || m.w<1 || m.h<1 || m.w>256 || m.h>256 || m.hx<0 || m.hy<0 || m.hx>m.w || m.hy>m.h || Math.abs(m.x)>32768 || Math.abs(m.y)>32768 || !/^[0-9a-f]{16}$/.test(m.imageId)) return null;
      if (m.image !== undefined) {
        if (typeof m.image !== 'string' || m.image.length>60000 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(m.image)) return null;
        this.image=m.image;this.imageId=m.imageId;
      }
      this.sequence=m.sequence;
      return {visible:this.imageId===m.imageId,x:m.x,y:m.y,hx:m.hx,hy:m.hy,w:m.w,h:m.h,sourceWidth:m.sourceWidth,sourceHeight:m.sourceHeight,imageId:m.imageId,image:this.imageId===m.imageId?this.image:''};
    } catch { return null; }
  }
}

/** Transform only the hotspot position. Bitmap dimensions remain in UI points. */
export function cursorPlacement(cursor: CursorState | null, width: number, height: number, scale=1, panX=0, panY=0, points=CURSOR_POINTS) {
  'worklet';
  if (!cursor?.visible || !cursor.image || width<=0 || height<=0) return {opacity:0,left:0,top:0,width:1,height:1};
  const fit=Math.min(width/cursor.sourceWidth,height/cursor.sourceHeight);
  const size=points/Math.max(cursor.w,cursor.h);
  const x=width/2+(cursor.x-cursor.sourceWidth/2)*fit*scale+panX;
  const y=height/2+(cursor.y-cursor.sourceHeight/2)*fit*scale+panY;
  return {opacity:cursor.x>=0&&cursor.y>=0&&cursor.x<cursor.sourceWidth&&cursor.y<cursor.sourceHeight?1:0,left:x-cursor.hx*size,top:y-cursor.hy*size,width:cursor.w*size,height:cursor.h*size};
}
