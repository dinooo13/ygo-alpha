# 0001: Card catalog data model and YGOPRODeck import

## Status

Accepted

Extended by [0019](0019-retired-catalog-cards.md): the sync now retires cards YGOPRODeck no longer lists and re-points references to their replacement.

The `catalog_printing` key is superseded by [0034](0034-inventory-printings.md): a printing is keyed by card, set code and rarity (`<card id>|<set code>|<rarity>`), since one set code comes in several rarities.

The session gate on `POST /api/admin/catalog/sync` is superseded by [0027](0027-invite-code-and-admin-token.md): the endpoint needs an admin bearer token.

## Context

Phase 1 of the [Roadmap](../Roadmap.md) requires a global card catalog: the
canonical reference for all known Yu-Gi-Oh cards that user-owned cards will
later point to. Before this change, `server/db/schema.ts` contained only
Better Auth's tables — there was no domain data at all.

The catalog needs to represent card name, type, attributes/properties,
effect text, sets/printings, release information, and artwork, and it needs
to be populated from an external source (the
[YGOPRODeck v7 API](https://ygoprodeck.com/api-guide/)) rather than entered
by hand.

This is the first domain schema and the first external data dependency in
the app, so the decisions below are recorded per
[`docs/WORKFLOW.md` §5](../WORKFLOW.md#5-when-to-write-an-adr).

## Decision

### Identity

`catalog_card.id` uses YGOPRODeck's own card `id` (the card's "passcode") as
an integer primary key, rather than a surrogate autoincrement key. It is
stable and globally unique, and it is exactly what a later owned-card table
would want to foreign-key against — introducing an extra surrogate id would
add indirection for no benefit.

### Schema shape: normalized, four tables

The catalog is split into `catalog_card`, `catalog_set`, `catalog_printing`,
and `catalog_card_image`, rather than one wide table with JSON blobs for
sets/images:

- `catalog_card` — one row per card. Monster-specific stats (`atk`, `def`,
  `level`, `attribute`, `race`, `linkval`, `scale`) are **flat, nullable
  columns** on this table rather than a separate `catalog_monster` table or
  a JSON blob, so they stay indexable and queryable for search (Phase 1) and
  format rules based on card properties (Phase 4).
- `catalog_set` — one row per distinct set **name**. YGOPRODeck's
  `card_sets[].set_code` is per-printing, not per-set, so `catalog_set.id`
  is a slug derived from `set_name` (see `slugifySetName` in
  `server/utils/ygoprodeck.ts`) rather than the set code.
- `catalog_printing` — the join between a card and a set: one row per
  card-in-set appearance, keyed by the full per-printing set code (e.g.
  `SDY-006`), carrying `rarity` and `price`. This is the row a future owned
  card would reference for edition/rarity.
- `catalog_card_image` — one row per art variant (YGOPRODeck's
  `card_images[]`), storing the three remote image URL sizes.

This mirrors the Roadmap's explicit separation of card/set/printing concepts
and avoids reshaping the schema when inventory (owned cards referencing a
printing) and rule formats (querying by set or by card property) land.

Variable-length, low-cardinality extras that aren't queried relationally —
link markers, banlist info, price snapshots — are stored as JSON text
columns (Drizzle `{ mode: 'json' }`) on `catalog_card` rather than as
further child tables, since they are display/rule metadata, not data that
needs joins or indexes of its own.

### Release dates

`tcg_date` and `ocg_date` are imported from the API's `misc_info` (via the
`misc=yes` query parameter) and stored as indexed ISO date text columns,
specifically so Phase 4's release-date-based rule formats ("only cards
before 2006") can filter on them without re-importing.

### Import mechanism

`server/utils/ygoprodeck.ts` fetches the **entire** card database in a
single unfiltered request (`GET cardinfo.php?misc=yes`); YGOPRODeck's
documented rate limit is 20 requests/second, so one request is far under any
limit and avoids paging complexity entirely.

`server/utils/catalog-sync.ts` (`syncCatalog`) performs an **upsert**
(`onConflictDoUpdate` keyed on each table's primary key), chunked into
transactions of 500 cards, rather than a truncate-and-reinsert. Truncating
would delete rows that owned-card records may reference once inventory
lands; upserting is safe to re-run at any time and converges to the same
state (verified by an idempotency test). Each run is recorded in a
`catalog_sync` log table (`status`, `card_count`, timestamps, `error`) so
sync outcomes are observable without tailing server logs.

The sync is exposed two ways, both calling the same `syncCatalog`:

- A Nitro task `catalog:sync` (`server/tasks/catalog/sync.ts`), enabling
  future scheduled/cron runs (Nitro's experimental tasks feature is turned
  on in `nuxt.config.ts`).
- A guarded endpoint `POST /api/admin/catalog/sync`, gated on **any
  authenticated Better Auth session** (401 otherwise). This app is a
  single-user personal tool for the MVP; a real admin role is explicitly
  deferred rather than built now.

The sync is **not** run automatically on server startup — a ~13k-card fetch
would block boot for no reason in normal dev/production use. It must be
triggered manually (task run or endpoint call) after migrations, documented
in the README.

### Images: remote URLs for MVP, local cache deferred

`catalog_card_image` stores YGOPRODeck's remote image URLs directly
(`image_url`, `image_url_small`, `image_url_cropped`). YGOPRODeck discourages
sustained hotlinking, but building a local image proxy/cache (download +
re-host) is a separate, sizeable piece of work that would significantly
grow this already-large change. The schema is intentionally additive here:
a `local_path` column can be added later without touching existing data, so
a follow-up bean can add the proxy without reopening this schema decision.

### Migration

The new tables are added to the existing `server/db/schema.ts` (single
schema file, matching the current pattern) and shipped as a generated
Drizzle migration (`pnpm db:generate`), applied automatically at startup by
the existing `server/plugins/migrate.ts` — no new migration mechanism.

## Consequences

- Owned-card / inventory tables (a later bean) can foreign-key
  `catalog_card.id` and `catalog_printing.id` directly, with no reshaping.
- Phase 4 rule formats can filter on `catalog_card.attribute`, `tcg_date`,
  `type`, etc. directly, since those are real indexed columns, not buried in
  JSON.
- A full catalog sync must be triggered manually once after first deploying
  this change (`pnpm nuxt task run catalog:sync` or `POST
  /api/admin/catalog/sync`); it is not automatic.
- Card images are hotlinked from YGOPRODeck for now. A follow-up bean is
  expected to add a local image proxy/cache; this ADR is not reversed by
  that work, only extended (e.g. an additive `local_path` column).
- Any authenticated user can trigger a full resync via the admin endpoint.
  This is acceptable for a single-user MVP but should be revisited if/when a
  multi-user or admin-role model is introduced.
