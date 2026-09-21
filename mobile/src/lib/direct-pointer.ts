import type { Command } from './protocol';
export function directPoint(x: number, y: number, width: number, height: number, videoWidth: number, videoHeight: number, scale = 1, offsetX = 0, offsetY = 0) {
 'worklet';
 if (![x,y,width,height,videoWidth,videoHeight,scale,offsetX,offsetY].every(Number.isFinite) || Math.min(width,height,videoWidth,videoHeight,scale)<=0) return null;
 const fit = Math.min(width/videoWidth, height/videoHeight), w = videoWidth*fit, h=videoHeight*fit;
 const localX=(x-width/2-offsetX)/scale+width/2, localY=(y-height/2-offsetY)/scale+height/2;
 const nx=(localX-(width-w)/2)/w, ny=(localY-(height-h)/2)/h;
 if(nx<0||nx>1||ny<0||ny>1)return null;
 return {x:Math.round(nx*65535),y:Math.round(ny*65535),logicalX:x,logicalY:y};
}
type DirectPoint = {x:number;y:number;logicalX?:number;logicalY?:number};
const DIRECT_DRAG_SLOP_POINTS = 6;
const DIRECT_HOLD_MS = 500;
// Defer click until classification: tap on release, movement drags, hold opens
// the context menu. Adding a finger never commits a pending left click.
export class DirectPointerSequence {
 private pressed=false;
 private multi=false;
 private moved=false;
 private held=false;
 private start: DirectPoint|null=null;
 private last: DirectPoint|null=null;
 private hold?: ReturnType<typeof setTimeout>;
 constructor(private send:(command:Command)=>boolean){}
 frame(points: DirectPoint[]) {
  if(!points.length){
   this.clearHold();
   if(this.pressed)this.release();
   else if(!this.moved&&!this.held&&(this.start||this.multi))this.click(this.multi?'r':'l');
   this.reset();return;
  }
  if(points.length>1){
   this.clearHold();this.release();this.multi=true;
   const center={x:(points[0].x+points[1].x)/2,y:(points[0].y+points[1].y)/2};
   if(this.last){const dx=Math.round((center.x-this.last.x)/256),dy=Math.round((center.y-this.last.y)/256);if(dx||dy){this.moved=true;this.send({t:'s',dx:Math.max(-1000,Math.min(1000,-dx)),dy:Math.max(-1000,Math.min(1000,-dy))});}}
   this.last=center;return;
  }
  if(this.multi||this.held)return;
  const p=points[0];
  if(!this.start){
   this.start=p;
   this.send({t:'p',dx:p.x,dy:p.y});
   this.hold=setTimeout(()=>{this.hold=undefined;if(this.start&&!this.multi&&!this.moved){this.held=true;this.click('r');}},DIRECT_HOLD_MS);
   return;
  }
  const distance=p.logicalX!==undefined&&this.start.logicalX!==undefined
   ?Math.hypot(p.logicalX-this.start.logicalX,(p.logicalY??0)-(this.start.logicalY??0))
   :Math.hypot(p.x-this.start.x,p.y-this.start.y)/65535*1000;
  if(!this.moved&&distance>=DIRECT_DRAG_SLOP_POINTS){
   this.moved=true;this.clearHold();
   this.send({t:'p',dx:this.start.x,dy:this.start.y});
   this.pressed=this.send({t:'b',btn:'l',a:'down'});
  }
  if(this.moved)this.send({t:'p',dx:p.x,dy:p.y});
 }
 cancel(){this.clearHold();this.release();this.reset();}
 private click(btn:'l'|'r'){if(this.send({t:'b',btn,a:'down'}))this.send({t:'b',btn,a:'up'});}
 private clearHold(){clearTimeout(this.hold);this.hold=undefined;}
 private release(){if(this.pressed)this.send({t:'b',btn:'l',a:'up'});this.pressed=false;}
 private reset(){this.multi=false;this.moved=false;this.held=false;this.start=null;this.last=null;}
}
