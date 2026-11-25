-- #176 (ADR 0034): an owned stack records the set code and the rarity of its
-- copies, both optional and part of the stack's identity; `catalog_printing`
-- gets the rarity key YGOPRODeck's rarity text maps to.
-- Plain ADD COLUMN and CREATE INDEX, no table rebuild (a rebuild would run
-- inside the migrator's transaction, where `PRAGMA foreign_keys=OFF` has no
-- effect; see 0017). Existing rows keep NULL ("unknown"). The printings keep
-- their old ids (the bare set code) until the next catalog sync adds them
-- under `<card id>|<set code>|<rarity>` and prunes the old rows; nothing
-- references them (`owned_card.printing_id` has been NULL since ADR 0017).
ALTER TABLE `catalog_printing` ADD `rarity_key` text;--> statement-breakpoint
ALTER TABLE `owned_card` ADD `set_code` text;--> statement-breakpoint
ALTER TABLE `owned_card` ADD `rarity` text;--> statement-breakpoint
CREATE INDEX `idx_owned_card_set_code` ON `owned_card` (`catalog_card_id`,`set_code`);