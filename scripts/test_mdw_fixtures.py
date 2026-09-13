"""Tests of corpus integrity, not claims about the app's rendering or performance."""
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import struct
import zlib
import unittest
import xml.etree.ElementTree as ET
import generate_mdw_fixtures as fixtures


class FixtureTests(unittest.TestCase):
    def test_deterministic(self):
        self.assertEqual(fixtures.payloads(True), fixtures.payloads(True))

    def test_lock_manifest(self):
        path = Path(__file__).resolve().parents[1] / 'docs/md-workbench/baseline/fixtures.lock.json'
        self.assertEqual(fixtures.manifest(fixtures.payloads(True)), json.loads(path.read_text(encoding='utf-8')))

    def test_sizes(self):
        files = fixtures.payloads(True)
        self.assertEqual(len(files['document-100kib.md']), 100 * 1024)
        self.assertEqual(len(files['document-10mib.md']), 10 * 1024 * 1024)

    def test_bom_crlf(self):
        data = fixtures.payloads()['日本語 空白/encoding-bom-crlf.md']
        self.assertTrue(data.startswith(b'\xef\xbb\xbf'))
        self.assertNotIn(b'\n', data.replace(b'\r\n', b''))
        self.assertIn(b'  \r\n', data)

    def test_mermaid_count(self):
        self.assertEqual(fixtures.payloads()['mermaid-10.md'].count(b'```mermaid\n'), 10)

    def test_xml_and_pages(self):
        files = fixtures.payloads()
        self.assertEqual(len(ET.fromstring(files['diagrams/two-pages.drawio']).findall('diagram')), 2)
        self.assertEqual(ET.fromstring(files['assets/box.svg']).tag, '{http://www.w3.org/2000/svg}svg')

    def test_png_reference_bytes(self):
        files = fixtures.payloads()
        self.assertTrue(files['assets/pixel.png'].startswith(b'\x89PNG\r\n\x1a\n'))
        self.assertEqual(files['assets/pixel.png'], base64.b64decode(fixtures.PNG_BASE64))

    def test_png_crc_and_pixels(self):
        data = fixtures.payloads()['assets/pixel.png']
        pos, pixels = 8, b''
        while pos < len(data):
            length = struct.unpack('>I', data[pos:pos + 4])[0]
            kind = data[pos + 4:pos + 8]
            body = data[pos + 8:pos + 8 + length]
            crc = struct.unpack('>I', data[pos + 8 + length:pos + 12 + length])[0]
            self.assertEqual(zlib.crc32(kind + body) & 0xffffffff, crc)
            if kind == b'IDAT':
                pixels += body
            pos += length + 12
        self.assertEqual(pos, len(data))
        self.assertEqual(zlib.decompress(pixels), bytes([0, 0, 0, 0, 255]))

    def test_write_and_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'corpus'
            m = fixtures.write_fixture_set(path, True)
            for entry in m['files']:
                self.assertEqual(hashlib.sha256((path / entry['path']).read_bytes()).hexdigest(), entry['sha256'])

    def test_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'corpus'
            fixtures.write_fixture_set(path)
            with self.assertRaises(FileExistsError):
                fixtures.write_fixture_set(path)


if __name__ == '__main__':
    unittest.main(verbosity=2)
