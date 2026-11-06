"""Single-viewer native WebRTC. Called only behind Phonepad authorization.

The controller is receiver-feedback AIMD, not Google Congestion Control.
All pipeline operations run on the GLib thread; sessions have a short lease.
"""
import secrets
import threading
import time
import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstWebRTC', '1.0')
gi.require_version('GstSdp', '1.0')
gi.require_version('GstVideo', '1.0')
from gi.repository import Gst, GstWebRTC, GstSdp, GstVideo, GLib
from rtc_codecs import (disable_ice_upnp, modern_h264_encoder, available_codecs, enable_video_recovery, _caps_from_pipeline, _max_frame_age_ms, _lab_h264_config, _lab_encoder_options, desktop_quantizer_limit)
from rate_control import RateController
from rtc_session import Session
import audio_bridge
from media_contract import (MediaContractError, fit_square_pixel_size, requested_codecs,
                            unknown_media, validate_media)
from cursor_lease import CursorGuardian


def _remove_glib_source(source_id):
    """Best-effort removal of a source that has not started yet.

    GLib can race a source callback with ``source_remove``.  The dispatch task
    still checks its cancellation bit in that case, so removal is only a
    scheduling optimisation and never the correctness guard.
    """
    if source_id is None:
        return
    try:
        GLib.source_remove(source_id)
    except Exception:
        pass


class DispatchCancelled(RuntimeError):
    """An action was withdrawn before its GLib callback began."""


class _DispatchTask:
    """One cancellable action queued on the GLib context."""

    def __init__(self, action, owner=None):
        self.action = action
        self.owner = owner
        self.event = threading.Event()
        self.box = {}
        self.lock = threading.Lock()
        self.started = False
        self.cancelled = False
        self.source_id = None

    def attach_source(self, source_id):
        with self.lock:
            self.source_id = source_id
            remove = self.cancelled and not self.started
        if remove:
            _remove_glib_source(source_id)

    def cancel(self):
        """Cancel only if the action has not begun; return whether it did."""
        with self.lock:
            if self.started:
                return False
            self.cancelled = True
            source_id = self.source_id
        self.event.set()
        _remove_glib_source(source_id)
        return True

    def run(self):
        with self.lock:
            if self.cancelled:
                self.event.set()
                return False
            self.started = True
        if self.owner is not None:
            with self.owner._life_lock:
                self.owner._glib_thread_id = threading.get_ident()
        try:
            self.box['result'] = self.action()
        except Exception as error:
            self.box['error'] = error
        finally:
            self.event.set()
        return False


