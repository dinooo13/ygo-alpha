# 0002: Owned-card inventory data model

## Status

Accepted

Partly superseded by [0017](0017-inventory-without-collector-details.md): the
owned-card grain no longer includes printing, language, condition or edition;
those columns stay but are unused. [0034](0034-inventory-printings.md) brings
the printing back: the grain is `(user_id, catalog_card_id, collection_id,
printing_id)`, with `printing_id` optional.

## Context

Phase 1 of the [Roadmap](../Roadmap.md) requires users to record the cards
they own. The global catalog already models canonical card, set, printing,
and image data. Inventory data must stay separate from the catalog because
ownership-specific attributes such as quantity, language, condition, edition,
and future storage assignment belong to a user, not to the global card.

This is the first user-owned domain schema and the first server-side pattern
for enforcing an ownership boundary around domain records.

## Decision

### Owned-card grain

`owned_card` stores one row per user and card-attribute tuple:

`(user_id, catalog_card_id, printing_id, language, condition, edition)`

The row carries a `quantity` count. A stack of identical cards is one row,
while cards that differ in printing, language, condition, or edition become
separate rows. This matches how collectors describe inventory and keeps later
deck-availability checks a simple sum by `catalog_card_id`.

### Identity and references

`owned_card.id` is a text UUID surrogate primary key. It gives PATCH, DELETE,
and future child tables a stable URL-friendly target while keeping the
natural tuple available for app-level deduplication.

`owned_card.catalog_card_id` references `catalog_card.id`, and nullable
`owned_card.printing_id` references `catalog_printing.id`. The inventory never
copies catalog names, types, or images into owned rows; list endpoints join
that display data from the catalog.

### Ownership boundary

`owned_card.user_id` is a required foreign key to `user.id` with cascade
delete. Every inventory endpoint resolves the authenticated Better Auth
session through `requireUser(event)` and filters reads, updates, and deletes
by that session user's id. Attempts to update or delete another user's row
return 404, so cross-user inventory existence is not exposed.

### Validation and deduplication

Language, condition, and edition are text columns validated by server-side
allowed lists. This avoids a new validation dependency while keeping the data
queryable. Quantity must be at least 1; DELETE is the explicit removal path.

SQLite's nullable values make a composite unique index over the natural tuple
unreliable when `printing_id` is null. Instead, the server performs an
app-level upsert: adding an existing tuple increments `quantity`, and editing
a row into another existing tuple merges the quantities and deletes the old
row.

## Consequences

- Inventory rows preserve the roadmap separation between catalog cards and
  owned cards.
- Future deckbuilding can compare requested deck card counts with
  `sum(owned_card.quantity)` per user and catalog card.
- Server-side session resolution and per-user query scoping become the
  pattern for later user-owned resources.
- The app must keep inventory writes on the API path so validation and
  deduplication are always applied consistently.
