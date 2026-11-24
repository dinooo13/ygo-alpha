-- #176 (ADR 0034): printings come back to the inventory.
-- No table rebuild: `owned_card.printing_id` keeps its foreign key to
-- `catalog_printing(id)` (table-level clause from 0002), and `id` stays the
-- primary key of `catalog_printing`; only its values change. A rebuild of
-- either table would run inside the migrator's transaction, where
-- `PRAGMA foreign_keys=OFF` has no effect (see 0017).
ALTER TABLE `catalog_printing` ADD `rarity_code` text;--> statement-breakpoint
CREATE INDEX `idx_owned_card_printing` ON `owned_card` (`printing_id`);--> statement-breakpoint
-- Re-key the existing printings from the bare set code to
-- `<card id>|<set code>|<rarity>` (`printingKey`, shared/printing.ts). The
-- rarity code is not known yet, so the rarity name stands in, which is the
-- key the sync gives a printing without a rarity code. The next catalog sync
-- adds every printing under its final key and prunes the rest. Printings an
-- owned card references are left alone (ADR 0017 kept `printing_id` NULL, so
-- there are none); re-keying them would break the foreign key.
UPDATE `catalog_printing`
SET `id` = `card_id` || '|' || trim(`set_code`) || '|' || coalesce(trim(`rarity`), '')
WHERE `id` NOT IN (SELECT `printing_id` FROM `owned_card` WHERE `printing_id` IS NOT NULL);
