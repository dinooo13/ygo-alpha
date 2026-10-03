import { relations } from 'drizzle-orm'
import { sqliteTable, text, integer, index, primaryKey, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { AssistantActionKind } from '../../shared/assistant-chat'
import type { AssistantMessageMetadata, AssistantUIMessagePart } from '../../shared/assistant-ui'
import type { RuleSet } from '../../shared/rule-formats'
import type { AppLocale } from '../../shared/locale'
import type { ShareResourceType, Visibility, WishlistVisibility } from '../../shared/sharing'
import type { ByeScoring, PairingSystem, ScoringSystem, TournamentDeckSnapshot, TournamentStatus } from '../../shared/tournaments'

// Better Auth core tables (email/password only).
// Generated to match Better Auth's expected schema for the Drizzle adapter (provider: "sqlite").
// See: https://www.better-auth.com/docs/adapters/drizzle

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// Global card catalog (see docs/adr/0001-card-catalog-data-model.md).
//
// The catalog is the canonical, global reference for known Yu-Gi-Oh cards,
// imported from the YGOPRODeck API. It is intentionally separate from any
// user-owned card concept (Roadmap "Key Product Principle"): nothing here
// references `user`, and owned-card tables (a later phase) will reference
// `catalogCard`/`catalogPrinting` instead of the other way around.

export const catalogCard = sqliteTable(
  'catalog_card',
  {
    // YGOPRODeck's card `id` (passcode) — stable, globally unique, and the
    // natural upsert target / FK anchor for owned cards later.
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    frameType: text('frame_type'),
    desc: text('desc').notNull(),
    race: text('race'),
    archetype: text('archetype'),
    attribute: text('attribute'),
    atk: integer('atk'),
    def: integer('def'),
    level: integer('level'),
    linkval: integer('linkval'),
    scale: integer('scale'),
    // Variable-length / rarely-queried extras: kept as JSON rather than
    // dedicated child tables (display/rule metadata, not relational data).
    linkMarkers: text('link_markers', { mode: 'json' }).$type<string[]>(),
    banlistInfo: text('banlist_info', { mode: 'json' }).$type<{
      ban_tcg?: string
      ban_ocg?: string
      ban_goat?: string
    }>(),
    cardPrices: text('card_prices', { mode: 'json' }).$type<Record<string, string>>(),
    // ISO date strings (YGOPRODeck `misc_info[].tcg_date`/`ocg_date`), kept
    // as text and indexed so Phase 4 release-date format rules can filter on them.
    tcgDate: text('tcg_date'),
    ocgDate: text('ocg_date'),
    ygoprodeckUrl: text('ygoprodeck_url'),
    syncedAt: integer('synced_at', { mode: 'timestamp' }).notNull(),
    // Konami's own card id (YGOPRODeck `misc_info[0].konami_id`), the join key
    // to the German card data (ADR 0015). Not unique: one Konami id can map to
    // several passcodes. Only filled by a `catalog:sync` run.
    konamiId: integer('konami_id'),
    // `foldCardName(name)` (shared/card-name-fold.ts): lowercase, no accents,
    // no spaces or punctuation. '' until the startup backfill has run.
    nameSearch: text('name_search').notNull().default(''),
    // Retired cards (ADR 0019): NULL = active, i.e. listed by the latest
    // YGOPRODeck sync. Otherwise the time of the sync that first found the
    // card missing. Catalog-wide searches hide retired rows; references and
    // lookups by id keep resolving them. No index: almost every row is NULL.
    retiredAt: integer('retired_at', { mode: 'timestamp' }),
    // The active card this retired row was renumbered to (same Konami id, or
    // the same name and type), or NULL. The sync moves references to it.
    replacedById: integer('replaced_by_id')
      .references((): AnySQLiteColumn => catalogCard.id, { onDelete: 'set null' }),
  },
  table => [
    index('idx_catalog_card_name').on(table.name),
    index('idx_catalog_card_type').on(table.type),
    index('idx_catalog_card_attribute').on(table.attribute),
    index('idx_catalog_card_tcg_date').on(table.tcgDate),
    index('idx_catalog_card_konami_id').on(table.konamiId),
  ],
)

/** Where a `catalog_card_translation` row came from (ADR 0015). */
export type CardTranslationSource = 'ygoresources-git'

// A card's name and text in another language (ADR 0015). English stays on
// `catalog_card` (YGOPRODeck); German comes from the ygoresources card-history
// repo, joined through `catalog_card.konami_id`. No row means "show English".
export const catalogCardTranslation = sqliteTable(
  'catalog_card_translation',
  {
    cardId: integer('card_id')
      .notNull()
      .references(() => catalogCard.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull().$type<AppLocale>(),
    name: text('name').notNull(),
    // `foldCardName(name)`, for accent- and case-insensitive name search.
    nameSearch: text('name_search').notNull(),
    desc: text('desc'),
    source: text('source').notNull().$type<CardTranslationSource>(),
    syncedAt: integer('synced_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    primaryKey({ columns: [table.cardId, table.locale] }),
    // Covering index for `locale = ? AND name_search LIKE ?` → card_id.
    index('idx_catalog_card_translation_search').on(table.locale, table.nameSearch, table.cardId),
  ],
)

// A set is identified by its name (YGOPRODeck's `card_sets[].set_name`);
// `id` is a slug derived from that name (see server/utils/ygoprodeck.ts).
export const catalogSet = sqliteTable('catalog_set', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
})

// A printing is a specific card-in-set appearance (YGOPRODeck `card_sets[]`
// entry): the join between a card and a set, carrying printing-specific
// data. Owned cards will later reference a printing for edition/rarity.
export const catalogPrinting = sqliteTable(
  'catalog_printing',
  {
    // The full per-printing set code (e.g. "SDY-006") is unique across the
    // API and serves as the natural primary key.
    id: text('id').primaryKey(),
    cardId: integer('card_id')
      .notNull()
      .references(() => catalogCard.id, { onDelete: 'cascade' }),
    setId: text('set_id')
      .notNull()
      .references(() => catalogSet.id, { onDelete: 'cascade' }),
    setCode: text('set_code').notNull(),
    rarity: text('rarity'),
    price: text('price'),
  },
  table => [
    index('idx_printing_card').on(table.cardId),
    index('idx_printing_set').on(table.setId),
  ],
)

export const catalogCardImage = sqliteTable(
  'catalog_card_image',
  {
    // YGOPRODeck `card_images[].id` — art variant id.
    id: integer('id').primaryKey(),
    cardId: integer('card_id')
      .notNull()
      .references(() => catalogCard.id, { onDelete: 'cascade' }),
    imageUrl: text('image_url').notNull(),
    imageUrlSmall: text('image_url_small'),
    imageUrlCropped: text('image_url_cropped'),
  },
  table => [index('idx_image_card').on(table.cardId)],
)

// Run log for catalog imports, so a sync's outcome (and card count) is
// observable without tailing logs.
export const catalogSync = sqliteTable('catalog_sync', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
  // `skipped`: the source hadn't changed since the last successful run.
  status: text('status').notNull().$type<'running' | 'success' | 'skipped' | 'error'>(),
  cardCount: integer('card_count'),
  error: text('error'),
  // Which import the run was: the YGOPRODeck card sync or the translation
  // sync (ADR 0015). Rows from before ADR 0015 are all YGOPRODeck runs.
  source: text('source').notNull().default('ygoprodeck').$type<CatalogSyncSource>(),
  // The upstream revision the run imported (the commit SHA for
  // `ygoresources-git`), so an unchanged source can be skipped.
  revision: text('revision'),
})

export type CatalogSyncSource = 'ygoprodeck' | CardTranslationSource

// A user-owned storage location (Box 1, binder, trade pile, ...) that owned
// cards can be assigned to. "Alle Karten" (all cards) is not a stored row —
// it is simply the unfiltered inventory — so only real, user-created
// collections live here. See docs/adr/0002 (additive extension, no new ADR).
export const collection = sqliteTable(
  'collection',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // Sharing state (Phase 6). 'private' is the default for every existing collection.
    visibility: text('visibility').notNull().default('private').$type<Visibility>(),
    // Secret, regenerable link token. NULL while the collection is private.
    shareToken: text('share_token').unique(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    index('idx_collection_user').on(table.userId),
    index('idx_collection_user_visibility').on(table.userId, table.visibility),
  ],
)

export const collectionRelations = relations(collection, ({ one, many }) => ({
  user: one(user, {
    fields: [collection.userId],
    references: [user.id],
  }),
  ownedCards: many(ownedCard),
}))

export const ownedCard = sqliteTable(
  'owned_card',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    catalogCardId: integer('catalog_card_id')
      .notNull()
      .references(() => catalogCard.id, { onDelete: 'cascade' }),
    // Unused since ADR 0017: always NULL. Kept because dropping an FK column
    // would need a table rebuild.
    printingId: text('printing_id')
      .references(() => catalogPrinting.id, { onDelete: 'set null' }),
    // Owning storage location, or NULL = unassigned (not in any collection).
    // Deleting a collection sets this back to NULL so owned cards survive.
    collectionId: text('collection_id')
      .references(() => collection.id, { onDelete: 'set null' }),
    quantity: integer('quantity').notNull().default(1),
    // Unused since ADR 0017: `language`, `condition` and `edition` always hold
    // their defaults. Writes never set them, reads never select them.
    language: text('language').notNull().default('en'),
    condition: text('condition').notNull().default('near_mint'),
    edition: text('edition').notNull().default('unlimited'),
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    index('idx_owned_card_user').on(table.userId),
    index('idx_owned_card_user_card').on(table.userId, table.catalogCardId),
    index('idx_owned_card_collection').on(table.collectionId),
  ],
)

