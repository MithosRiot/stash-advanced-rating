import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(__file__))
LIB = os.path.join(ROOT, "lib")
if LIB not in sys.path:
    sys.path.insert(0, LIB)

import rating_data_migration as migration
import rating_storage as storage


GROUPS = [
    {"id": "acts", "name": "Acts", "weight": 1},
    {"id": "appearance", "name": "Appearance", "weight": 1},
]
CRITERIA = [
    {"id": "dancing", "name": "Dancing", "group": "acts", "weight": 1, "enabled": True},
    {"id": "makeup", "name": "Makeup", "group": "appearance", "weight": 1, "enabled": True},
]


class RatingDataMigrationTests(unittest.TestCase):
    def setUp(self):
        self.index = migration.build_prefix_index("Advanced Rating System", GROUPS, CRITERIA)

    def test_current_group_qualified_tag_migrates(self):
        entity = {
            "custom_fields": {},
            "tags": [{"name": "Acts · Dancing ★: 4"}],
        }
        partial, stats = migration.migration_values_for_entity(entity, "scene", self.index)
        self.assertEqual(partial, {storage.rating_field("scene", "dancing"): 4})
        self.assertEqual(stats["migrated"], 1)

    def test_explicit_zero_migrates(self):
        entity = {
            "custom_fields": {},
            "tags": [{"name": "Acts · Dancing ★: 0"}],
        }
        partial, stats = migration.migration_values_for_entity(entity, "scene", self.index)
        self.assertEqual(partial[storage.rating_field("scene", "dancing")], 0)
        self.assertEqual(stats["migrated"], 1)

    def test_name_only_legacy_tag_migrates_when_unambiguous(self):
        entity = {
            "custom_fields": {},
            "tags": [{"name": "Dancing ★: 5"}],
        }
        partial, stats = migration.migration_values_for_entity(entity, "scene", self.index)
        self.assertEqual(partial[storage.rating_field("scene", "dancing")], 5)
        self.assertEqual(stats["ambiguous"], 0)

    def test_verbose_root_prefixed_tag_migrates(self):
        entity = {
            "custom_fields": {},
            "tags": [{"name": "Advanced Rating System · Acts · Dancing ★: 3"}],
        }
        partial, _ = migration.migration_values_for_entity(entity, "scene", self.index)
        self.assertEqual(partial[storage.rating_field("scene", "dancing")], 3)

    def test_existing_structured_rating_wins(self):
        key = storage.rating_field("scene", "dancing")
        entity = {
            "custom_fields": {key: 2},
            "tags": [{"name": "Acts · Dancing ★: 5"}],
        }
        partial, stats = migration.migration_values_for_entity(entity, "scene", self.index)
        self.assertEqual(partial, {})
        self.assertEqual(stats["skipped_existing"], 1)

    def test_existing_na_wins(self):
        entity = {
            "custom_fields": {storage.na_field("scene", "dancing"): True},
            "tags": [{"name": "Acts · Dancing ★: 5"}],
        }
        partial, stats = migration.migration_values_for_entity(entity, "scene", self.index)
        self.assertEqual(partial, {})
        self.assertEqual(stats["skipped_existing"], 1)

    def test_conflicting_scores_are_ambiguous_and_skipped(self):
        entity = {
            "custom_fields": {},
            "tags": [
                {"name": "Acts · Dancing ★: 2"},
                {"name": "Acts · Dancing ★: 4"},
            ],
        }
        partial, stats = migration.migration_values_for_entity(entity, "scene", self.index)
        self.assertEqual(partial, {})
        self.assertEqual(stats["ambiguous"], 1)

    def test_colliding_legacy_name_is_ambiguous(self):
        criteria = CRITERIA + [
            {"id": "dancing_appearance", "name": "Dancing", "group": "appearance", "weight": 1, "enabled": True},
        ]
        index = migration.build_prefix_index("Advanced Rating System", GROUPS, criteria)
        self.assertIsNone(index["Dancing ★"])

        entity = {
            "custom_fields": {},
            "tags": [{"name": "Dancing ★: 4"}],
        }
        partial, stats = migration.migration_values_for_entity(entity, "scene", index)
        self.assertEqual(partial, {})
        self.assertEqual(stats["ambiguous"], 1)

    def test_unrelated_tags_are_ignored(self):
        entity = {
            "custom_fields": {},
            "tags": [{"name": "Some Other Tag: 4"}],
        }
        partial, stats = migration.migration_values_for_entity(entity, "scene", self.index)
        self.assertEqual(partial, {})
        self.assertEqual(stats["migrated"], 0)


if __name__ == "__main__":
    unittest.main()
