import ctypes
import json
import sys

from gi.repository import Gio


def active_layout():
    settings = Gio.Settings.new('org.gnome.desktop.input-sources')
    sources = list(settings.get_value('mru-sources')) or list(settings.get_value('sources'))
    options = ','.join(settings.get_strv('xkb-options'))
    for kind, name in sources:
        if kind == 'xkb':
            layout, _, variant = name.partition('+')
            return layout, variant, options
    return 'us', '', options


class Names(ctypes.Structure):
    _fields_ = [(field, ctypes.c_char_p) for field in ('rules', 'model', 'layout', 'variant', 'options')]


def main():
    xkb = ctypes.CDLL('libxkbcommon.so.0')
    xkb.xkb_context_new.restype = ctypes.c_void_p
    xkb.xkb_keymap_new_from_names.restype = ctypes.c_void_p
    xkb.xkb_keymap_new_from_names.argtypes = [ctypes.c_void_p, ctypes.POINTER(Names), ctypes.c_int]
    for name in ('xkb_keymap_min_keycode', 'xkb_keymap_max_keycode', 'xkb_keymap_num_mods'):
        getattr(xkb, name).argtypes = [ctypes.c_void_p]
    xkb.xkb_keymap_num_levels_for_key.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32]
    xkb.xkb_keymap_key_get_syms_by_level.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32, ctypes.POINTER(ctypes.POINTER(ctypes.c_uint32))]
    xkb.xkb_keymap_key_get_mods_for_level.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32), ctypes.c_size_t]
    xkb.xkb_keymap_mod_get_name.restype = ctypes.c_char_p
    xkb.xkb_keymap_mod_get_name.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    xkb.xkb_keysym_to_utf32.restype = ctypes.c_uint32
    xkb.xkb_keysym_to_utf32.argtypes = [ctypes.c_uint32]

    layout, variant, options = active_layout()
    names = Names(b'evdev', b'pc105', layout.encode(), variant.encode(), options.encode())
    keymap = xkb.xkb_keymap_new_from_names(xkb.xkb_context_new(0), ctypes.byref(names), 0)
    if not keymap:
        sys.exit('keymap_unavailable')
    modifiers = [xkb.xkb_keymap_mod_get_name(keymap, index).decode() for index in range(xkb.xkb_keymap_num_mods(keymap))]
    best = {}
    for keycode in range(xkb.xkb_keymap_min_keycode(keymap), min(xkb.xkb_keymap_max_keycode(keymap), 255) + 1):
        for level in range(xkb.xkb_keymap_num_levels_for_key(keymap, keycode, 0)):
            syms = ctypes.POINTER(ctypes.c_uint32)()
            if xkb.xkb_keymap_key_get_syms_by_level(keymap, keycode, 0, level, ctypes.byref(syms)) != 1:
                continue
            char = xkb.xkb_keysym_to_utf32(syms[0])
            if char < 0x20 or char == 0x7f:
                continue
            masks = (ctypes.c_uint32 * 8)()
            for mask in masks[:xkb.xkb_keymap_key_get_mods_for_level(keymap, keycode, 0, level, masks, 8)]:
                held = {modifiers[index] for index in range(len(modifiers)) if mask & (1 << index)}
                if not held <= {'Shift', 'Mod5', 'LevelThree'}:
                    continue
                shift, altgr = 'Shift' in held, bool(held & {'Mod5', 'LevelThree'})
                rank = (shift + altgr, keycode)
                if char not in best or rank < best[char][0]:
                    best[char] = (rank, [keycode - 8, shift, altgr])
                break
    json.dump({'layout': '+'.join(filter(None, (layout, variant))), 'keys': {str(char): entry for char, (_, entry) in best.items()}}, sys.stdout)


main()
