# YGO Alpha: Developer Guide

Everything you need to run, configure and work on YGO Alpha: setup, configuration,
data sources, how the features behave in detail, and the checks every change has to pass.
For the product overview see the [README](../README.md); for the plan see the
[Roadmap](Roadmap.md), and for branching and PRs see [WORKFLOW.md](WORKFLOW.md).
Structural decisions are recorded as [ADRs](adr/).

Built with [Nuxt 4](https://nuxt.com), [Nuxt UI](https://ui.nuxt.com), SQLite via
Drizzle, Better Auth and the Vercel AI SDK.

## Requirements

- Node.js 22 or newer
- pnpm 11 via [Corepack](https://nodejs.org/api/corepack.html) (included with Node 16.13 and newer)

```bash
corepack enable
```

## Setup

```bash
pnpm install
```

Configure environment variables (optional for local development; unsafe defaults allow it to run without this step):

```bash
cp .env.example .env
```

See [`.env.example`](../.env.example) for all available variables:

- `NUXT_BETTER_AUTH_SECRET` - secret for Better Auth (required in production, for example `openssl rand -base64 32`)
- `NUXT_PUBLIC_BETTER_AUTH_URL` - publicly reachable base URL of the app
- `NUXT_DB_FILE_PATH` - path to the SQLite database file (default: `./data/app.db`; the directory is created automatically)
- `NUXT_INVITE_CODE` - shared invite code the register form asks for (case, spaces and dashes don't matter). Empty = anyone can sign up; **set it in production** ([ADR 0027](adr/0027-invite-code-and-admin-token.md))
- `NUXT_ADMIN_TOKEN` - bearer token for the `/api/admin/**` catalog sync endpoints. Empty = those endpoints are off
- `NUXT_ASSISTANT_API_KEY` - API key for the chat assistant (optional; falls back to `OPENAI_API_KEY`). Without a key or a custom base URL the feature is disabled and the UI shows a notice instead.
- `NUXT_ASSISTANT_PROVIDER` / `NUXT_ASSISTANT_BASE_URL` / `NUXT_ASSISTANT_MODEL` / `NUXT_ASSISTANT_REASONING_EFFORT` - override the assistant's provider (`openai` / `fake`), the OpenAI-compatible endpoint's base URL, the model id, and an optional `reasoning_effort` some gateways (e.g. OpenCode Go) require; see [`.env.example`](../.env.example)
- `NUXT_ASSISTANT_VISION_MODEL` - optional override model for chat turns that include an image (the chat assistant at `/assistant`, see below); leave empty to use `NUXT_ASSISTANT_MODEL` for those turns too
- `NUXT_ASSISTANT_MODELS` - optional comma-separated list of model ids the user may pick from in the chat (e.g. `mimo-v2.6-pro,glm-5.3-flash,deepseek-v4.1-flash`); `NUXT_ASSISTANT_MODEL` is the default when it's on the list. Empty = only `NUXT_ASSISTANT_MODEL`, no picker
- `NUXT_ASSISTANT_TITLE_MODEL` - the model that names a conversation after its first exchange (default `glm-5.3-flash`, on the same endpoint; `off` keeps the first message as the title)

## Development

Start the dev server at `http://localhost:3000`:

```bash
pnpm dev
```

The service worker is off in dev (#94). Start with `PWA_DEV_SW=1 pnpm dev` to test PWA behaviour; then
restart the dev server by hand whenever `.nuxt` was wiped (`pnpm install`, `nuxt prepare`, `pnpm build`).
A dev service worker left over from earlier runs is harmless (it only precaches `suppress-warnings.js`);
unregister it once in DevTools → Application → Service workers.

## Database / Migrations

Drizzle migrations live in `server/db/migrations` and are **applied automatically on server startup** (`server/plugins/migrate.ts`), so no manual step is required for normal development or production operation.

When the schema changes, manually generate or apply a new migration:

```bash
pnpm db:generate   # generate a new migration from server/db/schema.ts
pnpm db:migrate    # apply migrations manually
```

Check what `db:generate` wrote before committing it: for a dropped or changed foreign key, drizzle-kit may generate a table rebuild (`PRAGMA foreign_keys=OFF`, `CREATE TABLE __new_…`, `DROP TABLE`). The migrator runs every migration inside one transaction, where that pragma has no effect, so the rebuild's `DROP TABLE` cascade-deletes the child rows. Hand-write such migrations instead: drop the column's indexes, then `ALTER TABLE … DROP COLUMN` (see migration 0017). That works when the foreign key is a column constraint (`… REFERENCES …` on the column itself, as `ALTER TABLE … ADD` writes it). A column named in a table-level `FOREIGN KEY (…)` clause of a `CREATE TABLE` (e.g. `owned_card.printing_id`, ADR 0017) can't be dropped that way: SQLite fails with "unknown column … in foreign key definition", and only a table rebuild, which the migrator can't run safely, removes it. A test fails on any later migration that rebuilds a table.

## Card Catalog

The global card catalog (`catalog_card`, `catalog_set`, `catalog_printing`, `catalog_card_image`) is populated from the [YGOPRODeck API](https://ygoprodeck.com/api-guide/) rather than entered by hand. See [`docs/adr/0001-card-catalog-data-model.md`](adr/0001-card-catalog-data-model.md) for the schema/import design.

After running migrations, populate (or refresh) the catalog with a full sync — this is **not** run automatically on startup, since it fetches the entire card database:

```bash
# Dev server only (nitro's dev task runner, no session needed)
curl -X POST http://localhost:3000/_nitro/tasks/catalog:sync
```

On a production server (the `/_nitro/tasks` runner exists only in dev, and nuxi has no `task` command), trigger it with the admin token (`NUXT_ADMIN_TOKEN`; a signed-in session is not enough, [ADR 0027](adr/0027-invite-code-and-admin-token.md)):

```bash
curl -X POST https://your-host/api/admin/catalog/sync \
  -H "Authorization: Bearer $NUXT_ADMIN_TOKEN"
```

The sync is idempotent (upsert-based) and safe to re-run at any time to pick up new or updated cards. Cards YGOPRODeck no longer lists (renumbered pre-release placeholders, changed passcodes) are marked retired and hidden from search; inventory, decks and wishlists that use them move to the renumbered card (see [ADR 0019](adr/0019-retired-catalog-cards.md)). Printings and images the response no longer lists are removed ([ADR 0024](adr/0024-passcode-aliases-and-catalog-cleanup.md)). Card images are currently stored as remote YGOPRODeck URLs; a local image proxy/cache is planned as follow-up work (see the ADR).

### German card data

Official German card names and texts come from a second source, the
[ygoresources card-history repo](https://github.com/db-ygoresources-com/yugioh-card-history)
(one JSON file per card and language, keyed by Konami id). They are stored in
`catalog_card_translation` and joined through `catalog_card.konami_id`, which the
YGOPRODeck sync fills. YGOPRODeck stays the source for everything else, images
included. See [`docs/adr/0015-german-card-data.md`](adr/0015-german-card-data.md).

- `catalog:sync` (and `POST /api/admin/catalog/sync`) runs the German sync right
  after the card sync. That part is best effort: if it fails, the card result
  still stands and the response reports the error under `translations`.
- The German sync on its own: `POST /_nitro/tasks/catalog:sync-translations` on
  the dev server, or `POST /api/admin/catalog/translations/sync` (same admin token). It asks GitHub
  for the head commit once and is `skipped` when nothing changed since the last
  successful run; otherwise it streams the repo tarball (~15 MB) and reads only `de/`.
- **After deploying this change, run `catalog:sync` once.** Until then no card has
  a Konami id, and the standalone German sync fails with
  "catalog has no konami ids; run catalog:sync first". Neither sync is scheduled.
- Cards without a Konami id or without a German file (OCG-only cards, tokens,
  skills, …) have no German data and fall back to English.
- Card search is bilingual everywhere: a search matches the English or the German
  name, ignoring case, umlauts, `ß`, spaces and punctuation
  (`server/utils/card-name-search.ts`).
- Cards are shown in the **card language**: by default the interface language,
  or German / English as picked under "Kartensprache / Card language" in the
  profile settings. API responses always carry the English `name` (and `desc`)
  plus the German `nameDe` (and `descDe` in the card detail); the client picks.
  Card types, attributes and races follow the card language too ("FINSTERNIS",
  "Hexer", "Schnell"; `card.value.*` in the i18n catalogues), while filter values
  stay English. Card images, rarities and set names stay English.

German card texts: [ygoresources.com](https://db.ygoresources.com/) — card-history
repo. The texts are Konami's; the repo has no licence. Turning the sync off
leaves the app on English card data.

### Local Card Images

YGO Omega card assets copied into `public/assets/ygo-omega/de` are Unity bundle
payloads, not browser-ready images. Extract them into stable web assets with:

```bash
python3 -m pip install UnityPy Pillow
pnpm assets:extract:omega
```

The extractor writes images to `public/assets/cards/de` and creates
`public/assets/cards/de/manifest.json`, keyed by card id when the Unity texture
name contains a known id from Omega's copied `db.sqlite`.

## Schnellerfassung

`/inventory/quick-entry` adds many cards at once from a pasted or typed list, and
nothing is written before it has been confirmed:

- **Liste** – one card per line. Quantities (`3x Dark Magician`,
  `Dark Magician x3`, `3 Dark Magician`), set codes (`Dark Magician (SDY-006)`
  or a bare `SDY-006`), and 8-digit passcodes (`46986414`) are recognized
  automatically. The passcode printed on a card also works when YGOPRODeck
  lists it as an alternate artwork of the card (ADR 0024).
- **Decklisten** – the same box reads YDK files, `ydke://` links, YGO Omega deck
  codes and text recipes (see [Decks](#decks)). Header, comment and section lines
  (`Monster`, `Zauber`, `Extra Deck`, `#main`, `!side`) never become rows, and
  entries for the same card are merged (across sections) before the 50-line cap, so
  a YDK with one line per copy fits.

The review table preselects certain matches (passcode, set code, exact name)
and anything scoring at least 0.85, marks weaker hits as "Unsicher" with a
candidate dropdown, and offers an inline catalog search for lines without a
match. The collection comes from a "Standard-Sammlung" default and can be
overridden per row; a set code only identifies the card, no printing is stored
(see [`docs/adr/0017-inventory-without-collector-details.md`](adr/0017-inventory-without-collector-details.md)).
Saving posts the rows to `POST /api/inventory/bulk` in batches of 50, each
batch in one transaction. The review table empties as rows are saved; what was
written (card, copies, collection and the stack ids of the bulk answer) stays
in a "Gerade gespeichert" panel below it, which moves exactly those copies to
another collection through `POST /api/inventory/move` and can be dismissed. It
never refills the review table, so nothing is written twice.

Recognizing a card from a photo now lives in the chat assistant
(`/assistant`, see below) instead of its own modes here
— see [`docs/adr/0010-chat-assistant-with-tools.md`](adr/0010-chat-assistant-with-tools.md)
(supersedes [`docs/adr/0003`](adr/0003-client-side-ocr-and-speech-entry.md)).

## Inventar und Sammlungen

The inventory is the master list; collections partition it (a copy is in one
collection or none, [ADR 0030](adr/0030-collections-built-by-moving-copies.md)).
Collections are built by moving copies:

- `POST /api/inventory/move` takes up to 200 `{ ownedCardId, quantity?,
  toCollectionId }` items (`null` = ohne Sammlung, no `quantity` = the whole
  stack) and applies them in one transaction. It answers with the stack each
  item ended up in. A partial move splits the stack; a whole stack is re-pointed
  or merged into the target's stack (notes joined, target first).
- The "Liste" of `/inventory` has a "Verschieben" button per row and "Auswählen"
  for a selection of whole stacks; the target can be a new collection.
- `POST /api/decks/:id/fill-collection` (`{ collectionId, sourceCollectionIds?,
  dryRun? }`) moves what a deck needs (main + extra + side per card, copies
  already in the target counted) into a collection, taking from the sources in
  the given order, "ohne Sammlung" first by default. The dialog is reached from
  a collection's "…" menu on `/inventory` and from a deck's menu on `/decks`.
- The deck builder's card source has a "Quelle" select. It sends
  `collectionId` plus `scoped=1` to `GET /api/inventory/search`, which then
  counts only that collection's copies (without `scoped`, a `collectionId` only
  decides which cards qualify, as on the inventory page).

### Kartenart filter

The catalog (`GET /api/catalog/cards`), the inventory (`GET /api/inventory`,
`GET /api/inventory/search`) and the deck builder's card source take
`kind=` (comma list or repeated): `normal`, `effect`, `ritual`, `fusion`,
`synchro`, `xyz`, `link`, `pendulum`, `token`, `spell`, `trap`. A card's kind
is its frame (`catalog_card.frame_type`, with the type-line keywords of
`shared/card-frame.ts` as the fallback, in SQL in
`server/utils/card-kind-sql.ts`), so "Effekt" also covers Flip, Tuner, Spirit,
Toon, Union and Gemini monsters; Pendulum is a second kind next to the frame.
The exact `type=` filter stays as the finer one and combines with it (AND).

## Decks

Decks live under `/decks`: the list page searches by deck name *or* by a card
contained in the deck, and the editor at `/decks/<id>` manages the Main, Extra,
and Side Deck of a single deck. Cards are added from the card source panel,
which searches the user's inventory by default (all collections, or one chosen
in "Quelle", see above) and, with "Auch Katalogkarten
anzeigen", the whole catalog — so a deck can be planned with cards that aren't
owned yet. Fusion/Synchro/XYZ/Link monsters can only go into the Extra or Side
Deck; every other card only into the Main or Side Deck.

A deck references **catalog** cards, not owned-card rows (see
[`docs/adr/0004-deck-data-model.md`](adr/0004-deck-data-model.md)).
Availability is therefore derived on every read:

- `owned` is the sum of `owned_card.quantity` for that catalog card across all
  collections.
- `usedInDeck` counts the copies used across *all* sections of that deck, and
  `shortfall = max(0, usedInDeck - owned)` is shown as a red `used/owned`
  indicator; the deck list shows "Vollständig" or "n fehlen".
- Owned copies are **not** reserved across decks: the same physical card may
  appear in any number of saved decks, and each deck reports its own shortfall.

Deck sizes (40–60 main, 15 extra, 15 side) and the 3-copies-per-card rule are
returned as `warnings` rather than enforced. They are only the fallback hints
for a deck without a rule format — once a format is assigned, its rules govern
the limits (see [Formate](#formate)). Only structurally invalid writes (unknown
card, unknown section, negative quantity, more than 99 copies in a single row,
card in a forbidden section) are rejected.

### Import and export

"Deck importieren" on the deck list creates a deck from a pasted list or a `.ydk`
file; the deck editor and the shared deck view have an "Exportieren" menu. Both use
the four formats players exchange decks in (`shared/decklist.ts`, the reader is
`server/utils/decklist-parse.ts`):

| Format | Shape |
|--------|-------|
| `ydke://` | `ydke://<main>!<extra>!<side>!`, each part base64 (standard or URL-safe) of uint32 LE passcodes, one per copy |
| YGO Omega deck code | base64 of a raw-deflated payload: `uint8` Main + Extra count, `uint8` Side count, then the uint32 LE passcodes (Main and Extra mixed, then Side) |
| YDK | `#created by …`, `#main`, `#extra`, `!side`, one passcode per line and copy (7-digit passcodes lose their leading zero) |
| Text recipe | Omega's "Recipe": `Monster` / `Spell` / `Trap` / `Extra` / `Side` headers (English or German, also `Main Deck:` style) and `3 Name` lines; headerless lists work too |

The import review (`POST /api/decks/import/preview`, read-only) matches every entry like
quick capture does; unresolved lines must be matched or removed, and each resolved card
goes to the section its type allows, because an Omega code doesn't separate Main from
Extra. The deck is then created by `POST /api/decks`. Deck sizes outside the usual limits
only warn. The export needs a passcode per card (`catalog_card.id`); a copy without one is
left out of the passcode formats and a toast says so. The text recipe uses the English names.

## Formate

Rule formats decide which cards and how many copies a deck may play. They live
under `/formats` and are split into two groups:

- **Offizielle Formate** — built-in, globally available, and read-only:
  `TCG Advanced`, `OCG`, `GOAT Format`, `Edison` ([ADR 0030](adr/0030-edison-format.md)), `Classic Plus` ([ADR 0022](adr/0022-classic-plus-format.md)), and `Ohne Banliste`. They are upserted
  on every server start (`seedBuiltinFormats`, see `server/plugins/migrate.ts`),
  so improved rules ship with a deploy instead of a data migration. Anybody can
  clone a built-in ("Klonen") to get an editable copy.
- **Meine Formate** — the user's own formats, created in the editor at
  `/formats/new` and editable, duplicable, and deletable. Deleting a format
  keeps every deck that used it and only resets that deck's format to "none".

A format is a list of typed rules (max 50) stored as JSON and evaluated in code
(`shared/rule-formats.ts`, see
[`docs/adr/0005-rule-format-model.md`](adr/0005-rule-format-model.md)):

| Rule | Meaning |
|------|---------|
| `deck_size` | min/max cards in the Main, Extra, or Side Deck |
| `copies` | default copies per card (1–10, normally 3) |
| `card_status` | specific cards are forbidden / limited / semi-limited |
| `banlist` | the official TCG, OCG, GOAT, or Edison banlist, or Classic Plus's own |
| `filter` | restrict all cards matching (or *not* matching) a card filter to 0–3 copies |

A card filter can combine types, frame types, attributes, races, archetypes,
sets, card ids, level/ATK/DEF ranges, a name substring, an effect flag, and a
release cut-off. All provided fields are ANDed, the values inside one field are
ORed, and an empty filter matches every card.

### Validation semantics

- Copies are counted across **main + extra + side**. The effective limit per
  card is the **lowest** of: the `copies` rule (default 3), an explicit
  `card_status`, the selected banlist, and every applicable `filter` rule.
- `hasEffect` is true for Spell, Trap, and Skill cards (they are nothing but
  effect text) and for every monster whose card type does not contain
  "Normal" — so "Normal Monster", "Normal Tuner Monster", and "Pendulum Normal
  Monster" count as *without* effect.
- `releasedBefore`/`releasedAfter` compare **strictly** (the boundary date
  itself does not match) against the TCG date by default, or the OCG date with
  `region: 'ocg'`. A card **without** a date for that region never matches, so
  a GOAT-style "only cards up to June 2005" rule
  (`not_matching releasedBefore 2005-07-01 → 0 copies`) also disallows cards
  with an unknown release date — the conservative choice.
- Legality is **never stored**. It is recomputed on every deck read and on
  every write response, so a card change, a format edit, or a catalog refresh
  takes effect immediately. A deck without a format is neither legal nor
  illegal (`validation: null`).

In the deck editor a format is picked in the header; the "Regelprüfung" panel
then shows `Legal` / `Nicht legal – n Probleme` with the issue list, and every
affected row is badged (`Verboten`, `Limitiert (1)`, `Semi-limitiert (2)`). The
deck list shows the format name plus a legality badge and can filter by format
and legality. The format editor can check any of the user's decks against the
*unsaved* rules before saving them.

## KI-Deckbau

Deck building with AI help happens in the [Assistent](#assistent) chat:
open it from the navigation and name the deck. The assistant reads your decks
and formats through its tools. See
[`docs/adr/0011-deck-assistance-in-chat.md`](adr/0011-deck-assistance-in-chat.md)
and [`docs/adr/0021-no-deck-link-in-assistant-conversations.md`](adr/0021-no-deck-link-in-assistant-conversations.md).

## Assistent

`/assistant` is a persisted, multi-turn chat with tools over the user's own
catalog, inventory, and decks — it replaced the Foto and Sprache modes of
[Schnellerfassung](#schnellerfassung) and is also the app's deck assistant.
Every conversation is saved and listed in a sidebar (titled from its first
message), with a "Neue Unterhaltung" button and per-conversation deletion.

For deck building the assistant prefers the user's inventory — `search_inventory`
reports each owned card's type/stats, whether it's an Extra Deck card, and
its copy limit in a format (format-forbidden cards are left out) — and checks
proposals with `validate_deck` first. A proposed deck or deck change shows,
before `Übernehmen`, the rule engine's legality verdict (see
[Formate](#formate)), the Main/Extra/Side counts, and a separate list of
cards the user doesn't own (enough of).

The assistant can look things up (search the catalog, read a card's full
text and printings, search the inventory, list collections/decks/formats,
read and validate a deck) and, for anything that would change data — adding
cards to the inventory, creating a deck, changing a deck's cards or its
format — it only
ever proposes a **pending action**, shown as a card with `Übernehmen` /
`Verwerfen` buttons; nothing is written until the user confirms it. A
message can include up to 6 photos (resized client-side before upload) that
the model identifies against the catalog. Voice dictation is currently not
offered (it was removed again because it didn't work reliably). The
assistant answers in the interface language (German or English, see
[`docs/adr/0014-ui-internationalisation.md`](adr/0014-ui-internationalisation.md))
and names cards in the card language: with German card names it uses the
official German name (and the English one in parentheses where it helps),
otherwise the English name; it finds cards by either
([`docs/adr/0015-german-card-data.md`](adr/0015-german-card-data.md)).

This works with any OpenAI-compatible Chat Completions endpoint that
supports streaming and tool calls — e.g. OpenAI, OpenRouter, Ollama,
LM Studio, or OpenCode Zen; see [`.env.example`](../.env.example) for
`NUXT_ASSISTANT_BASE_URL` / `NUXT_ASSISTANT_API_KEY` (or `OPENAI_API_KEY`).
Without a configured provider, `/api/assistant/status` reports the assistant
as disabled and the UI shows an "Assistent nicht verfügbar" notice. An optional
`NUXT_ASSISTANT_VISION_MODEL` lets a deployment use a different model
specifically for turns that include an image; see [`.env.example`](../.env.example).
Providers that require OpenCode Go's session header get it automatically —
every request sends
`x-opencode-session` and a `User-Agent` identifying this app, no
configuration needed. On OpenCode Go, the recommended model is
`mimo-v2.6-pro` (MiMo V2.6 Pro): it was verified with streamed (and parallel)
tool calls and `image_url` data-URL photos (no separate vision model needed).
`NUXT_ASSISTANT_REASONING_EFFORT`
is optional for it; `glm-5.3-flash` remains a faster, cheaper alternative.
The engine runs on the Vercel AI SDK (`ai` with
`@ai-sdk/openai-compatible`): `streamText` drives the tool loop, each message
is stored as AI SDK `UIMessage` parts (conversations of the former engine are
converted when read), and `POST /api/assistant/chat/:id/stream` streams a turn
with the SDK's UI message protocol. Guards against looping tool calls switch
tools off after two identical failures and stop after three; a tool call
written as text gets one corrective retry. The thread UI uses the SDK's chat
client (`@ai-sdk/vue`) with Nuxt UI's chat components; see
[`docs/adr/0020-assistant-on-the-ai-sdk.md`](adr/0020-assistant-on-the-ai-sdk.md).
With `NUXT_ASSISTANT_MODELS` set, the composer offers a model picker (the
choice is remembered per device, and each answer notes the model that wrote
it) — e.g. MiMo for careful answers, a flash model for speed.
Conversations are named by a small title model after the first exchange
(`NUXT_ASSISTANT_TITLE_MODEL`, default `glm-5.3-flash`, `off` to keep the
first message as the title).
The chat's operational limits (tool-calling rounds per turn,
tool result size, history window, model call timeout) are configurable via
`NUXT_ASSISTANT_LIMITS_*`; see [`.env.example`](../.env.example) and
`server/utils/assistant-limits.ts`. See
[`docs/adr/0010-chat-assistant-with-tools.md`](adr/0010-chat-assistant-with-tools.md),
[`docs/adr/0011-deck-assistance-in-chat.md`](adr/0011-deck-assistance-in-chat.md),
[`docs/adr/0021-no-deck-link-in-assistant-conversations.md`](adr/0021-no-deck-link-in-assistant-conversations.md),
and [`docs/adr/0009-openai-compatible-assistant-provider.md`](adr/0009-openai-compatible-assistant-provider.md).

## Teilen & Profile

Every user has a public profile at `/players/<Nutzername>`, editable under `/profile` (display
name, username/handle, bio). Decks, single collections, and the whole inventory ("Alle Karten")
can each be shared independently by setting a visibility — `Privat`, `Nur über Link`, or
`Öffentlich` — plus, orthogonally, granting access to specific players by username through the
same "Teilen" modal. A link-shared or public resource is reachable at its `/players/<Nutzername>/...`
URL (with `?token=` for link sharing); an unknown, private, or revoked resource always renders the
same "Nicht gefunden oder nicht freigegeben." card, so nothing about its existence leaks through
the UI.

Shared views are strictly read-only and never disclose ownership data: a shared deck shows card
names and quantities, its format, and its legality, but not `owned`/`usedInDeck`/shortfall; a
shared collection or the shared inventory lists cards aggregated per catalog card, searchable and
paginated, without notes. See
[`docs/adr/0007-sharing-and-profile-model.md`](adr/0007-sharing-and-profile-model.md).

## Wunschliste

`/wishlist` is a personal "cards I'm looking for" list, added from the catalog with a
"Zur Wunschliste" toggle on each card. Each entry has a quantity and an optional note (e.g. "1st
Edition bitte"). A profile setting ("Wunschliste öffentlich zeigen") publishes the list — with its
notes, but never the owned-copy counts that are private inventory information — on the public
profile page for other players to see. Trading against a wishlist is explicitly out of scope for
this phase; see
[`docs/adr/0007-sharing-and-profile-model.md`](adr/0007-sharing-and-profile-model.md).

## Turniere

Tournaments live under `/tournaments`. A tournament has one organizer, who creates
it, picks a rule format (or none) and a pairing system (`Schweizer System` or
`Jeder gegen jeden`), and adds participants either as linked app users (by
exact e-mail match) or as free-text guests. Registering a deck for a
participant copies its decklist and legality verdict into a snapshot
(`deck_snapshot`) — later edits to the deck, the format, or the catalog never
change what a tournament recorded, unlike deck legality elsewhere in the app
(see [Formate](#formate)), which is always recomputed live.

Starting a tournament freezes the seed order and creates the first round's
pairings; each round is played, results are entered with the `2:0` / `2:1` /
`1:2` / `0:2` shortcuts or as game counts, and the round is completed once
every match has a result. A match always has a winner: draws (and equal game
counts) are rejected with `draws_not_allowed`. Finishing the tournament makes
it read-only and moves it into the "Abgeschlossen" history list. See
[`docs/adr/0008-tournament-model.md`](adr/0008-tournament-model.md) and, for
everything below, [`docs/adr/0031-tournament-league-scoring.md`](adr/0031-tournament-league-scoring.md).

Standings are computed from the match history on every read, never stored,
under two per-tournament settings chosen at creation (and editable during
registration only):

- **Wertung** (`scoring`): `games` (default) gives 3 points for a win without
  dropping a game, 2 for a win that dropped one, 1 for a loss that won a game,
  0 otherwise, so a 2:0 ranks above a 2:1. `match` is the classic 3/0 and is
  what tournaments from before ADR 0031 were backfilled with.
- **Spielfrei** (`byeScoring`): `none` (default) gives a bye no points, no
  match played and no games ("spielfrei"); `win` scores it as a 2:0 win
  (backfilled for existing tournaments).

Swiss shows `Punkte`, `S-N`, `OMW%`, `GW%`, `OGW%`. A round robin is a league
table (`Pl.`, `Name`, `Sp.`, `S`, `N`, `Spiele`, `Diff.`, `Pkt.`) with rounds
called "Spieltag n", ordered by points, game difference, head-to-head (only
between exactly two), games won, seed; a "Kreuztabelle" view shows every
result. Round-robin pairings follow the fixed circle schedule and cannot be
swapped.

"Aussteigen lassen" (drop) keeps a player's past results. "Aus der Wertung
nehmen" (withdraw, while the tournament runs, reversible) removes *every*
match with that player from everybody's standings, voids their pending
matches (no result needed; the opponent is "spielfrei" without points) and
lists them last.

## Design system ("Duel Arena")

The UI follows a dark-first design system, "Duel Arena · Midnight Arcane": an
indigo-black canvas, arcane violet for actions, Millennium gold for meaning
(focus, the active place, highlights), and card-frame colors as small
stripes and dots next to the written card type. See
[`docs/adr/0016-visual-design-system.md`](adr/0016-visual-design-system.md).

- **Color mode.** Dark by default, with a light mode. The toggle sits in the
  sidebar and in the login and public headers; the choice is stored in the
  `ygo-color-mode` cookie, so the server renders the right theme (no flash)
  and `theme-color` follows it.
- **Tokens only.** Components use Nuxt UI's semantic utilities
  (`text-muted`, `bg-elevated`, `border-default`, `text-error`, …) and the
  building blocks in `app/assets/css/main.css` (`panel`, `arena-canvas`,
  `arena-surface`, `gold-hairline`, `btn-summon`, `frame-stripe`/`frame-dot`,
  `card-back`, `foil`, `lp-counter`, `deck-fan`, `deck-meter`). Raw palette
  classes (`text-gray-500`, `bg-white`, `bg-brand-600`, arbitrary hex
  colors) fail `tests/nuxt/no-raw-palette.test.ts`.
- **Fonts.** Inter (UI), Cinzel (page titles, wordmark) and Oxanium (counters,
  scores), all SIL OFL, bundled from `@fontsource-variable/*` — no font CDN
  at build or run time, and web fonts are not precached by the service
  worker.
- **Accessibility.** WCAG AA contrast in both modes (checked by
  `e2e/a11y-axe.spec.ts`), a visible focus ring (violet in light, gold in
  dark), the 44px touch targets below `lg`, decorative motion only without
  `prefers-reduced-motion`, and a `forced-colors` fallback.

## Quality Checks

```bash
pnpm lint
pnpm typecheck
```

## Tests

Unit/component tests (Vitest, `tests/nuxt/`):

```bash
pnpm test
```

Page tests that mount on a query route must stub `~/utils/session` (the global auth middleware
otherwise sends them to `/login`) and mount with `mountAtRoute` from `tests/nuxt/fixtures/route.ts`,
which fails when the page did not stay on its route.

End-to-end tests (Playwright, Chromium, `e2e/`) build the app and start it against a separate test database in `e2e-data/`:

```bash
pnpm test:e2e
```

The Playwright `webServer` boots with `NUXT_E2E_SEED_CATALOG=1`, which makes `server/plugins/migrate.ts`
upsert a small, deterministic set of ~14 real cards (`server/db/fixtures/catalog-fixture.ts`) after
migrations — this never happens outside of E2E runs. Specs can register a user (see
`e2e/helpers/auth.ts`) and search/filter the catalog (e.g. `/catalog`) against known cards instead of
depending on a full `catalog:sync` import. Set `E2E_PORT` to run the E2E server on a port other than the
default `3300` (useful when running `pnpm test:e2e` alongside `pnpm dev`). After a full page load, call
`waitForHydration(page)` (`e2e/helpers/auth.ts`) before typing or clicking; don't use `networkidle`
(lint rejects it).

## Production

```bash
pnpm build
pnpm preview
```

### Docker

Build and start the app with Docker Compose:

```bash
docker compose up --build
```

The app is then available at `http://localhost:3000`. The SQLite database is persisted through the `./data:/app/data` volume, so it survives container restarts.

For production, `NUXT_BETTER_AUTH_SECRET` must be set, for example through a `.env` file in the project root (automatically loaded by `compose.yaml` when present) or as an environment variable before startup:

```bash
NUXT_BETTER_AUTH_SECRET="$(openssl rand -base64 32)" docker compose up --build -d
```

### Plesk (ygo-alpha.de)

Production runs on a Plesk host through its Node.js support (Passenger); see [ADR 0028](adr/0028-plesk-deployment.md) for the layout. Plesk settings: application root = the domain folder, document root = its `httpdocs`, startup file `server.cjs`, Node.js 24, production mode. The server's `.env` holds the settings (`NUXT_BETTER_AUTH_SECRET`, `NUXT_PUBLIC_BETTER_AUTH_URL`, `NUXT_INVITE_CODE`, `NUXT_ADMIN_TOKEN`, `NUXT_ASSISTANT_*`); deploys don't touch it or `data/`.

- **From GitHub:** Actions → Deploy → Run workflow (on `main`). The secrets live in the `production` environment.
- **From a checkout:** `DEPLOY_SSH=user@host DEPLOY_PATH=/example.com DEPLOY_URL=https://example.com scripts/deploy-plesk.sh`
- **Rollback:** on the server, move `.output.prev` back to `.output` and `touch tmp/restart.txt`. Database backups from before each deploy are in `data/backups/` (last 5).
- **Startup errors:** `tmp/startup.log` on the server.
- **Security headers:** the production build sends a hash-based Content Security Policy, HSTS and the usual hardening headers ([ADR 0029](adr/0029-security-headers.md)). A new external source (image host, script, embed) has to be added to `server/utils/security-headers.ts`.

On a public host, also set `NUXT_INVITE_CODE` (otherwise anyone can register) and, if you want to run the catalog syncs there, `NUXT_ADMIN_TOKEN` (for example `openssl rand -hex 32`); see [ADR 0027](adr/0027-invite-code-and-admin-token.md).

## Project Structure

```
app/                  # Nuxt App (Pages, Layouts, Components, Middleware)
server/
  api/                # Server routes, including the Better Auth handler
  db/                 # Drizzle schema, DB client, and migrations
  plugins/            # Nitro plugins, including automatic migrations
  utils/              # Server-side utilities, including Better Auth setup
  tasks/              # Nitro tasks, including the catalog:sync import job
tests/nuxt/           # Vitest unit/component tests
e2e/                  # Playwright end-to-end tests
docs/                 # Product roadmap, ADRs, and additional documentation
Dockerfile            # Multi-stage build for the production container
compose.yaml          # Docker Compose setup for local/self-hosted operation
```

## Outlook

A local image proxy/cache for card artwork is planned as follow-up work and is not part of the current state (card images are currently hotlinked from YGOPRODeck).
