"""Structured per-entity rating storage helpers.

Advanced Rating stores criterion values in Stash custom fields so values can be
queried numerically instead of being encoded in tags.

The persisted key format uses only stable domain + criterion identifiers; user-
visible category/criterion names are deliberately excluded so renames do not
orphan data.
"""

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional


FIELD_PREFIX = "advancedRating"
RATING_SEGMENT = "rating"
NA_SEGMENT = "na"
VALID_DOMAINS = {"scene", "performer"}
MIN_SCORE = 0
MAX_SCORE = 5


@dataclass(frozen=True)
class CriterionState:
    """Normalized state for one criterion on one scene/performer."""

    value: Optional[int] = None
    not_applicable: bool = False

    @property
    def is_unrated(self) -> bool:
        return self.value is None and not self.not_applicable

    @property
    def is_rated(self) -> bool:
        return self.value is not None and not self.not_applicable


def _validate_domain(domain: str) -> str:
    normalized = (domain or "").strip().lower()
    if normalized not in VALID_DOMAINS:
        raise ValueError(f"Unsupported rating domain: {domain!r}")
    return normalized


def _validate_criterion_id(criterion_id: str) -> str:
    value = (criterion_id or "").strip()
    if not value:
        raise ValueError("criterion_id must not be empty")
    if "." in value:
        raise ValueError("criterion_id must not contain '.'")
    return value


def rating_field(domain: str, criterion_id: str) -> str:
    return f"{FIELD_PREFIX}.{_validate_domain(domain)}.{RATING_SEGMENT}.{_validate_criterion_id(criterion_id)}"


def na_field(domain: str, criterion_id: str) -> str:
    return f"{FIELD_PREFIX}.{_validate_domain(domain)}.{NA_SEGMENT}.{_validate_criterion_id(criterion_id)}"


def _coerce_score(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        score = value
    elif isinstance(value, float) and value.is_integer():
        score = int(value)
    elif isinstance(value, str):
        raw = value.strip()
        if not raw or not raw.lstrip("-").isdigit():
            return None
        score = int(raw)
    else:
        return None
    if MIN_SCORE <= score <= MAX_SCORE:
        return score
    return None


def read_state(custom_fields: Optional[Mapping[str, Any]], domain: str, criterion_id: str) -> CriterionState:
    """Read a normalized criterion state from a Stash custom_fields map.

    N/A wins if both fields are present. Writers in this module never create
    that conflict, but deterministic reads make recovery from manual edits safe.
    """

    fields = custom_fields or {}
    if fields.get(na_field(domain, criterion_id)) is True:
        return CriterionState(value=None, not_applicable=True)
    return CriterionState(
        value=_coerce_score(fields.get(rating_field(domain, criterion_id))),
        not_applicable=False,
    )


def set_rating_input(domain: str, criterion_id: str, score: int) -> Dict[str, Any]:
    """Return GraphQL CustomFieldsInput for storing an explicit 0-5 rating."""

    normalized = _coerce_score(score)
    if normalized is None:
        raise ValueError(f"score must be an integer from {MIN_SCORE} through {MAX_SCORE}")
    return {
        "partial": {rating_field(domain, criterion_id): normalized},
        "remove": [na_field(domain, criterion_id)],
    }


def clear_rating_input(domain: str, criterion_id: str) -> Dict[str, Any]:
    """Return GraphQL CustomFieldsInput for the Unrated state."""

    return {
        "remove": [
            rating_field(domain, criterion_id),
            na_field(domain, criterion_id),
        ]
    }


def set_not_applicable_input(domain: str, criterion_id: str) -> Dict[str, Any]:
    """Return GraphQL CustomFieldsInput for the per-entity N/A state."""

    return {
        "partial": {na_field(domain, criterion_id): True},
        "remove": [rating_field(domain, criterion_id)],
    }


def numeric_filter_field(domain: str, criterion_id: str) -> str:
    """Field name to use with Stash CustomFieldCriterionInput filters."""

    return rating_field(domain, criterion_id)
