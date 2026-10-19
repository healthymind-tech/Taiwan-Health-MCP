"""Pure unit tests (no model needed): python -m unittest discover -s tests"""

import unittest

from app.config import OptionError, Settings, parse_options, sniff_kind
from app.worker import page_range

S = Settings(
    model_dir="/nonexistent",
    workers=2,
    threads_per_worker=1,
    max_upload_bytes=1024,
    max_pages=10,
    max_timeout_seconds=600,
    default_timeout_seconds=300,
    max_queue=8,
    default_dpi=200,
)


class ParseOptions(unittest.TestCase):
    def test_defaults(self) -> None:
        o = parse_options({}, S)
        self.assertEqual(o["format"], "markdown")
        self.assertEqual(o["mode"], "auto")
        self.assertEqual(o["dpi"], 200)
        self.assertEqual(o["max_pages"], 10)
        self.assertEqual(o["timeout_seconds"], 300)
        self.assertFalse(o["keep_furniture"])

    def test_aliases_and_bounds(self) -> None:
        self.assertEqual(parse_options({"format": "MD"}, S)["format"], "markdown")
        with self.assertRaises(OptionError):
            parse_options({"dpi": "1000"}, S)
        with self.assertRaises(OptionError):
            parse_options({"mode": "fast"}, S)
        with self.assertRaises(OptionError):
            parse_options({"max_pages": "11"}, S)  # above the server cap
        with self.assertRaises(OptionError):
            parse_options({"first_page": "3", "last_page": "2"}, S)
        with self.assertRaises(OptionError):
            parse_options({"keep_furniture": "maybe"}, S)


class PageRange(unittest.TestCase):
    def test_range_and_cap(self) -> None:
        self.assertEqual(page_range(5, 1, 0, 10), ([0, 1, 2, 3, 4], False))
        self.assertEqual(page_range(5, 2, 3, 10), ([1, 2], False))
        self.assertEqual(page_range(5, 1, 99, 10), ([0, 1, 2, 3, 4], False))
        self.assertEqual(page_range(30, 1, 0, 10), (list(range(10)), True))
        self.assertEqual(page_range(3, 5, 0, 10), ([], False))


class Sniff(unittest.TestCase):
    def test_kinds(self) -> None:
        self.assertEqual(sniff_kind(b"%PDF-1.7\n"), "pdf")
        self.assertEqual(sniff_kind(b"junk %PDF-1.4"), "pdf")
        self.assertEqual(sniff_kind(b"\x89PNG\r\n\x1a\n...."), "image")
        self.assertEqual(sniff_kind(b"\xff\xd8\xff\xe0"), "image")
        self.assertEqual(sniff_kind(b"RIFF\x00\x00\x00\x00WEBPVP8 "), "image")
        self.assertIsNone(sniff_kind(b"<html>"))


if __name__ == "__main__":
    unittest.main()
