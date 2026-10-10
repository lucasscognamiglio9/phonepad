/* A real-time PipeWire source must be live during the first caps negotiation.
 * PipeWire can answer that query before it has parsed stream properties.
 * VA encoders then choose buffered (recording) output instead of live output.
 * Use public GStreamer APIs; preserve the source's reported latency bounds.
 */
#include <gst/gst.h>
#include <gst/base/gstbasesrc.h>

static GstPadProbeReturn
mark_live(GstPad *pad, GstPadProbeInfo *info, gpointer data)
{
    (void)pad;
    GstQuery *query = GST_PAD_PROBE_INFO_QUERY(info);
    if (GST_QUERY_TYPE(query) != GST_QUERY_LATENCY)
        return GST_PAD_PROBE_OK;
    GstBaseSrc *source = GST_BASE_SRC(data);
    GstBaseSrcClass *klass = GST_BASE_SRC_GET_CLASS(source);
    GstQuery *upstream = gst_query_new_latency();
    gboolean live;
    GstClockTime minimum = 0, maximum = GST_CLOCK_TIME_NONE;
    /* Calling the source vfunc avoids re-entering the pad's own probe. */
    if (klass->query && klass->query(source, upstream))
        gst_query_parse_latency(upstream, &live, &minimum, &maximum);
    gst_query_unref(upstream);
    gst_query_set_latency(query, TRUE, minimum, maximum);
    return GST_PAD_PROBE_HANDLED;
}

/* The owner removes this probe before destroying its capture pipeline. */
gulong phonepad_mark_live_capture(GstElement *capture)
{
    if (!GST_IS_BASE_SRC(capture))
        return 0;
    GstPad *pad = gst_element_get_static_pad(capture, "src");
    if (!pad)
        return 0;
    gulong id = gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_QUERY_UPSTREAM,
                                mark_live, capture, NULL);
    gst_object_unref(pad);
    return id;
}
