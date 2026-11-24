# 0034: Printings in the inventory

## Status

Accepted

Partly supersedes [0017](0017-inventory-without-collector-details.md),
decisions 1, 2 and 4, for the printing only: an owned-card stack can carry its
printing again, and the printing is part of the stack's identity. Language,
condition and edition stay out, as 0017 decided. Changes the key of
`catalog_printing` from [0001](0001-card-catalog-data-model.md).

## Context

ADR 0017 (#89) took the printing out of the inventory because almost nobody
filled it in. A tester asked for it back (#176): with about 30 Blue-Eyes White
Dragons from different sets in the inventory, they want to see which versions
they own, and later prices will need the printing too. They had stopped
entering cards because a set code typed into quick entry found the card but
was not stored.

The catalog already had the printings, but its key was wrong for this.
`catalog_printing.id` was the bare set code, and the sync upserted on it. The
full YGOPRODeck response (2026-11-24) has 44,866 printings under 38,674
distinct set codes: one set code often comes in several rarities (Blue-Eyes
White Dragon: 78 printings, 69 set codes; LC01-EN004 is an Ultra Rare in
"Legendary Collection" and a Quarter Century Secret Rare in its 25th
anniversary edition). The sync kept only the last of them. Two more facts
shape the new key:

- `set_rarity_code` ("(UR)") is empty for 1,490 printings (mostly Quarter
  Century Secret Rare), so set code + rarity code still collides there.
- Nine set codes are listed under two different cards (BLCR-EN015 for both
  "Advanced Crystal Beast Cobalt Eagle" and "… Sapphire Pegasus"). With the
  set code as the key, the upsert even moved such a printing from one card to
  the other.

The card id, set code and rarity (code, else name) are unique across the
whole response.

## Decision

1. **Printing key.** `catalog_printing.id` is
   `<card id>|<set code>|<rarity>` (`printingKey` in `shared/printing.ts`),
   where the rarity is the rarity code without parentheses ("UR"), or the
   rarity name when YGOPRODeck has no code. The new column `rarity_code`
   stores the code (NULL when there is none). Every printing survives the
   sync now, and the id stays a text primary key, so
   `owned_card.printing_id`'s foreign key keeps pointing at it.
2. **Migration 0019** adds `rarity_code`, an index on
   `owned_card.printing_id`, and re-keys the existing printings to the new
   form with the rarity name standing in for the unknown code. It is plain SQL
   without a table rebuild: neither foreign key changes, and a rebuild inside
   the migrator's transaction would cascade (see ADR 0017's note and
   migration 0017). Printings an owned card references are not re-keyed; ADR
   0017 kept `printing_id` NULL, so there are none. The next catalog sync adds
   every printing under its final key and prunes the rest. No owned-card row
   changes.
3. **Grain.** `owned_card` holds one row per
   `(user_id, catalog_card_id, collection_id, printing_id)`. `printing_id` is
   optional; NULL means "printing unknown" and is a stack of its own, like a
   NULL collection. Existing rows keep NULL. The app-level upsert of ADR 0002
   and 0017 stays: adding copies to an existing tuple adds up, an edit into
   another row's tuple merges (quantities summed, notes joined). This holds
   for add, edit, bulk add (quick entry), moving between collections (a split
   keeps the printing), "Sammlung aus Deck befüllen" (it takes from every
   printing stack of a source collection) and the assistant's
   `add_to_inventory`.
4. **Validation.** A `printing_id`/`printingId` in a request must be a
   printing of the card, else 400 `printing_not_found`. A PATCH that changes
   the card without a new printing clears it. Stored assistant actions are
   lenient instead: a printing that is not (or no longer) the card's is
   dropped and the copies are added as "printing unknown", so actions from
   before ADR 0017 (bare set codes) still apply.
5. **The sync keeps the user's printing.** Before printings are pruned, an
   owned stack on a pruned printing moves to the listed printing of the same
   card with the same set code and rarity code (else rarity name, else the
   only one with that set code), else to "printing unknown"; a colliding
   stack merges. A retired card's stacks move to the replacement's matching
   printing the same way.
6. **Decks don't care.** Availability still sums by card across all
   printings and collections (ADR 0004, 0017); nothing in the deck code reads
   the printing.
7. **UI.** "Karte hinzufügen" has an optional, searchable printing picker
   (set code and rarity, the set name below). The card's detail panel edits
   each stack's printing. Quick entry preselects the printing of a set code
   when the card has one rarity under it and asks for the rarity when there
   are several; "Printing unbekannt" stays possible. "Liste" rows show the
   printing, "Galerie" tiles the known printings with their copies, and the
   inventory filter has "Set / Printing" (the sets of the owned printings and
   "Printing unbekannt", as a row filter). The assistant's tool takes an
   optional `printingId` from `get_card`'s printings, and the action card
   shows the printing.

## Consequences

- Set names and rarities are English (YGOPRODeck), next to German card
  names. ADR 0017 named that a cost; it is accepted for the printing, which
  is optional.
- Between the deploy and the next catalog sync the catalog has at most one
  printing per set code, as before.
- A printing YGOPRODeck renames beyond recognition (another set code) falls
  back to "printing unknown" on the next sync; the copies stay.
- Images per printing are out of scope (#176 stays open for them): tiles and
  rows keep showing the card's primary artwork (ADR 0025). Prices per
  printing are out of scope too.
- Language, condition and edition stay unused, as 0017 decided.

## Relationship to other ADRs

- [0001](0001-card-catalog-data-model.md): the printing key changes from the
  set code to card + set code + rarity; `rarity_code` is new.
- [0002](0002-owned-card-inventory-data-model.md): `printing_id` is a real
  reference again; the rest of 0017's changes to 0002 stay.
- [0017](0017-inventory-without-collector-details.md): decisions 1, 2 and 4
  are superseded for the printing only.
- [0032](0032-collections-built-by-moving-copies.md): moves keep the
  printing; collections still partition the copies.
