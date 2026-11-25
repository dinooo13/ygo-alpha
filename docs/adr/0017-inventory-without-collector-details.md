# 0017: Inventory without collector details

## Status

Accepted

Partly superseded by [0034](0034-inventory-printings.md) for the printing
only (decisions 1, 2 and 4): a stack can carry its set code and rarity
again, and the grain is `(user_id, catalog_card_id, collection_id, set_code,
rarity)`. Language, condition and edition stay out.

Supersedes the collector parts of [0002](0002-owned-card-inventory-data-model.md):
the owned-card grain tuple, the validation of language, condition and edition,
and the use of `printing_id`. Supersedes the UI-credit part of decision 7 in
[0015](0015-german-card-data.md).

Note (round 6, #148): decision 2's reason holds for `printing_id` only. Its
foreign key is a table-level `FOREIGN KEY (printing_id) REFERENCES
catalog_printing(id)` clause (migration 0002), and SQLite refuses
`ALTER TABLE … DROP COLUMN` for a column named in such a clause ("unknown
column … in foreign key definition"), so dropping it still needs a table
rebuild. `language`, `condition` and `edition` have no foreign key and no
index; they could be dropped with a plain `DROP COLUMN`, like
`assistant_conversation.deck_id` in migration 0017, whose foreign key is a
column constraint. All four columns stay for now (owner decision, 2026-09-25).

## Context

The inventory exists for tournaments and for knowing what you own. It is not a
collector's or seller's tool. The owner decided that the inventory should stop
asking for collector details: the set printing, the printing language, the
condition and the edition (#89).

The owner's own database shows that these fields go unused: of 88 owned-card
rows, 3 have a printing, none is non-English, none is non-Near-Mint and 1 has
a non-default edition. The fields still cost a lot. Every add dialog, quick
entry row, list row, filter panel and assistant proposal carries three or four
extra controls. Set names and rarities come from YGOPRODeck in English only and
clash with the German card names (ADR 0015). And the card picker loaded every
printing of every hit just to fill the printing select (#75).

## Decision

1. **Grain.** `owned_card` holds one row per
   `(user_id, catalog_card_id, collection_id)`, with `quantity` and `note`.
   Adding a card that already has a row in that collection (or in none)
   increases its quantity; editing a row into another row's tuple merges them.
   The rest of 0002 (UUID ids, the ownership boundary, the app-level upsert)
   stays.
2. **The columns stay, unused.** `printing_id` is always NULL, and `language`,
   `condition` and `edition` always hold their defaults (`en`, `near_mint`,
   `unlimited`). `printing_id` is a foreign key, and dropping it would need a
   SQLite table rebuild; keeping four idle columns is cheaper and keeps the
   way back open. Writes never set them and reads never select them: the API
   returns owned cards without them (`toOwnedCardView`). Request bodies and
   stored assistant actions that still carry `printing_id`/`printingId`,
   `language`, `condition` or `edition` are accepted and the keys are ignored,
   so old PWA clients and already proposed `add_to_inventory` actions keep
   working.
3. **Migration 0014 merges the existing rows.** Rows that now share a tuple
   are merged: the quantities are summed, the distinct (trimmed, non-blank)
   notes are joined with a newline in the order they were first used, the
   oldest row (`created_at`, then `id`) is kept, and its `updated_at` becomes
   the latest of the group. Then every row's collector columns are reset to
   their defaults. The migration is plain SQL without a table rebuild, and a
   second run changes nothing.
4. **The catalog keeps sets and printings.** The catalog's set filter, the
   printings list in the card detail and formats that depend on sets (GOAT)
   are unchanged. Quick entry still recognizes set codes and passcodes, but a
   set code only identifies the card; no printing is stored. The inventory's
   own set filter and its language/condition/edition filters are removed.
5. **Assistant.** The `add_to_inventory` tool takes `catalogCardId`, `quantity`
   and an optional `collectionId`. The action card shows only those columns.
6. **Source credit.** The German card-text source credit is removed from the
   card detail UI (implemented with #87/#88). The README credit, the source's
   isolation and the exit path of 0015 stay.

## Consequences

- The merge can't be undone. The owner accepted that; it affects about 4 of 88
  rows in the owner's database and one group in the public demo.
- Merged quantities are not capped at `MAX_QUANTITY` (999), because a cap would
  lose cards. A merged stack above 999 would make an edit of that row fail
  with a 400. That is unlikely in practice.
- Bringing collector tracking back needs a new ADR. The columns are still
  there, so it would not need a schema change to start.
- The card picker (`searchCatalogCards`) and the quick-entry candidates no
  longer load printings, which also resolves #75.
- The inventory is simpler to use and to translate: no English-only set names
  or rarities appear next to German card names.

## Relationship to other ADRs

- [0001](0001-card-catalog-data-model.md): the catalog's sets and printings are
  unchanged; only the inventory stops referencing them.
- [0002](0002-owned-card-inventory-data-model.md): partly superseded (the
  grain, the collector validation and `printing_id`).
- [0007](0007-sharing-and-profile-model.md): shared card lists already dropped
  notes and conditions; nothing changes for them. The public inventory's
  `source` is now `{ kind: 'inventory' }` without a server-made display name
  (#68).
- [0015](0015-german-card-data.md): the UI credit of decision 7 is superseded;
  the rest stays.