export const ownedCardRelations = relations(ownedCard, ({ one }) => ({
  user: one(user, {
    fields: [ownedCard.userId],
    references: [user.id],
  }),
  catalogCard: one(catalogCard, {
    fields: [ownedCard.catalogCardId],
    references: [catalogCard.id],
  }),
  printing: one(catalogPrinting, {
    fields: [ownedCard.printingId],
    references: [catalogPrinting.id],
  }),
  collection: one(collection, {
    fields: [ownedCard.collectionId],
    references: [collection.id],
  }),
}))

// Rule formats (see docs/adr/0005-rule-format-model.md).
//
// A format is a named list of typed rule predicates stored as JSON and
// evaluated in code (shared/rule-formats.ts). `userId` NULL marks a built-in,
// globally visible format seeded at boot (`seedBuiltinFormats`); a row with a
// `userId` is that user's custom format. Legality is never stored — it is
// computed at read time from the deck, the format's rules, and catalog data.

export const ruleFormat = sqliteTable(
  'rule_format',
  {
    // Fixed slug for built-ins ('tcg-advanced', ...), UUID for custom formats.
    id: text('id').primaryKey(),
    userId: text('user_id')
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    rules: text('rules', { mode: 'json' }).notNull().$type<RuleSet>(),
    isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    index('idx_rule_format_user').on(table.userId),
  ],
)

