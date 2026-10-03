-- ADR 0028: per-tournament scoring and bye scoring, and withdrawing a
-- participant from the standings. New tournaments get the column defaults
-- ('games' scoring, no points for a bye); every tournament that exists now
-- was played under the old rules, so it is backfilled to keep its standings
-- exactly as they were (3/0 match points, a bye worth a 2:0 win).
ALTER TABLE `tournament` ADD `scoring` text DEFAULT 'games' NOT NULL;--> statement-breakpoint
ALTER TABLE `tournament` ADD `bye_scoring` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `tournament_participant` ADD `withdrawn` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `tournament` SET `scoring` = 'match', `bye_scoring` = 'win';
