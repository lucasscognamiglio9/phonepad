"""Deterministic desktop-sized text, separate from the moving video region.

Only synthetic content is rendered. Fonts have actual desktop pixel sizes;
the complete text region is compared with the unencoded source.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

TEXT_REGION = (32, 48, 1056, 432)


def desktop_scene(root):
    image = Image.new('RGBA', (1920, 1080), (23, 24, 28, 255))
    draw = ImageDraw.Draw(image)
    mono = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
    font = ImageFont.truetype(mono, 16)
    title = ImageFont.truetype(mono, 20)
    draw.rectangle((0, 0, 1920, 36), fill=(34, 36, 42, 255))
    draw.text((32, 7), 'PhonePad — synthetic desktop, 1920 × 1080', font=title, fill='white')
    lines = [
        'PhonePad 1080p: AaZz 0123456789 ñ € @ # & / { } [ ]',
        'const message = "Texto legible al primer intento";',
        'if (signal.aborted) return;  // cancel queued work',
        'receiver: video/H264   width: 1920   height: 1080',
        'Sensitivity: 1.00×  |  Cursor: 1.00×  |  Delay: ms',
        'function sendOnce(requestId, content) {',
        '  return receipts.commit(requestId, content);',
        '}',
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz',
        '() <> != === => + - _ % ~ : ; , . ? ¡ ¿ á é í ó ú ü',
        'Never substitute a connection check for visual quality.',
        'The text has 16 px glyphs and a complete reference crop.',
        'Wi-Fi jitter, loss, limited capacity, idle → movement.',
        'Separate cursor metadata from encoded desktop pixels.',
        'Backpressure: keep the newest frame, release old work.',
    ]
    colors = [(232, 234, 237), (160, 205, 250), (140, 218, 171), (221, 166, 237)]
    for column in range(3):
        for index, line in enumerate(lines):
            draw.text((32 + column * 625, 52 + index * 24), line, font=font,
                      fill=(*colors[index % len(colors)], 255))
    # Only this lower region is transparent: the ball source can move without
    # contaminating the static text ground truth or adding random pixel noise.
    draw.rectangle((0, 680, 1919, 1079), fill=(0, 0, 0, 0))
    path = Path(root) / 'desktop-scene.png'
    image.save(path)
    return path