export const ruleFormatRelations = relations(ruleFormat, ({ one, many }) => ({
  user: one(user, {
    fields: [ruleFormat.userId],
    references: [user.id],
  }),
  decks: many(deck),
}))

// Saved deck constructions (see docs/adr/0004-deck-data-model.md).
//
// A deck is a *construction*, not a set of physical cards: its rows point at
// catalog cards, never at `owned_card` rows. Availability ("do I own enough
// copies?") is derived at read time by summing the user's `owned_card`
// quantities per catalog card, so inventory edits never invalidate a deck.

export const deck = sqliteTable(
  'deck',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // Selected rule format, or NULL for "no format" (deck validation off).
    // Deleting a format un-assigns it instead of deleting decks.
    formatId: text('format_id')
      .references(() => ruleFormat.id, { onDelete: 'set null' }),
    // Cover card chosen by the user (#49, ADR 0012), or NULL = picked by rule. Only
    // used while the card is in the deck's Main/Extra Deck; otherwise the rule applies.
    coverCardId: integer('cover_card_id')
      .references(() => catalogCard.id, { onDelete: 'set null' }),
    // Sharing state (Phase 6). 'private' is the default for every existing deck.
    visibility: text('visibility').notNull().default('private').$type<Visibility>(),
    // Secret, regenerable link token. NULL while the deck is private.
    shareToken: text('share_token').unique(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    index('idx_deck_user').on(table.userId),
    index('idx_deck_format').on(table.formatId),
    index('idx_deck_user_visibility').on(table.userId, table.visibility),
  ],
)

