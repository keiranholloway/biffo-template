import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import check_skeleton_sdk_lock as c  # noqa: E402


class CompareTests(unittest.TestCase):
    def test_lock_equals_tag_passes(self):
        self.assertEqual(c.compare("1.6.0", "1.6.0", "1.6.0"), ([], []))

    def test_lock_behind_tag_fails_naming_fix(self):
        errors, _ = c.compare("1.6.0", "1.6.0", "1.5.0")
        self.assertEqual(len(errors), 1)
        self.assertIn("uv lock --upgrade-package biffo-plugin-sdk", errors[0])
        self.assertIn("_skeletons/plugin-template", errors[0])

    def test_source_ahead_of_tag_warns_not_fails(self):
        errors, warnings = c.compare("1.7.0", "1.6.0", "1.6.0")
        self.assertEqual(errors, [])
        self.assertEqual(len(warnings), 1)
        self.assertIn("source 1.7.0 is unpublished", warnings[0])
        self.assertIn("stays on 1.6.0", warnings[0])

    def test_numeric_not_lexical(self):
        errors, _ = c.compare("1.10.0", "1.10.0", "1.9.0")
        self.assertEqual(len(errors), 1)


class ParseTests(unittest.TestCase):
    def test_newest_tag_numeric(self):
        self.assertEqual(c.newest_sdk_tag(["sdk-v1.9.0", "sdk-v1.10.0", "core-v9.0.0"]), "1.10.0")

    def test_no_tags(self):
        self.assertIsNone(c.newest_sdk_tag(["core-v1.0.0"]))

    def test_lock_version(self):
        lock = (
            'version = 1\n[[package]]\nname = "x"\nversion = "9"\n'
            '[[package]]\nname = "biffo-plugin-sdk"\nversion = "1.6.0"\n'
        )
        self.assertEqual(c.lock_sdk_version(lock), "1.6.0")


if __name__ == "__main__":
    unittest.main()
