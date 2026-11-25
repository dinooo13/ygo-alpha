# 0034: Printings in the inventory

## Status

Accepted

Partly supersedes [0017](0017-inventory-without-collector-details.md),
decisions 1, 2 and 4, for the printing only: an owned-card stack can carry
its set code and rarity again, and both are part of the stack's identity.
Language, condition and edition stay out, as 0017 decided. Changes the key of
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

YGOPRODeck's rarities themselves are not reliable data. There is no list of
them, only free text per entry: Quarter Century Secret Rare (1,036
printings), Platinum Secret Rare (spelled "PLatinum"), Starfoil and a few
more never have a code, and 261 entries name no rarity at all ("New" 119,
"2" 53, "3" 41, "Reprint", "European debut"). So which rarities exist for a
set code is a good suggestion, but not strict enough to forbid a choice.
Yugipedia keeps a curated table of every rarity with its abbreviation and
the spellings it accepts (`Module:Data/static/rarity/data`, 67 rarities);
with it, 44,605 of the 44,866 printings map onto a known rarity, all but the
noise and "Ultra Rare (Pharaoh's Rare)", which needed one more alias. Names
and codes never contradict each other.

## Decision

1. **Rarity list.** `shared/rarity.ts` holds the 67 rarities from
   Yugipedia's table (fetched 2026-11-25): a stable key ("qcscr"), the
   abbreviation ("QCScR"), the English name as printed and a group for the
   picker. `normalizeRarity` maps any spelling or abbreviation onto a key;
   text that names no rarity maps to none. Rarity names stay English, as on
   the cards and in German trade.
2. **Printing key.** `catalog_printing.id` is
   `<card id>|<set code>|<rarity>` (`printingKey` in `shared/printing.ts`),
   where the rarity is the rarity key, or YGOPRODeck's text when it names
   none. The new column `rarity_key` stores the key (NULL for none). Every
   printing survives the sync now; YGOPRODeck's text stays in `rarity`.
3. **A stack stores set code and rarity.** `owned_card` gets `set_code` and
   `rarity` (a rarity key), both optional and independent: NULL means
   "unknown". The grain is
   `(user_id, catalog_card_id, collection_id, set_code, rarity)`. A stack
   does not point at a `catalog_printing` row: the set code must be one of
   the card's (400 `set_code_not_found`, matched in any case and stored as
   the catalog spells it), the rarity one of the list (400
   `rarity_not_found`), but any combination is allowed, since the user may
   own a rarity YGOPRODeck does not list. The legacy `printing_id` stays
   NULL (SQLite cannot drop a column with a foreign key).
4. **Merging.** The app-level upsert of ADR 0002 and 0017 stays: adding
   copies to an existing tuple adds up, an edit into another row's tuple
   merges (quantities summed, notes joined). This holds for add, edit, bulk
   add (quick entry), moving between collections (a split keeps set code
   and rarity), "Sammlung aus Deck befüllen" (it takes from every printing
   stack of a source collection) and the assistant's `add_to_inventory`. A
   PATCH that changes the card without a new set code clears the set code
   and keeps the rarity. Stored assistant actions are lenient: a set code
   the card no longer lists or an unknown rarity is dropped, so the copies
   are added with that part unknown.
5. **Migration 0019** only adds `owned_card.set_code`, `owned_card.rarity`,
   an index on `(catalog_card_id, set_code)` and `catalog_printing.rarity_key`;
   no table rebuild (see ADR 0017's note and migration 0017), no owned row
   changes. The printings keep their old ids until the next catalog sync
   adds them under the new keys and prunes the rest; nothing references
   them.
6. **The sync never touches a stack's printing.** Set code and rarity are
   the user's text, so pruning or re-keying printings changes no stack. A
   retired card's stacks move to the replacement card and keep their set
   code when the replacement lists it (else it becomes unknown) and always
   their rarity; a colliding stack merges.
7. **Decks don't care.** Availability still sums by card across all
   printings and collections (ADR 0004, 0017).
8. **UI.** "Karte hinzufügen" and each stack in the card's detail panel have
   a set code picker (searchable, set name below) and a rarity picker: the
   rarities YGOPRODeck lists for the chosen set code first, then "Andere
   Seltenheit…", which opens the full list by group; without a set code or
   without usable data for it, the full list shows at once. A set code with
   a single listed rarity picks it. Quick entry does the same under a typed
   set code: a single rarity is preselected, several ask for a pick, none
   leave it open. "Liste" rows show "LC01-EN004 (QCScR)" (the set name on
   hover), "Galerie" tiles the known printings with their copies, and the
   inventory filter has "Set / Printing" (the sets of the owned set codes
   and "Printing unbekannt", as a row filter). The assistant's tool takes an
   optional `setCode` and `rarity`, and the action card shows the printing.

## Consequences

- Set names and rarities are English (YGOPRODeck), next to German card
  names. ADR 0017 named that a cost; it is accepted for the printing, which
  is optional.
- Between the deploy and the next catalog sync the catalog has at most one
  printing per set code and no rarity keys, so the pickers offer the full
  rarity list.
- A set code YGOPRODeck drops stays on the stack as text, without a set
  name; it can no longer be picked anew.
- A reprint can reuse a set code under another set name (LC01-EN004 in
  "Legendary Collection" and its 25th anniversary edition). The set name of
  a stack follows its rarity; the set filter finds the stack under both
  sets.
- New rarities need an entry in `shared/rarity.ts`; until then the sync
  stores them without a key and the picker cannot offer them.
- Images per printing are out of scope (#176 stays open for them): tiles and
  rows keep showing the card's primary artwork (ADR 0025). Prices per
  printing are out of scope too.
- Language, condition and edition stay unused, as 0017 decided.

## Relationship to other ADRs

- [0001](0001-card-catalog-data-model.md): the printing key changes from the
  set code to card + set code + rarity; `rarity_key` is new.
- [0002](0002-owned-card-inventory-data-model.md): the grain gains
  `set_code` and `rarity`; `printing_id` stays unused; the rest of 0017's
  changes to 0002 stay.
- [0017](0017-inventory-without-collector-details.md): decisions 1, 2 and 4
  are superseded for the printing only.
- [0032](0032-collections-built-by-moving-copies.md): moves keep set code
  and rarity; collections still partition the copies.
