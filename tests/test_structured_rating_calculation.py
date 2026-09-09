import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(__file__))
LIB = os.path.join(ROOT, "lib")
if LIB not in sys.path:
    sys.path.insert(0, LIB)

import rating_core as core
import rating_storage as storage


class _Log:
    def debug(self, *_args, **_kwargs):
        pass

    def warning(self, *_args, **_kwargs):
        pass


GROUPS = [{"id": "acts", "name": "Acts", "weight": 1.0}]
CRITERIA = [
    {"id": "dancing", "name": "Dancing", "group": "acts", "weight": 1.0, "enabled": True},
    {"id": "swimming", "name": "Swimming", "group": "acts", "weight": 1.0, "enabled": True},
]
ROOT_TAG = {"name": "Advanced Rating System"}
LOG = _Log()


class StructuredRatingCalculationTests(unittest.TestCase):
    def calculate(self, entity, precision=1):
        return core.calculate_rating(
            entity, CRITERIA, GROUPS, precision, LOG, ROOT_TAG, domain="scene"
        )

    def test_structured_values_drive_rating(self):
        entity = {
            "custom_fields": {
                storage.rating_field("scene", "dancing"): 5,
                storage.rating_field("scene", "swimming"): 3,
            },
            "tags": [],
        }
        self.assertEqual(self.calculate(entity), 80)

    def test_zero_is_valid_and_can_produce_rating100_zero(self):
        entity = {
            "custom_fields": {storage.rating_field("scene", "dancing"): 0},
            "tags": [],
        }
        self.assertEqual(self.calculate(entity), 0)

    def test_na_excludes_criterion_and_blocks_tag_fallback(self):
        entity = {
            "custom_fields": {
                storage.rating_field("scene", "dancing"): 5,
                storage.na_field("scene", "swimming"): True,
            },
            "tags": [{"name": "Acts · Swimming ★: 1"}],
        }
        self.assertEqual(self.calculate(entity), 100)

    def test_unrated_structured_state_falls_back_to_legacy_tag(self):
        entity = {
            "custom_fields": {},
            "tags": [
                {"name": "Acts · Dancing ★: 4"},
                {"name": "Acts · Swimming ★: 2"},
            ],
        }
        self.assertEqual(self.calculate(entity), 60)

    def test_structured_value_wins_over_different_legacy_tag(self):
        entity = {
            "custom_fields": {storage.rating_field("scene", "dancing"): 5},
            "tags": [{"name": "Acts · Dancing ★: 1"}],
        }
        self.assertEqual(self.calculate(entity), 100)

    def test_unrated_and_na_only_returns_none(self):
        entity = {
            "custom_fields": {storage.na_field("scene", "dancing"): True},
            "tags": [],
        }
        self.assertIsNone(self.calculate(entity))

    def test_group_weighting_preserved(self):
        groups = [
            {"id": "acts", "name": "Acts", "weight": 1.0},
            {"id": "appearance", "name": "Appearance", "weight": 3.0},
        ]
        criteria = [
            {"id": "dancing", "name": "Dancing", "group": "acts", "weight": 1.0, "enabled": True},
            {"id": "makeup", "name": "Makeup", "group": "appearance", "weight": 1.0, "enabled": True},
        ]
        entity = {
            "custom_fields": {
                storage.rating_field("scene", "dancing"): 5,
                storage.rating_field("scene", "makeup"): 1,
            },
            "tags": [],
        }
        # (5*1 + 1*3) / 4 = 2.0 -> 40/100
        self.assertEqual(
            core.calculate_rating(entity, criteria, groups, 1, LOG, ROOT_TAG, domain="scene"),
            40,
        )


if __name__ == "__main__":
    unittest.main()
