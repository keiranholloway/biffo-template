import unittest

from scripts.sdk_tag_decision import decide, highest_sdk_version

HEAD = "a" * 40
OLD = "b" * 40
TAGS = ["sdk-v1.5.0", "sdk-v1.6.0", "sdk-v1.10.0", "core-v9.0.0", "sdk-vjunk"]


class DecideTest(unittest.TestCase):
    def test_highest_is_numeric_not_lexical(self):
        self.assertEqual(highest_sdk_version(TAGS), "1.10.0")
        self.assertIsNone(highest_sdk_version(["core-v1.0.0"]))

    def test_higher_tags(self):
        self.assertEqual(decide("1.11.0", TAGS, None, HEAD)[0], "tag")

    def test_first_release_tags(self):
        self.assertEqual(decide("1.0.0", [], None, HEAD)[0], "tag")

    def test_equal_is_noop_even_if_tag_on_older_commit(self):
        self.assertEqual(decide("1.10.0", TAGS, OLD, HEAD)[0], "noop")

    def test_lower_refuses(self):
        self.assertEqual(decide("1.9.0", TAGS, None, HEAD)[0], "refuse")

    def test_existing_tag_on_other_commit_refuses(self):
        self.assertEqual(decide("1.11.0", TAGS, OLD, HEAD)[0], "refuse")

    def test_existing_tag_on_head_is_noop(self):
        self.assertEqual(decide("1.11.0", TAGS, HEAD, HEAD)[0], "noop")

    def test_bad_version_refuses(self):
        self.assertEqual(decide("banana", TAGS, None, HEAD)[0], "refuse")


if __name__ == "__main__":
    unittest.main()
