"""Check glyph coverage in the exact platform font reported by native WebView."""
import ctypes
from ctypes import wintypes
import json
import sys


def supported(font_name, text):
    if sys.platform != 'win32':
        raise ValueError('Windows GDI required')
    if any(ord(char) > 0xffff for char in text):
        raise ValueError('This diagnostic checks BMP Japanese characters only')
    gdi = ctypes.WinDLL('gdi32', use_last_error=True)
    gdi.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi.CreateCompatibleDC.restype = wintypes.HDC
    gdi.CreateFontW.argtypes = [ctypes.c_int] * 5 + [wintypes.DWORD] * 8 + [wintypes.LPCWSTR]
    gdi.CreateFontW.restype = wintypes.HANDLE
    gdi.SelectObject.argtypes = [wintypes.HDC, wintypes.HANDLE]
    gdi.SelectObject.restype = wintypes.HANDLE
    gdi.GetTextFaceW.argtypes = [wintypes.HDC, ctypes.c_int, wintypes.LPWSTR]
    gdi.GetGlyphIndicesW.argtypes = [wintypes.HDC, wintypes.LPCWSTR, ctypes.c_int, ctypes.POINTER(wintypes.WORD), wintypes.DWORD]
    gdi.GetGlyphIndicesW.restype = wintypes.DWORD
    gdi.DeleteObject.argtypes = [wintypes.HANDLE]
    gdi.DeleteDC.argtypes = [wintypes.HDC]
    dc = gdi.CreateCompatibleDC(None)
    font = gdi.CreateFontW(-20, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, font_name)
    if not dc or not font:
        raise OSError('Cannot create font coverage context')
    previous = gdi.SelectObject(dc, font)
    try:
        selected = ctypes.create_unicode_buffer(256)
        if not gdi.GetTextFaceW(dc, len(selected), selected):
            raise OSError('Cannot verify selected font')
        glyphs = (wintypes.WORD * len(text))()
        if gdi.GetGlyphIndicesW(dc, text, len(text), glyphs, 1) == 0xffffffff:
            raise OSError('Cannot read font glyph indices')
        return {'requested': font_name, 'selected': selected.value, 'glyphs': list(glyphs),
                'supported': selected.value.casefold() == font_name.casefold() and all(glyph not in (0, 0xffff) for glyph in glyphs)}
    finally:
        gdi.SelectObject(dc, previous)
        gdi.DeleteObject(font)
        gdi.DeleteDC(dc)


if __name__ == '__main__':
    text, *fonts = sys.argv[1:]
    print(json.dumps([supported(font, text) for font in fonts]))