// One row per (deck, catalog card, section) with a `quantity` count, mirroring
// the `owned_card` stacking grain instead of one row per physical copy.
export const deckCard = sqliteTable(
  'deck_card',
  {
    id: text('id').primaryKey(),
    deckId: text('deck_id')
      .notNull()
      .references(() => deck.id, { onDelete: 'cascade' }),
    catalogCardId: integer('catalog_card_id')
      .notNull()
      .references(() => catalogCard.id, { onDelete: 'cascade' }),
    // 'main' | 'extra' | 'side' (see shared/deck-sections.ts).
    section: text('section').notNull().$type<'main' | 'extra' | 'side'>(),
    quantity: integer('quantity').notNull().default(1),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    uniqueIndex('idx_deck_card_unique').on(table.deckId, table.catalogCardId, table.section),
    index('idx_deck_card_deck').on(table.deckId),
  ],
)

export const deckRelations = relations(deck, ({ one, many }) => ({
  user: one(user, {
    fields: [deck.userId],
    references: [user.id],
  }),
  format: one(ruleFormat, {
    fields: [deck.formatId],
    references: [ruleFormat.id],
  }),
  cards: many(deckCard),
}))

export const deckCardRelations = relations(deckCard, ({ one }) => ({
  deck: one(deck, {
    fields: [deckCard.deckId],
    references: [deck.id],
  }),
  catalogCard: one(catalogCard, {
    fields: [deckCard.catalogCardId],
    references: [catalogCard.id],
  }),
}))

// Sharing and profile model (Phase 6, see docs/adr/0007-sharing-and-profile-model.md).

// Public identity for the sharing features. Deliberately NOT columns on
// better-auth's `user` table: that schema is generated to match the Drizzle
// adapter's expectations. The row is created lazily on first read
// (`ensureProfile`), so users registered before Phase 6 need no backfill.
export const userProfile = sqliteTable(
  'user_profile',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    // URL slug, 3–30 chars of [a-z0-9-]; the identity in every /players/:handle route.
    handle: text('handle').notNull().unique(),
    displayName: text('display_name').notNull(),
    bio: text('bio'),
    // Sharing state of the *whole* inventory ("Alle Karten"), the one shareable
    // resource that has no row of its own. resourceId for grants is the user id.
    inventoryVisibility: text('inventory_visibility')
      .notNull()
      .default('private')
      .$type<Visibility>(),
    inventoryShareToken: text('inventory_share_token').unique(),
    // Wishlist is public-or-not only: no token, no per-user grants (see ADR 0007).
    wishlistVisibility: text('wishlist_visibility')
      .notNull()
      .default('private')
      .$type<WishlistVisibility>(),
    // UI language chosen by the user (ADR 0014); null = not chosen → cookie / Accept-Language decide.
    locale: text('locale').$type<AppLocale>(),
    // Card language chosen by the user (ADR 0015); null = follow the interface language.
    cardLocale: text('card_locale').$type<AppLocale>(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    index('idx_user_profile_display_name').on(table.displayName),
  ],
)

export const userProfileRelations = relations(userProfile, ({ one }) => ({
  user: one(user, { fields: [userProfile.userId], references: [user.id] }),
}))

