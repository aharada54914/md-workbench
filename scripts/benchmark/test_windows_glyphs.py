import sys
import unittest
from windows_glyphs import supported


@unittest.skipUnless(sys.platform == 'win32', 'Windows GDI only')
class GlyphCoverageTests(unittest.TestCase):
    def test_real_font_has_ascii_glyphs(self):
        result = supported('Arial', 'ABC123')
        self.assertTrue(result['supported'], result)

    def test_missing_glyph_is_not_font_fallback_success(self):
        self.assertFalse(supported('Arial', '\uffff')['supported'])

    def test_missing_family_is_not_silently_substituted(self):
        self.assertFalse(supported('MDW-Nonexistent-Font-7923', 'ABC')['supported'])


if __name__ == '__main__':
    unittest.main()
