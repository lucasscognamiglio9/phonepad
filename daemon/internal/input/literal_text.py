"""One bounded literal edit through AT-SPI. No clipboard or keyboard layout use.

Protocol on stdin/stdout contains only the requested text and a status. Never
print target application text, accessible names, clipboard data or exceptions.
"""
import json
import hashlib
import sys
import time

MAX_BYTES = 128 * 1024


def focused_editor(atspi):
    deadline = time.monotonic() + 2
    desktop = atspi.get_desktop(0)
    pending = [desktop]
    visited = 0
    while pending and visited < 3000 and time.monotonic() < deadline:
        node = pending.pop()
        visited += 1
        try:
            states = node.get_state_set()
            if states.contains(atspi.StateType.FOCUSED) and states.contains(atspi.StateType.EDITABLE):
                if node.get_editable_text_iface() is not None and node.get_text_iface() is not None:
                    return node
            count = min(node.get_child_count(), 256)
            children = [node.get_child_at_index(i) for i in range(count)]
            pending.extend(child for child in (children if node == desktop else reversed(children)) if child is not None)
        except Exception:
            continue
    return None


def insert(node, value, focused):
    """Return rejected before mutation, uncertain after any editing call starts."""
    mutating = False
    try:
        if node is None or not focused(node):
            return {'state': 'rejected', 'detail': 'editable_focus_unavailable'}
        text = node.get_text_iface()
        editable = node.get_editable_text_iface()
        selections = text.get_n_selections()
        if selections > 1:
            return {'state': 'rejected', 'detail': 'multiple_selections_unsupported'}
        offset = text.get_caret_offset()
        selection = text.get_selection(0) if selections else None
        if selection:
            start, end = selection.start_offset, selection.end_offset
            if start < 0 or end < start:
                return {'state': 'rejected', 'detail': 'invalid_selection'}
            offset = start
        if offset < 0 or not focused(node):
            return {'state': 'rejected', 'detail': 'focus_changed'}
        if selection and end > start:
            mutating = True
            if not editable.delete_text(start, end):
                return {'state': 'uncertain', 'detail': 'selection_replace_unconfirmed'}
        if not focused(node):
            return {'state': 'uncertain' if mutating else 'rejected', 'detail': 'focus_changed'}
        mutating = True
        # AT-SPI position uses character offsets; length is a UTF-8 byte count.
        if not editable.insert_text(offset, value, len(value.encode('utf-8'))):
            return {'state': 'uncertain', 'detail': 'insertion_unconfirmed'}
        # Do not send Enter or change focus. A returned success is an adapter
        # acknowledgement, not independent observation of the destination.
        if not text.set_caret_offset(offset + len(value)):
            return {'state': 'uncertain', 'detail': 'caret_unconfirmed'}
        return {'state': 'dispatched', 'detail': 'atspi_literal'}
    except Exception:
        return {'state': 'uncertain' if mutating else 'rejected', 'detail': 'accessibility_unavailable'}


def focus_token(node):
    text = node.get_text_iface()
    selections = text.get_n_selections()
    ranges = []
    for i in range(min(selections, 2)):
        span = text.get_selection(i)
        ranges.append((span.start_offset, span.end_offset))
    identity = [node.get_process_id(), node.path, text.get_caret_offset(), selections, ranges]
    return hashlib.sha256(json.dumps(identity).encode()).hexdigest()


def main():
    try:
        data = sys.stdin.buffer.readline(MAX_BYTES * 6 + 1024)
        request = json.loads(data)
        value = request.get('text')
        operation = request.get('op', 'insert')
        if operation != 'probe' and (not isinstance(value, str) or not value or '\x00' in value or len(value.encode('utf-8')) > MAX_BYTES):
            raise ValueError('invalid text')
        import gi
        gi.require_version('Atspi', '2.0')
        from gi.repository import Atspi
        Atspi.set_timeout(150, 500)
        Atspi.init()
        node = focused_editor(Atspi)
        def focused(node):
            node.clear_cache_single()
            states = node.get_state_set()
            return states.contains(Atspi.StateType.FOCUSED) and states.contains(Atspi.StateType.EDITABLE)
        if node is None or not focused(node):
            result = {'state': 'rejected', 'detail': 'editable_focus_unavailable'}
        elif operation == 'probe':
            result = {'state': 'ready', 'detail': 'atspi_literal', 'target': focus_token(node)}
        elif operation != 'insert' or request.get('target') != focus_token(node):
            result = {'state': 'rejected', 'detail': 'focus_or_selection_changed'}
        else:
            result = insert(node, value, focused)
    except Exception:
        result = {'state': 'rejected', 'detail': 'literal_adapter_unavailable'}
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
