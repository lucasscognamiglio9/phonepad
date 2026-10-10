#!/usr/bin/env bash
# Ubuntu amd64: isolated runtime, no sudo and no global library replacement.
set -euo pipefail
video_dir=$HOME/.local/lib/phonepad/video
mkdir -p "$video_dir/packages" "$video_dir/plugins" "$HOME/.config/phonepad"
cd "$video_dir/packages"
apt-get download gstreamer1.0-vaapi gstreamer1.0-plugins-bad libgstreamer-plugins-bad1.0-0 intel-media-va-driver-non-free libigdgmm12 libva-x11-2 libva-glx2 libva-wayland2 libnice10 gstreamer1.0-nice libsrtp2-1 libgupnp-igd-1.6-0 gir1.2-gst-plugins-base-1.0 gir1.2-gst-plugins-bad-1.0
for package in ./*.deb; do dpkg-deb -x "$package" "$video_dir/runtime"; done
cp "$video_dir/runtime/usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstvaapi.so" "$video_dir/plugins/"
cp "$video_dir/runtime/usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstvideoparsersbad.so" "$video_dir/plugins/"
for plugin in webrtc nice dtls srtp; do
 cp "$video_dir/runtime/usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgst${plugin}.so" "$video_dir/plugins/"
done
printf 'GI_TYPELIB_PATH=%s/runtime/usr/lib/x86_64-linux-gnu/girepository-1.0\n' "$video_dir" > "$HOME/.config/phonepad/video.env"
printf 'LD_LIBRARY_PATH=%s/runtime/usr/lib/x86_64-linux-gnu\nLIBVA_DRIVERS_PATH=%s/runtime/usr/lib/x86_64-linux-gnu/dri\nGST_PLUGIN_PATH=%s/plugins\nGST_REGISTRY=%s/registry.bin\n' "$video_dir" "$video_dir" "$video_dir" "$video_dir" >> "$HOME/.config/phonepad/video.env"
printf 'Runtime aislado preparado. Requiere GStreamer, Python GI y Gst del sistema.\n'
