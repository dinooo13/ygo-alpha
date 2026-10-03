# 0030: Collections are built by moving copies out of the inventory

## Status

Accepted. Builds on [ADR 0017](0017-inventory-without-collector-details.md) (the
owned-card grain) and leaves [ADR 0004](0004-deck-data-model.md) (decks reference
catalog cards, availability is computed on read) as it is.

## Context

Testers wanted the inventory first and the collections after it: record
everything once (quick entry), then build one collection per deck (about 70
cards across main, extra and side) and pick cards from such a collection when
building a deck. They ran into three gaps:

- After a quick entry saved into collection A, the review list was gone. To also
  have the cards in collection B they had to type the list in again.
- A stack can only move to another collection as a whole
  (`PATCH /api/inventory/:id`); there is no partial and no bulk move.
- The deck builder's card source ignored collections, and a collection filter
  on the inventory search only chooses which cards qualify while the quantities
  still sum every collection.

The owner's decision: **the inventory is the master list; collections are built
by moving copies into them.** No double counting, no overlapping collections.

## Decision

1. **Collections partition the copies.** This is what ADR 0017 already
   models: a copy is in exactly one collection (or none), the inventory is the
   union, and a card's total is the sum over all rows. Nothing changes in the
   schema, and no migration is needed. "Putting a card into a second
   collection" is not a thing; the copy moves.
2. **One move primitive.** `POST /api/inventory/move` takes up to 200
   `{ ownedCardId, quantity?, toCollectionId }` items and applies them in one
   transaction. A partial move splits the stack (the note stays with the stack
   it was written on); a whole stack is re-pointed, or merged into the target's
   stack with the same note joining as an edit (ADR 0017 §3). Stacks, target
   collections and quantities are validated first and reported per item like
   the bulk endpoint; a target equal to the stack's collection is an error, so
   the UI leaves such entries out. The answer says which stack each item ended
   up in, so a caller can follow the copies.
3. **Everything else is a client of the move.**
   - The inventory list moves one stack (quantity stepper) or a selection of
     whole stacks.
   - The quick entry keeps a "gerade gespeichert" panel with the stacks the
     bulk answer returned and moves exactly the saved copies. The review table
     is never refilled, so nothing is written twice.
   - "Sammlung aus Deck befüllen" (`POST /api/decks/:id/fill-collection`)
     works out what the deck needs (sum of main, extra and side per card,
     copies already in the target counted), takes it from the chosen source
     collections in priority order ("ohne Sammlung" first by default) and
     moves it with the same code. `dryRun` gives the preview. The answer lists
     per card what moves, what is missing from the chosen sources and what is
     missing from the whole inventory (the part a wishlist entry asks for).
4. **Decks stay plans (ADR 0004).** Filling a collection does not reserve
   copies or link the deck to the collection. The deck header's `owned` and
   shortfall keep summing the whole inventory, so moving copies between
   collections never changes a deck's availability.
5. **The deck builder picks per collection.** The source panel has a "Quelle"
   (all collections, "ohne Sammlung", or one collection). The inventory search
   got a `scoped=1` flag: with it a `collectionId` is a plain row filter, so
   the listed quantities are that collection's copies. Without the flag (the
   inventory page) the collection filter keeps its old, cross-collection
   meaning.

## Consequences

- Moving is the only way to organize collections. Undo is a move back.
- The deck fill is a best-effort plan from the current stacks. Running it twice
  moves nothing the second time, and copies left in excluded collections are
  reported, not taken.
- A deck that needs more than the user owns shows a shortfall instead of
  failing; the cards owned nowhere can go to the wishlist from the same dialog.
- A "reserve these copies for this deck" model would need an allocation layer
  that ADR 0004 deliberately leaves out; it stays out of scope.
