"""Migrate legacy Advanced Rating score tags into structured custom fields.

This module intentionally does not delete tags. Cleanup is a separate,
destructive operation covered by a later issue.
"""

from collections import defaultdict

import rating_storage as storage


TAG_SUFFIX = " ★"


def _group_name(groups, criterion):
    group = next((g for g in groups if g.get("id") == criterion.get("group")), None)
    return (group or {}).get("name") or criterion.get("group") or ""


def _prefixes_for_criterion(root_name, groups, criterion):
    """Return supported current + legacy prefixes for one criterion."""
    qualified = f"{_group_name(groups, criterion)} · {criterion['name']}{TAG_SUFFIX}"
    return {
        qualified,
        f"{root_name} · {qualified}",
        f"{criterion['name']}{TAG_SUFFIX}",
    }


def build_prefix_index(root_name, groups, criteria):
    """Map rating tag prefix -> stable criterion id.

    Legacy name-only prefixes may collide when different categories reuse the
    same display name. Those aliases are represented by ``None`` and are never
    migrated silently.
    """
    owners = defaultdict(set)
    for criterion in criteria:
        for prefix in _prefixes_for_criterion(root_name, groups, criterion):
            owners[prefix].add(criterion["id"])
    return {
        prefix: next(iter(ids)) if len(ids) == 1 else None
        for prefix, ids in owners.items()
    }


def _parse_score_tag(tag_name):
    if not isinstance(tag_name, str) or ":" not in tag_name:
        return None
    prefix, raw_score = tag_name.rsplit(":", 1)
    raw_score = raw_score.strip()
    if raw_score not in {"0", "1", "2", "3", "4", "5"}:
        return None
    return prefix.strip(), int(raw_score)


def migration_values_for_entity(entity, domain, prefix_index):
    """Return structured values to add plus per-entity migration counters.

    Existing structured rating or N/A state always wins. Multiple legacy tags
    with conflicting scores for the same criterion are reported as ambiguous
    and skipped.
    """
    custom_fields = entity.get("custom_fields") or {}
    scores = defaultdict(set)
    ambiguous_aliases = 0

    for tag in entity.get("tags") or []:
        parsed = _parse_score_tag(tag.get("name"))
        if not parsed:
            continue
        prefix, score = parsed
        if prefix not in prefix_index:
            continue
        criterion_id = prefix_index[prefix]
        if criterion_id is None:
            ambiguous_aliases += 1
            continue
        scores[criterion_id].add(score)

    partial = {}
    stats = {
        "migrated": 0,
        "skipped_existing": 0,
        "ambiguous": ambiguous_aliases,
    }

    for criterion_id, found_scores in scores.items():
        state = storage.read_state(custom_fields, domain, criterion_id)
        if state.is_rated or state.not_applicable:
            stats["skipped_existing"] += 1
            continue
        if len(found_scores) != 1:
            stats["ambiguous"] += 1
            continue
        score = next(iter(found_scores))
        partial[storage.rating_field(domain, criterion_id)] = score
        stats["migrated"] += 1

    return partial, stats


def _update_entity_custom_fields(stash, domain, entity_id, partial):
    if not partial:
        return
    if domain == "scene":
        mutation = """
        mutation RatingMigrationScene($input: SceneUpdateInput!) {
          sceneUpdate(input: $input) { id }
        }
        """
    elif domain == "performer":
        mutation = """
        mutation RatingMigrationPerformer($input: PerformerUpdateInput!) {
          performerUpdate(input: $input) { id }
        }
        """
    else:
        raise ValueError(f"Unsupported migration domain: {domain}")

    stash.call_GQL(mutation, {
        "input": {
            "id": str(entity_id),
            "custom_fields": {"partial": partial},
        }
    })


def migrate_domain(stash, domain, entities, root_name, groups, criteria, log):
    prefix_index = build_prefix_index(root_name, groups, criteria)
    totals = {
        "entities": len(entities),
        "updated_entities": 0,
        "migrated": 0,
        "skipped_existing": 0,
        "ambiguous": 0,
        "failed": 0,
    }

    for entity in entities:
        partial, stats = migration_values_for_entity(entity, domain, prefix_index)
        totals["migrated"] += stats["migrated"]
        totals["skipped_existing"] += stats["skipped_existing"]
        totals["ambiguous"] += stats["ambiguous"]
        if not partial:
            continue
        try:
            _update_entity_custom_fields(stash, domain, entity.get("id"), partial)
            totals["updated_entities"] += 1
        except Exception as exc:
            totals["failed"] += 1
            # Values for a failed entity did not actually migrate.
            totals["migrated"] -= len(partial)
            log.error(
                f"RATING DATA MIGRATION: Failed {domain} {entity.get('id', '?')}: {exc}"
            )

    log.info(
        "RATING DATA MIGRATION: "
        f"{domain}: {totals['updated_entities']}/{totals['entities']} entities updated, "
        f"{totals['migrated']} ratings migrated, "
        f"{totals['skipped_existing']} existing structured values preserved, "
        f"{totals['ambiguous']} ambiguous values skipped, "
        f"{totals['failed']} entity updates failed."
    )
    return totals


def migrate_all(stash, scene_model, performer_model, log):
    """Migrate scene and performer score tags without deleting legacy tags.

    ``scene_model`` / ``performer_model`` are dicts containing ``groups``,
    ``criteria`` and ``root_name``. Keeping model loading outside this module
    avoids coupling migration logic to plugin configuration defaults.
    """
    scenes = stash.find_scenes(
        {}, get_count=False,
        fragment="id title tags { id name } custom_fields",
    )
    performers = stash.find_performers(
        {}, get_count=False,
        fragment="id name tags { id name } custom_fields",
    )

    return {
        "scene": migrate_domain(
            stash, "scene", scenes,
            scene_model["root_name"], scene_model["groups"], scene_model["criteria"], log,
        ),
        "performer": migrate_domain(
            stash, "performer", performers,
            performer_model["root_name"], performer_model["groups"], performer_model["criteria"], log,
        ),
    }