// "Shared with selected users" for any shareable resource. Generic on purpose:
// deck, collection and the whole inventory share one grant mechanism, so the
// sharing API and the share modal are written once.
//
// `resourceId` is polymorphic (deck.id | collection.id | user.id for 'inventory')
// and therefore has NO foreign key. Grants are removed explicitly when the
// resource dies (deleteGrantsForResource in deleteDeck/deleteCollection); both
// user references cascade, so deleting an account removes grants in both roles.
export const shareGrant = sqliteTable(
  'share_grant',
  {
    id: text('id').primaryKey(),
    resourceType: text('resource_type').notNull().$type<ShareResourceType>(),
    resourceId: text('resource_id').notNull(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    grantedUserId: text('granted_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    uniqueIndex('idx_share_grant_unique').on(table.resourceType, table.resourceId, table.grantedUserId),
    index('idx_share_grant_resource').on(table.resourceType, table.resourceId),
    index('idx_share_grant_granted_user').on(table.grantedUserId),
    index('idx_share_grant_owner').on(table.ownerUserId),
  ],
)

export const shareGrantRelations = relations(shareGrant, ({ one }) => ({
  owner: one(user, { fields: [shareGrant.ownerUserId], references: [user.id], relationName: 'shareGrantOwner' }),
  grantedUser: one(user, { fields: [shareGrant.grantedUserId], references: [user.id], relationName: 'shareGrantTarget' }),
}))

// "Cards I am looking for" (Phase 6, the roadmap's optional wishlist concept).
// Like owned_card and deck_card it references the catalog, never an owned row,
// and stacks with a quantity instead of one row per copy.
export const wishlistItem = sqliteTable(
  'wishlist_item',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    catalogCardId: integer('catalog_card_id')
      .notNull()
      .references(() => catalogCard.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull().default(1),
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    uniqueIndex('idx_wishlist_item_unique').on(table.userId, table.catalogCardId),
    index('idx_wishlist_item_user').on(table.userId),
  ],
)

export const wishlistItemRelations = relations(wishlistItem, ({ one }) => ({
  user: one(user, { fields: [wishlistItem.userId], references: [user.id] }),
  catalogCard: one(catalogCard, { fields: [wishlistItem.catalogCardId], references: [catalogCard.id] }),
}))
// Tournaments (see docs/adr/0008-tournament-model.md).
//
// A tournament belongs to one organizer. Participants are either linked app
// users (`user_id`) or free-text guests (`user_id IS NULL`). Registering a
// deck copies the decklist into `deck_snapshot` — unlike deck legality
// (ADR 0005), a tournament record is history and must not change when a deck,
// a format, or the catalog is edited afterwards.

export const tournament = sqliteTable(
  'tournament',
  {
    id: text('id').primaryKey(),
    organizerUserId: text('organizer_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // The format every registered deck is checked against, or NULL for
    // "no format" (decks are registered without a legality statement).
    // Deleting a format un-assigns it, like `deck.format_id` (ADR 0005).
    formatId: text('format_id')
      .references(() => ruleFormat.id, { onDelete: 'set null' }),
    // 'swiss' | 'round_robin' (shared/tournaments.ts).
    pairingSystem: text('pairing_system').notNull().$type<PairingSystem>().default('swiss'),
    // How a match becomes points: 'games' (3/2/1/0) | 'match' (3/0, draw 1).
    // Fixed at registration. Tournaments that existed before ADR 0028 were
    // backfilled with 'match' so their standings stay as they were.
    scoring: text('scoring').notNull().$type<ScoringSystem>().default('games'),
    // What a bye is worth: 'none' | 'win' (2:0). Backfilled with 'win'.
    byeScoring: text('bye_scoring').notNull().$type<ByeScoring>().default('none'),
    // 'registration' | 'running' | 'finished'.
    status: text('status').notNull().$type<TournamentStatus>().default('registration'),
    // NULL until the tournament starts: resolved from the participant count
    // (Swiss: ceil(log2(n)); round robin: the circle length).
    plannedRounds: integer('planned_rounds'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    index('idx_tournament_organizer').on(table.organizerUserId),
    index('idx_tournament_format').on(table.formatId),
    index('idx_tournament_status').on(table.status),
  ],
)

export const tournamentParticipant = sqliteTable(
  'tournament_participant',
  {
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournament.id, { onDelete: 'cascade' }),
    // NULL = guest participant (name only, no account).
    // A deleted user leaves their results intact as a named guest row.
    userId: text('user_id')
      .references(() => user.id, { onDelete: 'set null' }),
    // Display name inside this tournament. Seeded from `user.name` for
    // linked participants; never an email.
    name: text('name').notNull(),
    // The registered deck, or NULL. `deck_snapshot` is the authority — this
    // is only a back-reference so "open the deck" can work while it exists.
    deckId: text('deck_id')
      .references(() => deck.id, { onDelete: 'set null' }),
    deckSnapshot: text('deck_snapshot', { mode: 'json' }).$type<TournamentDeckSnapshot>(),
    // Legality against the tournament's format at registration time.
    // NULL = no deck registered, or the tournament has no format.
    deckLegal: integer('deck_legal', { mode: 'boolean' }),
    deckIssueCount: integer('deck_issue_count'),
    // Left the tournament: past results count, no further pairings.
    dropped: integer('dropped', { mode: 'boolean' }).notNull().default(false),
    // Taken out of the standings by the organizer (ADR 0028): every match
    // with this participant, past and future, is ignored by everyone's
    // standings. Reversible while the tournament runs.
    withdrawn: integer('withdrawn', { mode: 'boolean' }).notNull().default(false),
    // Registration order, renumbered to 1..n when the tournament starts.
    // Drives the round-robin circle and is the final standings tiebreak.
    seed: integer('seed').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  table => [
    index('idx_tournament_participant_tournament').on(table.tournamentId),
    index('idx_tournament_participant_user').on(table.userId),
    // SQLite treats NULLs as distinct in a unique index, so any number of
    // guest rows coexist while one app user can join a tournament only once.
    uniqueIndex('idx_tournament_participant_unique_user').on(table.tournamentId, table.userId),
  ],
)

export const tournamentRound = sqliteTable(
  'tournament_round',
  {
    id: text('id').primaryKey(),
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournament.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    // 'pending' | 'completed'.
    status: text('status').notNull().$type<'pending' | 'completed'>().default('pending'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  table => [
    index('idx_tournament_round_tournament').on(table.tournamentId),
    uniqueIndex('idx_tournament_round_number').on(table.tournamentId, table.number),
  ],
)

export const tournamentMatch = sqliteTable(
  'tournament_match',
  {
    id: text('id').primaryKey(),
    roundId: text('round_id')
      .notNull()
      .references(() => tournamentRound.id, { onDelete: 'cascade' }),
    // Denormalized so standings can be loaded with one query per tournament
    // instead of a join through every round.
    tournamentId: text('tournament_id')
      .notNull()
      .references(() => tournament.id, { onDelete: 'cascade' }),
    tableNumber: integer('table_number').notNull(),
    participantAId: text('participant_a_id')
      .notNull()
      .references(() => tournamentParticipant.id, { onDelete: 'cascade' }),
    // NULL = bye, reported at creation: a 2–0 win for A under
    // `tournament.bye_scoring = 'win'`, an empty 0–0 without a winner under 'none'.
    participantBId: text('participant_b_id')
      .references(() => tournamentParticipant.id, { onDelete: 'cascade' }),
    winnerParticipantId: text('winner_participant_id')
      .references(() => tournamentParticipant.id, { onDelete: 'set null' }),
    gamesA: integer('games_a').notNull().default(0),
    gamesB: integer('games_b').notNull().default(0),
    isDraw: integer('is_draw', { mode: 'boolean' }).notNull().default(false),
    // NULL = no result entered yet. Byes are reported at creation time.
    reportedAt: integer('reported_at', { mode: 'timestamp' }),
  },
  table => [
    index('idx_tournament_match_round').on(table.roundId),
    index('idx_tournament_match_tournament').on(table.tournamentId),
    index('idx_tournament_match_participant_a').on(table.participantAId),
    index('idx_tournament_match_participant_b').on(table.participantBId),
    uniqueIndex('idx_tournament_match_table').on(table.roundId, table.tableNumber),
  ],
)

export const tournamentRelations = relations(tournament, ({ one, many }) => ({
  organizer: one(user, { fields: [tournament.organizerUserId], references: [user.id] }),
  format: one(ruleFormat, { fields: [tournament.formatId], references: [ruleFormat.id] }),
  participants: many(tournamentParticipant),
  rounds: many(tournamentRound),
  matches: many(tournamentMatch),
}))

export const tournamentParticipantRelations = relations(tournamentParticipant, ({ one }) => ({
  tournament: one(tournament, { fields: [tournamentParticipant.tournamentId], references: [tournament.id] }),
  user: one(user, { fields: [tournamentParticipant.userId], references: [user.id] }),
  deck: one(deck, { fields: [tournamentParticipant.deckId], references: [deck.id] }),
}))

export const tournamentRoundRelations = relations(tournamentRound, ({ one, many }) => ({
  tournament: one(tournament, { fields: [tournamentRound.tournamentId], references: [tournament.id] }),
  matches: many(tournamentMatch),
}))

export const tournamentMatchRelations = relations(tournamentMatch, ({ one }) => ({
  round: one(tournamentRound, { fields: [tournamentMatch.roundId], references: [tournamentRound.id] }),
  tournament: one(tournament, { fields: [tournamentMatch.tournamentId], references: [tournament.id] }),
  participantA: one(tournamentParticipant, { fields: [tournamentMatch.participantAId], references: [tournamentParticipant.id], relationName: 'participantA' }),
  participantB: one(tournamentParticipant, { fields: [tournamentMatch.participantBId], references: [tournamentParticipant.id], relationName: 'participantB' }),
}))

// Chat assistant with tools (Phase 8, see docs/adr/0010-chat-assistant-with-tools.md).
//
// A conversation is a persisted thread of messages between the user and the
// model, including 'tool' role messages (the tool call results the model
// saw). Write tools never mutate directly: a tool call that would change the
// user's data creates an `assistantAction` row instead ("pending"), which the
// UI must explicitly apply or reject — see server/utils/assistant-tools.ts.

export const assistantConversation = sqliteTable(
  'assistant_conversation',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Seeded from the first user message (truncated), shown in the conversation
    // list.
    title: text('title').notNull(),
    // No deck link (ADR 0021): the former `deck_id` and its index were dropped
    // by migration 0017 (#137).
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [
    index('idx_assistant_conversation_user_updated').on(table.userId, table.updatedAt),
  ],
)

export const assistantMessage = sqliteTable(
  'assistant_message',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => assistantConversation.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<'user' | 'assistant' | 'tool'>(),
    // Plain text; '' is allowed for a pure tool-call assistant message.
    content: text('content').notNull(),
    // [{ id, name, arguments }] — only set on an assistant message that requested tool calls.
    toolCalls: text('tool_calls', { mode: 'json' }).$type<Array<{ id: string, name: string, arguments: Record<string, unknown> }>>(),
    // Only set on a 'tool' role message: which call this is the result of.
    toolCallId: text('tool_call_id'),
    toolName: text('tool_name'),
    // Image attachments are never persisted as bytes — only a label survives
    // (see ADR 0010): [{ kind: 'image', label }].
    attachments: text('attachments', { mode: 'json' }).$type<Array<{ kind: 'image', label: string }>>(),
    // The message as AI SDK UIMessage parts (ADR 0020): one row per UIMessage,
    // written by the AI SDK engine. NULL = a legacy row of the engine before
    // it (one row per model round plus 'tool' rows), converted when read
    // (server/utils/assistant-ui-messages.ts). `content` still holds the
    // joined text parts.
    parts: text('parts', { mode: 'json' }).$type<AssistantUIMessagePart[]>(),
    metadata: text('metadata', { mode: 'json' }).$type<AssistantMessageMetadata>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [
    index('idx_assistant_message_conversation_created').on(table.conversationId, table.createdAt),
  ],
)

export const assistantAction = sqliteTable(
  'assistant_action',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => assistantConversation.id, { onDelete: 'cascade' }),
    messageId: text('message_id')
      .notNull()
      .references(() => assistantMessage.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().$type<AssistantActionKind>(),
    // Validated tool arguments — exactly what `applyAction` executes.
    payload: text('payload', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
    // German one-liner shown on the action card.
    summary: text('summary').notNull(),
    status: text('status').notNull().$type<'pending' | 'applied' | 'rejected' | 'failed'>().default('pending'),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  },
  table => [
    index('idx_assistant_action_user_status').on(table.userId, table.status),
  ],
)

export const assistantConversationRelations = relations(assistantConversation, ({ one, many }) => ({
  user: one(user, { fields: [assistantConversation.userId], references: [user.id] }),
  messages: many(assistantMessage),
  actions: many(assistantAction),
}))

export const assistantMessageRelations = relations(assistantMessage, ({ one, many }) => ({
  conversation: one(assistantConversation, { fields: [assistantMessage.conversationId], references: [assistantConversation.id] }),
  actions: many(assistantAction),
}))

export const assistantActionRelations = relations(assistantAction, ({ one }) => ({
  conversation: one(assistantConversation, { fields: [assistantAction.conversationId], references: [assistantConversation.id] }),
  message: one(assistantMessage, { fields: [assistantAction.messageId], references: [assistantMessage.id] }),
  user: one(user, { fields: [assistantAction.userId], references: [user.id] }),
}))
