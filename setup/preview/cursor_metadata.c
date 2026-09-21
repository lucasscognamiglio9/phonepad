/* Read cursor metadata only. Desktop pixels are never mapped or copied. */
#include <pipewire/pipewire.h>
#include <spa/param/video/format-utils.h>
#include <spa/buffer/meta.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <unistd.h>
#define MAX_SIDE 256
#define META_SIZE (sizeof(struct spa_meta_cursor)+sizeof(struct spa_meta_bitmap)+MAX_SIDE*MAX_SIDE*4)
struct reader { struct pw_main_loop *loop; struct pw_stream *stream; uint64_t bitmap_hash; int ready; };
static void quit(void *p, int sig) { (void)sig; pw_main_loop_quit(((struct reader*)p)->loop); }
static void changed(void *p, uint32_t id, const struct spa_pod *param) {
 struct reader *r=p; if(id!=SPA_PARAM_Format || !param) return;
 uint8_t space[1024]; struct spa_pod_builder b=SPA_POD_BUILDER_INIT(space,sizeof(space));
 const struct spa_pod *params[2];
 params[0]=spa_pod_builder_add_object(&b,SPA_TYPE_OBJECT_ParamBuffers,SPA_PARAM_Buffers,
  SPA_PARAM_BUFFERS_buffers,SPA_POD_CHOICE_RANGE_Int(4,2,8),
  SPA_PARAM_BUFFERS_dataType,SPA_POD_CHOICE_FLAGS_Int((1<<SPA_DATA_DmaBuf)|(1<<SPA_DATA_MemFd)));
 params[1]=spa_pod_builder_add_object(&b,SPA_TYPE_OBJECT_ParamMeta,SPA_PARAM_Meta,
  SPA_PARAM_META_type,SPA_POD_Id(SPA_META_Cursor),SPA_PARAM_META_size,SPA_POD_Int(META_SIZE));
 pw_stream_update_params(r->stream,params,2);
}
static void process(void *p) {
 struct reader *r=p;struct pw_buffer *b;
 while((b=pw_stream_dequeue_buffer(r->stream))) {
  struct spa_meta *m=spa_buffer_find_meta(b->buffer,SPA_META_Cursor);
  if(!m || m->size<sizeof(struct spa_meta_cursor)) {pw_stream_queue_buffer(r->stream,b);continue;}
  struct spa_meta_cursor *c=m->data;
  if(!r->ready) {puts("{\"ready\":true}");r->ready=1;}
  /* Invalid metadata is not an update; preserve the last known cursor. */
  if(!c->id){pw_stream_queue_buffer(r->stream,b);continue;}
  printf("{\"x\":%d,\"y\":%d",c->position.x,c->position.y);
  if(c->bitmap_offset>=sizeof(*c) && c->bitmap_offset<=m->size-sizeof(struct spa_meta_bitmap)) {
   struct spa_meta_bitmap *bm=SPA_PTROFF(c,c->bitmap_offset,struct spa_meta_bitmap);
   size_t remain=m->size-c->bitmap_offset;
   if(bm->format && !bm->offset) printf(",\"visible\":false");
   else if(bm->offset>=sizeof(*bm) && bm->offset<=remain && bm->size.width>0 && bm->size.height>0 && bm->size.width<=MAX_SIDE && bm->size.height<=MAX_SIDE && bm->stride>=(int)bm->size.width*4 && (size_t)bm->stride*bm->size.height<=remain-bm->offset) {
    const unsigned char *pixels=SPA_PTROFF(bm,bm->offset,const unsigned char);
    int bgra=bm->format==SPA_VIDEO_FORMAT_BGRA, rgba=bm->format==SPA_VIDEO_FORMAT_RGBA;
    if(bgra || rgba) {
     uint64_t hash=1469598103934665603ULL;
     for(uint32_t y=0;y<bm->size.height;y++)for(uint32_t x=0;x<bm->size.width*4;x++)hash=(hash^pixels[y*bm->stride+x])*1099511628211ULL;
     hash^=((uint64_t)bm->size.width<<32)|bm->size.height;
     printf(",\"visible\":true,\"hx\":%d,\"hy\":%d",c->hotspot.x,c->hotspot.y);
     if(hash!=r->bitmap_hash) {
      r->bitmap_hash=hash;
      printf(",\"w\":%u,\"h\":%u,\"rgba\":\"",bm->size.width,bm->size.height);
      for(uint32_t y=0;y<bm->size.height;y++)for(uint32_t x=0;x<bm->size.width;x++) {
       const unsigned char *v=pixels+y*bm->stride+x*4;
       printf("%02x%02x%02x%02x",v[bgra?2:0],v[1],v[bgra?0:2],v[3]);
      }
      printf("\"");
     }
    } else printf(",\"unsupported\":true");
   }
  }
  puts("}");fflush(stdout);pw_stream_queue_buffer(r->stream,b);
 }
}
static void state(void *p,enum pw_stream_state old,enum pw_stream_state now,const char *error) {
 (void)old; if(now==PW_STREAM_STATE_ERROR){fprintf(stderr,"cursor: %s\n",error?error:"stream error");pw_main_loop_quit(((struct reader*)p)->loop);}
}
static const struct pw_stream_events events={PW_VERSION_STREAM_EVENTS,.state_changed=state,.param_changed=changed,.process=process};
int main(int argc,char **argv) {
 if(argc!=3)return 2;
 prctl(PR_SET_PDEATHSIG,SIGTERM);if(getppid()==1)return 1;
 setvbuf(stdout,NULL,_IOLBF,0);pw_init(&argc,&argv);struct reader r={0};r.loop=pw_main_loop_new(NULL);
 pw_loop_add_signal(pw_main_loop_get_loop(r.loop),SIGTERM,quit,&r);pw_loop_add_signal(pw_main_loop_get_loop(r.loop),SIGINT,quit,&r);
 r.stream=pw_stream_new_simple(pw_main_loop_get_loop(r.loop),"PhonePad cursor metadata",
  pw_properties_new(PW_KEY_MEDIA_TYPE,"Video",PW_KEY_MEDIA_CATEGORY,"Capture",NULL),&events,&r);
 uint8_t space[1024];struct spa_pod_builder b=SPA_POD_BUILDER_INIT(space,sizeof(space));
 struct spa_video_info_raw info={.format=SPA_VIDEO_FORMAT_BGRA,.size=SPA_RECTANGLE(1920,1080),.framerate=SPA_FRACTION(0,1),.max_framerate=SPA_FRACTION(120,1),.flags=SPA_VIDEO_FLAG_MODIFIER,.modifier=strtoull(argv[2],NULL,0)};
 const struct spa_pod *format=spa_format_video_raw_build(&b,SPA_PARAM_EnumFormat,&info);
 /* No MAP_BUFFERS: only PipeWire's small metadata is read, never video data. */
 int result=pw_stream_connect(r.stream,PW_DIRECTION_INPUT,(uint32_t)strtoul(argv[1],NULL,10),PW_STREAM_FLAG_AUTOCONNECT,&format,1);
 if(result>=0)pw_main_loop_run(r.loop);
 pw_stream_destroy(r.stream);pw_main_loop_destroy(r.loop);pw_deinit();return result<0 || !r.ready;
}