class Manager:
    def __init__(self, source, media_tracker=None, media_provider=None, codec_probe=None, source_dimensions=None):
        self.source = source
        self.media_tracker = media_tracker
        self.media_provider = media_provider
        self.codec_probe = codec_probe or available_codecs
        self.source_dimensions = source_dimensions
        self.session = None
        self._life_lock = threading.RLock()
        self._dispatch_tasks = set()
        self._closing = False
        self._closed = False
        self._glib_thread_id = None
        self._shutdown_started = False
        self._shutdown_queued = False
        self._shutdown_event = threading.Event()
        self._shutdown_error = None
        audio_bridge.recover()
        self._probe_media()
        self._expiry_source = GLib.timeout_add_seconds(2, self.expire)

    def _ensure_lifecycle(self):
        # A few small tests construct Manager.__new__(Manager) to exercise
        # expiry without bringing up GStreamer.  Keep those fixtures valid.
        if not hasattr(self, '_life_lock'):
            self._life_lock = threading.RLock()
        if not hasattr(self, '_dispatch_tasks'):
            self._dispatch_tasks = set()
        if not hasattr(self, '_closing'):
            self._closing = False
        if not hasattr(self, '_closed'):
            self._closed = False
        if not hasattr(self, '_glib_thread_id'):
            self._glib_thread_id = None
        if not hasattr(self, '_shutdown_started'):
            self._shutdown_started = False
        if not hasattr(self, '_shutdown_queued'):
            self._shutdown_queued = False
        if not hasattr(self, '_shutdown_event'):
            self._shutdown_event = threading.Event()
        if not hasattr(self, '_shutdown_error'):
            self._shutdown_error = None

    def _cancel_pending(self):
        self._ensure_lifecycle()
        with self._life_lock:
            tasks = list(self._dispatch_tasks)
        for task in tasks:
            task.cancel()

    def _begin_closing(self):
        self._ensure_lifecycle()
        with self._life_lock:
            self._closing = True
        self._cancel_pending()

    @property
    def closing(self):
        self._ensure_lifecycle()
        with self._life_lock:
            return self._closing

    @property
    def closed(self):
        self._ensure_lifecycle()
        with self._life_lock:
            return self._closed

    def _probe_media(self):
        if self.media_tracker is None:
            return
        try:
            codecs = self.codec_probe()
            if codecs:
                self.media_tracker.set_codecs(codecs)
            else:
                self.media_tracker.set_video_unavailable('encoder_unavailable')
        except Exception:
            self.media_tracker.set_video_unknown('codec_probe_failed')

    def media_snapshot(self):
        if self.media_tracker is not None:
            return self.media_tracker.snapshot()
        if self.media_provider is not None:
            return validate_media(self.media_provider())
        if self.session is not None:
            return self.session.media_snapshot()
        return unknown_media(source_reason='source_not_exposed', geometry_reason='geometry_not_exposed', video_reason='codec_not_exposed')

    def _media_fence(self, data):
        expected_source = data.get('sourceId')
        expected_epoch = data.get('geometryEpoch')
        if expected_source is None and expected_epoch is None:
            return
        if expected_source is not None and not isinstance(expected_source, str):
            raise ValueError('media_stale')
        if expected_epoch is not None and (isinstance(expected_epoch, bool) or not isinstance(expected_epoch, int) or not 1 <= expected_epoch <= (1 << 53) - 1):
            raise ValueError('media_stale')
        media = self.media_snapshot()
        source = media['source']
        geometry = media['geometry']
        if expected_source is not None and (source.get('state') != 'available' or source.get('id') != expected_source):
            raise ValueError('media_stale')
        if expected_epoch is not None and (geometry.get('state') != 'available' or geometry.get('epoch') != expected_epoch):
            raise ValueError('media_stale')

    def _source_value(self):
        value = self.source()
        if not isinstance(value, (tuple, list)) or not value:
            raise RuntimeError('source unavailable')
        if len(value) >= 3:
            return value[0], value[1], value[2]
        return value[0], None, None

    def expire(self):
        self._ensure_lifecycle()
        with self._life_lock:
            if self._closing or self._closed:
                return False
        if self.session and time.monotonic() - self.session.touched >= (300 if self.session.suspended else 12):
            self.session.close()
            self.session = None
        return True

    def dispatch(self, action, timeout=5, allow_closing=False):
        self._ensure_lifecycle()
        with self._life_lock:
            if self._closing and not allow_closing:
                raise ValueError('manager closing')
            task = _DispatchTask(action, self)
            self._dispatch_tasks.add(task)
        try:
            task.attach_source(GLib.idle_add(task.run))
            if not task.event.wait(timeout):
                # If the callback has not started, this prevents it from
                # executing after the HTTP request already timed out.  Once
                # started, GStreamer cannot safely interrupt the in-flight
                # action; the caller gets a bounded timeout and shutdown will
                # close the session when the GLib action returns.
                task.cancel()
                raise TimeoutError('capture busy')
            with task.lock:
                if task.cancelled:
                    raise DispatchCancelled('capture action cancelled')
            if 'error' in task.box:
                raise task.box['error']
            return task.box.get('result')
        finally:
            with self._life_lock:
                self._dispatch_tasks.discard(task)

    def _shutdown_on_loop(self):
        self._begin_closing()
        with self._life_lock:
            if self._closed:
                if self._shutdown_error is not None:
                    raise self._shutdown_error
                return False
            if self._shutdown_started:
                return False
            self._shutdown_started = True
            self._shutdown_queued = True
            expiry_source = getattr(self, '_expiry_source', None)
            self._expiry_source = None
            session = self.session
            self.session = None
        _remove_glib_source(expiry_source)
        error = None
        try:
            if session is not None and not getattr(session, 'closed', False):
                session.close()
        except Exception as shutdown_error:
            error = shutdown_error
        finally:
            with self._life_lock:
                self._shutdown_error = error
                # Do not advertise closed until the owner-thread destructor
                # has returned. Callers may still observe closing meanwhile.
                self._closed = True
                self._shutdown_started = False
                self._shutdown_event.set()
        if error is not None:
            raise error
        return False

    def shutdown_on_loop(self):
        """Close on the GLib owner thread; safe to call repeatedly."""
        return self._shutdown_on_loop()

    def shutdown(self, timeout=5):
        """Request bounded shutdown from any thread.

        The normal signal path queues ``shutdown_on_loop``. Its private
        completion event is never cancelled on timeout, so a close requested
        during a busy GLib action runs once when the owner becomes available.
        A timeout is reported explicitly; an in-flight GStreamer action cannot
        be interrupted safely.
        """
        self._ensure_lifecycle()
        self._begin_closing()
        if threading.get_ident() == getattr(self, '_glib_thread_id', None):
            return self._shutdown_on_loop()
        with self._life_lock:
            if self._closed:
                if self._shutdown_error is not None:
                    raise self._shutdown_error
                return True
            enqueue = not self._shutdown_queued
            self._shutdown_queued = True
            event = self._shutdown_event
        if enqueue:
            try:
                GLib.idle_add(self._shutdown_callback)
            except Exception:
                with self._life_lock:
                    self._shutdown_queued = False
                raise
        if not event.wait(timeout):
            raise TimeoutError('manager shutdown timed out')
        with self._life_lock:
            error = self._shutdown_error
            closed = self._closed
        if error is not None:
            raise error
        return closed

    def _shutdown_callback(self):
        try:
            self._shutdown_on_loop()
        except Exception as error:
            # _shutdown_on_loop records the error and marks completion. Keep
            # the GLib callback itself non-throwing so the context survives.
            with self._life_lock:
                self._shutdown_error = error
                self._shutdown_event.set()
        return False

    def handle(self, data):
        operation = data.get('op')
        self._ensure_lifecycle()
        with self._life_lock:
            if self._closing and operation != 'stop':
                raise ValueError('manager closing')
        if operation == 'diagnostic':
            phase = data.get('phase')
            if phase not in ('status','offer','remote-description','answer','ice-gathering','send-answer','receiving'):
                raise ValueError('invalid diagnostic')
            print('rtc native startup failed phase=' + phase, flush=True)
            return {'ok': True}
        if operation == 'start':
            preferences = requested_codecs(data)
            cursor_size = data.get('cursorSize', 0)
            if type(cursor_size) is not int or (cursor_size != 0 and not 24 <= cursor_size <= 128):
                raise ValueError('invalid cursor size')
            width = data.get('width', 1920)
            if type(width) is not int or not 320 <= width <= 1920:
                raise ValueError('invalid width')
            self._media_fence(data)
            available = []
            try:
                available = list(self.codec_probe())
            except Exception:
                available = []
            if not available:
                raise ValueError('no codec available')
            chosen = next((codec for codec in preferences if codec in available), None)
            if chosen is None:
                raise ValueError('unsupported codec')
            if chosen not in ('H264', 'H265'):
                raise ValueError('unsupported codec')

            def start():
                with self._life_lock:
                    if self._closing:
                        raise ValueError('manager closing')
                source, _logical_width, _logical_height = self._source_value()
                output_size = None
                if self.source_dimensions is not None:
                    output_size = fit_square_pixel_size(self.source_dimensions(), (width, 1080))
                if self.session:
                    self.session.close()
                # Portal size is logical on fractional-scale GNOME. Negotiate physical
                # PipeWire dimensions with encode bounds, rather than rescaling to
                # that metadata. Actual geometry is read from current caps.
                self.session = Session(source, width, 1080, chosen,
                                       media_tracker=self.media_tracker,
                                       media_provider=self.media_provider, output_size=output_size,
                                       audio=data.get('audio') is True,
                                       **({'cursor_metadata': True,
                                           'cursor_delivery': 2 if data.get('cursorDelivery') == 2 else 1}
                                          if data.get('cursorMode') == 'metadata' else {}))
                return self.session
            session = self.dispatch(start)
            if not session.ready.wait(7) or session.error or session.closed:
                self.dispatch(session.close)
                with self._life_lock:
                    if self.session is session:
                        self.session = None
                raise RuntimeError('WebRTC unavailable')
            def description():
                local = session.peer.get_property('local-description')
                offer_sdp = local.sdp.as_text()
                if session.controller_name == 'gcc':
                    session.controller.validate_offer(offer_sdp)
                if self.media_tracker is not None:
                    try:
                        self.media_tracker.select_codec(session.codec)
                    except MediaContractError:
                        # A successful offer is a runtime proof when a factory
                        # probe was unavailable; never claim it before this
                        # point.
                        self.media_tracker.set_codecs([session.codec], selected=session.codec)
                session.cursor_guardian = CursorGuardian(0 if data.get('cursorMode') == 'metadata' else cursor_size)
                session.cursor_guardian.set_active(True)
                return {'id': session.id, 'type': 'offer', 'sdp': offer_sdp, 'media': session.media_snapshot()}
            try:
                return self.dispatch(description)
            except Exception:
                self.dispatch(session.close)
                with self._life_lock:
                    if self.session is session:
                        self.session = None
                raise
        def update():
            session = self.session
            if not session or session.closed or not secrets.compare_digest(str(data.get('id', '')), session.id):
                raise ValueError('session unavailable')
            # stop is cleanup and must remain possible after a source or caps
            # generation changed. Every other update can opt into the fence.
            if operation != 'stop':
                self._media_fence(data)
            if operation == 'answer':
                session.answer(data.get('sdp'))
                return {'ok': True}
            if operation == 'suspend':
                return session.suspend()
            if operation == 'resume':
                return session.resume()
            if operation == 'feedback':
                return session.feedback(data)
            if operation == 'stop':
                session.close()
                return {'ok': True}
            raise ValueError('invalid operation')
        return self.dispatch(update, allow_closing=(operation == 'stop'))