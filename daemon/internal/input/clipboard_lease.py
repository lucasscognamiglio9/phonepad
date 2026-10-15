"""Temporary GTK clipboard provider for one literal paste.

Snapshot every offered MIME representation before claiming the clipboard.
Restore only while this exact provider still owns it, never by byte equality.
Only protocol status reaches stdout. Clipboard contents remain in memory.
"""
import json
import sys

MAX_TEXT = 128 * 1024
MAX_SNAPSHOT = 16 * 1024 * 1024
MAX_FORMATS = 32


def main():
    import gi
    gi.require_version('Gtk', '4.0')
    gi.require_version('Gdk', '4.0')
    from gi.repository import Gtk, Gdk, Gio, GLib

    request = json.loads(sys.stdin.buffer.readline(MAX_TEXT * 6 + 1024))
    text = request.get('text')
    if not isinstance(text, str) or not text or '\0' in text or len(text.encode()) > MAX_TEXT:
        raise ValueError('invalid text')
    Gtk.init()
    display = Gdk.Display.get_default()
    if display is None:
        raise ValueError('display unavailable')
    clipboard = display.get_clipboard()
    loop = GLib.MainLoop()
    snapshot = []
    revision = 0
    baseline = 0
    total = 0
    claimed = False
    finished = False
    sent = False
    armed = False
    offered = None
    restored = None
    cancellable = Gio.Cancellable()

    def emit(state, detail):
        print(json.dumps({'state': state, 'detail': detail}), flush=True)

    def owns(provider):
        return provider is not None and clipboard.is_local() and clipboard.get_content() == provider

    def finish(state, detail):
        nonlocal finished, restored
        if finished:
            return False
        finished = True
        cancellable.cancel()
        if claimed and owns(offered):
            providers = [Gdk.ContentProvider.new_for_bytes(mime, GLib.Bytes.new(data)) for mime, data in snapshot]
            restored = Gdk.ContentProvider.new_union(providers) if providers else None
            if not clipboard.set_content(restored):
                state, detail = 'uncertain', 'clipboard_restore_unconfirmed'
        elif claimed:
            state, detail = 'uncertain', 'clipboard_owner_changed'
        emit(state, detail)
        if restored is None:
            loop.quit()
        return False

    def changed(_clipboard):
        nonlocal revision
        revision += 1
        if claimed and not finished and not owns(offered):
            GLib.idle_add(finish, 'uncertain', 'clipboard_owner_changed')
        elif finished and not owns(restored):
            loop.quit()
    clipboard.connect('changed', changed)

    def claim():
        nonlocal claimed, offered
        if finished:
            return
        if revision != baseline:
            finish('rejected', 'clipboard_changed_before_dispatch')
            return
        payload = GLib.Bytes.new(text.encode('utf-8'))
        offered = Gdk.ContentProvider.new_union([
            Gdk.ContentProvider.new_for_bytes(mime, payload)
            for mime in ['text/plain;charset=utf-8', 'text/plain']
        ])
        claimed = True
        if not clipboard.set_content(offered):
            claimed = False
            finish('rejected', 'clipboard_offer_unavailable')
            return
        emit('ready', 'clipboard_preserved')
        # A missing parent/consumer must release the temporary offer too.
        GLib.timeout_add(3000, finish, 'uncertain', 'clipboard_consumption_unobserved')

    def read_format(formats, index=0):
        nonlocal total
        if finished:
            return
        if index == len(formats):
            claim()
            return
        mime = formats[index]
        def received(source, result):
            try:
                stream, actual = source.read_finish(result)
                if actual != mime:
                    raise ValueError('format changed')
            except Exception:
                finish('rejected', 'clipboard_snapshot_unavailable')
                return
            chunks = []
            def chunk(source_stream, result):
                nonlocal total
                if finished:
                    source_stream.close(None)
                    return
                try:
                    data = bytes(source_stream.read_bytes_finish(result).get_data())
                    total += len(data)
                    if total > MAX_SNAPSHOT:
                        raise ValueError('snapshot limit')
                    if data:
                        chunks.append(data)
                        source_stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancellable, chunk)
                    else:
                        source_stream.close(None)
                        snapshot.append((mime, b''.join(chunks)))
                        read_format(formats, index + 1)
                except Exception:
                    finish('rejected', 'clipboard_snapshot_unavailable')
            stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancellable, chunk)
        clipboard.read_async([mime], GLib.PRIORITY_DEFAULT, cancellable, received)

    def prepare():
        nonlocal baseline
        formats = clipboard.get_formats()
        mimes = list(formats.get_mime_types())
        baseline = revision
        if len(mimes) > MAX_FORMATS or not mimes and formats.get_gtypes():
            finish('rejected', 'clipboard_snapshot_unsupported')
        else:
            read_format(mimes)
        return False

    def command(_stream, condition):
        nonlocal sent, armed
        if finished:
            return False
        if condition & GLib.IO_HUP:
            finish('uncertain' if claimed else 'rejected', 'clipboard_parent_closed')
            return False
        try:
            data = json.loads(sys.stdin.readline(1024))
            if data.get('op') == 'arm' and claimed and owns(offered):
                armed = True
                emit('armed', 'clipboard_preserved')
            elif data.get('op') != 'sent' or not armed:
                finish('uncertain' if claimed else 'rejected', 'clipboard_dispatch_cancelled')
            else:
                if not sent:
                    sent = True
                    # XWayland/clipboard managers can prefetch payloads. Such
                    # a read is not proof of the focused application's paste.
                    # Keep the offer for the bounded consumer window; the
                    # receipt confirms key dispatch and restoration only.
                    GLib.timeout_add(2000, finish, 'dispatched', 'paste_dispatched_clipboard_restored')
        except Exception:
            finish('uncertain' if claimed else 'rejected', 'clipboard_dispatch_cancelled')
        return not finished

    def watchdog():
        if finished:
            if not owns(restored):
                loop.quit()
                return False
        elif not claimed:
            finish('rejected', 'clipboard_snapshot_timeout')
        return True

    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, command)
    GLib.timeout_add(4500, watchdog)
    GLib.idle_add(prepare)
    loop.run()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'state': 'rejected', 'detail': 'clipboard_preservation_unavailable'}), flush=True)
