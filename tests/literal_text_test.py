import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

path = Path(__file__).resolve().parents[1] / 'daemon/internal/input/literal_text.py'
spec = importlib.util.spec_from_file_location('literal_text', path)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class Editor:
    def __init__(self, value='', caret=0, selection=None):
        self.value, self.caret, self.selection = value, caret, selection
        self.calls = []
    def get_text_iface(self): return self
    def get_editable_text_iface(self): return self
    def get_n_selections(self): return int(self.selection is not None)
    def get_caret_offset(self): return self.caret
    def get_selection(self, index): return SimpleNamespace(start_offset=self.selection[0], end_offset=self.selection[1])
    def delete_text(self, start, end):
        self.calls.append('delete'); self.value = self.value[:start] + self.value[end:]; return True
    def insert_text(self, offset, text, length):
        self.calls.append('insert'); assert length == len(text.encode('utf-8'))
        self.value = self.value[:offset] + text + self.value[offset:]; return True
    def set_caret_offset(self, position): self.caret = position; return True


class LiteralTests(unittest.TestCase):
    def test_unicode_is_literal_without_keycodes_or_newline_actions(self):
        for value in ['¿? _ ñ 👨‍👩‍👧‍👦', 'a\r\nb\nc\td', 'é e\u0301', 'x'*102400]:
            editor = Editor('OK!', 2)
            result = adapter.insert(editor, value, lambda n: True)
            self.assertEqual(result['state'], 'dispatched')
            self.assertEqual(editor.value, 'OK'+value+'!')
            self.assertEqual(editor.caret, 2+len(value))
    def test_replaces_exact_selection_without_backspace(self):
        editor = Editor('OK👨‍👩‍👧‍👦!', 2, (2, 9))
        self.assertEqual(adapter.insert(editor, '?', lambda n: True)['state'], 'dispatched')
        self.assertEqual(editor.value, 'OK?!')
        self.assertEqual(editor.calls, ['delete', 'insert'])
    def test_explicit_text_interface_avoids_accessible_selection_collision(self):
        editor = Editor('replace', 0, (0, 7))
        def accessible_selection(): return object()
        editor.get_selection = accessible_selection
        class TextAPI:
            @staticmethod
            def get_selection(node, index):
                return SimpleNamespace(start_offset=0, end_offset=7)
        result = adapter.insert(editor, '漢字🙂', lambda n: True, TextAPI)
        self.assertEqual(result['state'], 'dispatched')
        self.assertEqual(editor.value, '漢字🙂')

    def test_no_focus_rejects_before_mutation(self):
        editor = Editor('unchanged')
        self.assertEqual(adapter.insert(editor, 'x', lambda n: False)['state'], 'rejected')
        self.assertEqual(editor.calls, [])
    def test_failure_after_deletion_is_uncertain(self):
        editor = Editor('abc', 0, (0, 1))
        def fail(*args): raise RuntimeError('do not leak target content')
        editor.insert_text = fail
        result = adapter.insert(editor, 'x', lambda n: True)
        self.assertEqual(result, {'state':'uncertain','detail':'accessibility_unavailable'})


if __name__ == '__main__': unittest.main()
