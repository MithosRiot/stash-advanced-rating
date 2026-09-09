import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(__file__))
LIB = os.path.join(ROOT, "lib")
if LIB not in sys.path:
    sys.path.insert(0, LIB)

import rating_storage as storage


class RatingStorageTests(unittest.TestCase):
    def test_keys_use_stable_ids_not_display_names(self):
        self.assertEqual(
            storage.rating_field("scene", "dancing"),
            "advancedRating.scene.rating.dancing",
        )
        self.assertEqual(
            storage.na_field("performer", "swimming"),
            "advancedRating.performer.na.swimming",
        )

    def test_explicit_zero_is_rated(self):
        fields = {storage.rating_field("scene", "dancing"): 0}
        state = storage.read_state(fields, "scene", "dancing")
        self.assertTrue(state.is_rated)
        self.assertFalse(state.is_unrated)
        self.assertFalse(state.not_applicable)
        self.assertEqual(state.value, 0)

    def test_missing_value_is_unrated(self):
        state = storage.read_state({}, "scene", "dancing")
        self.assertTrue(state.is_unrated)
        self.assertFalse(state.is_rated)
        self.assertFalse(state.not_applicable)
        self.assertIsNone(state.value)

    def test_na_is_distinct_and_wins_over_conflicting_rating(self):
        fields = {
            storage.rating_field("performer", "dancing"): 5,
            storage.na_field("performer", "dancing"): True,
        }
        state = storage.read_state(fields, "performer", "dancing")
        self.assertTrue(state.not_applicable)
        self.assertFalse(state.is_rated)
        self.assertFalse(state.is_unrated)
        self.assertIsNone(state.value)

    def test_set_rating_removes_na(self):
        self.assertEqual(
            storage.set_rating_input("scene", "dancing", 4),
            {
                "partial": {"advancedRating.scene.rating.dancing": 4},
                "remove": ["advancedRating.scene.na.dancing"],
            },
        )

    def test_set_na_removes_rating(self):
        self.assertEqual(
            storage.set_not_applicable_input("scene", "dancing"),
            {
                "partial": {"advancedRating.scene.na.dancing": True},
                "remove": ["advancedRating.scene.rating.dancing"],
            },
        )

    def test_clear_removes_both_fields(self):
        self.assertEqual(
            storage.clear_rating_input("performer", "swimming"),
            {
                "remove": [
                    "advancedRating.performer.rating.swimming",
                    "advancedRating.performer.na.swimming",
                ]
            },
        )

    def test_invalid_scores_rejected(self):
        for value in (-1, 6, 2.5, True):
            with self.assertRaises(ValueError):
                storage.set_rating_input("scene", "dancing", value)

    def test_invalid_domain_rejected(self):
        with self.assertRaises(ValueError):
            storage.rating_field("gallery", "dancing")

    def test_criterion_id_cannot_contain_separator(self):
        with self.assertRaises(ValueError):
            storage.rating_field("scene", "acts.dancing")


if __name__ == "__main__":
    unittest.main()
