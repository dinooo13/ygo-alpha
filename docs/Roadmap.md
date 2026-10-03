# YGO Alpha Roadmap

## Product Vision

Build YGO Alpha, a personal card app for the Yu-Gi-Oh! trading card game that helps players catalog their cards, organize collections, build decks from cards they actually own, validate decks against flexible rule formats, and later share collections or run tournaments.

The product should start as a reliable personal inventory and deckbuilding tool. More advanced features such as AI deck assistance, social sharing, and tournament tracking should build on that foundation rather than shape the first release.

## Core Product Concepts

### Card Catalog

The card catalog is the global reference for all known Yu-Gi-Oh cards. It can be powered by an external data source such as the YGOPRODeck/Yu-Gi-Pro API.

The catalog should represent card-level information such as:

- card name
- card type
- attributes and properties
- effects and text
- sets and printings
- release information
- artwork and images

Catalog cards are not owned cards. They are the canonical source that user-owned cards refer to.

### User Inventory

The inventory represents the cards a user actually owns. A user-owned card should reference a catalog card, but it may also carry ownership-specific information.

Examples include:

- quantity
- storage location
- collection or box assignment
- a note

The inventory tracks the quantity, the collection or box, and a note; sets and printings live in the catalog (see ADR 0017).

The user should be able to search across their complete inventory, regardless of how the cards are split across collections or boxes.

### Collections and Storage

Users should be able to organize cards into one or more collections or storage locations.

Examples:

- all owned cards
- Box 1
- Box 2
- binder
- trade pile

This structure should support both broad inventory management and practical physical storage.

### Decks

Users should be able to create and save multiple decks from their own inventory.

Decks should support:

- main deck
- extra deck
- side deck
- card counts
- validation against available inventory
- validation against selected rule formats

The app should clearly distinguish between cards a user owns, cards used in a deck, and cards that exist only in the global catalog.

### Rule Formats

Rule formats define which cards and quantities are legal for a deck.

Formats should be flexible enough to model official-style restrictions and custom house rules. A rule can be based on any relevant card data that exists in the card model.

Example rule ideas:

- only cards released before 2006 are allowed
- specific cards are forbidden
- cards with effects are limited to one copy
- cards with effects are limited to two copies
- cards of a certain attribute are allowed or disallowed
- cards from certain sets are allowed or disallowed

The rule format system should eventually support both reusable global formats and user-defined custom formats.

### AI Deck Assistance

AI should help users build decks from their own cards and within a selected rule format.

Useful capabilities include:

- suggest a deck from the user's inventory
- explain why cards were selected
- optimize for a selected play style
- identify missing cards separately from owned cards
- improve an existing deck
- adapt a deck to a different rule format

The AI should be constrained by inventory and rules, not just generate an idealized deck list.

### Sharing and Social Features

Later, users should be able to selectively share collections and decks with other users.

Possible sharing modes:

- private
- shared with selected users
- shared by link
- public

The first social goal should be visibility and comparison. Trading, wishlists, or marketplace-like behavior can be considered later.

### Tournament Mode

Tournament tracking is a later-stage feature that depends on users, decks, and rule formats being stable.

Possible capabilities:

- create a tournament
- select a rule format
- manage participants
- register decks
- track pairings
- record match results
- display standings
- keep tournament history

## Roadmap

### Phase 1: Personal Inventory MVP

Goal: Let a user reliably catalog and find the cards they own.

Scope:

- user accounts and login
- global card catalog
- card search and filtering
- manual inventory entry
- owned card quantities
- collections or storage locations
- search across the user's full inventory

Product outcome:

Users can answer: "Which cards do I own, how many do I have, and where are they?"

Hosting (ADR 0027): on a public host, sign-up is invite-only (one shared
code, `NUXT_INVITE_CODE`) and the catalog sync endpoints need an admin token
(`NUXT_ADMIN_TOKEN`) instead of any signed-in session. Deploys go through
`scripts/deploy-plesk.sh`, locally or from the manual GitHub Actions workflow
(ADR 0028).

### Phase 2: Faster Card Entry

Goal: Make it faster and easier to add many cards to the inventory.

Scope:

- photo-based card recognition
- OCR-assisted entry
- voice input
- bulk entry workflows
- suggested matches
- review and correction flow before cards are saved

Product outcome:

Users can add cards quickly without relying only on manual search and entry.

Note: "photo-based card recognition" is now covered by the chat assistant's
image input (a photo attached to a chat message, identified by the model and
confirmed via its `search_catalog` tool — see
[Phase 8](#phase-8-chat-assistent-mit-werkzeugen) and
[ADR 0010](adr/0010-chat-assistant-with-tools.md), which superseded the
original client-side-OCR approach of
[ADR 0003](adr/0003-client-side-ocr-and-speech-entry.md)). Recognizing a card
from its artwork alone via perceptual hashing or embeddings against catalog
images, without a model in the loop, is still open and depends on the locally
cached card images that [ADR 0001](adr/0001-card-catalog-data-model.md) lists
as follow-up work.

Voice input is currently not offered: Web Speech dictation in the chat
composer was removed because it didn't work reliably; it's open again.

### Phase 3: Deckbuilder

Goal: Let users build and save decks from their own cards.

Scope:

- create, edit, and delete decks
- add cards from owned inventory
- main deck, extra deck, and side deck areas
- card count tracking
- availability checks against owned quantities
- deck search and filtering

Product outcome:

Users can build decks that reflect their real collection, not just the full card catalog.

Tester-Feedback Sept 2026:

- [x] Deck import: "Deck importieren" on the deck list takes a pasted YDK, `ydke://` link, YGO Omega
  deck code or text recipe, or a `.ydk` file; a review step groups the cards by Main / Extra / Side
  (the quick-capture matching, open lines must be resolved or removed) before the deck is created.
- [x] Deck export: the deck editor and the shared deck view export a YDK file, a `ydke://` link, an
  Omega deck code or an Omega-style text recipe.
- [x] Quick capture reads deck lists and no longer turns header lines ("Monster", "Zauber", "#main",
  "Extra Deck") into card rows; equal entries are merged before the 50-line cap.

### Phase 4: Rule Formats and Deck Validation

Goal: Support flexible deck legality checks for official and custom formats.

Scope:

- rule format model
- card legality rules
- quantity limits
- forbidden, limited, and semi-limited cards
- release-date-based rules
- card-property-based rules
- live validation inside the deckbuilder
- saved custom formats

Product outcome:

Users can build decks for specific rule environments and immediately see whether a deck is legal.

Implemented: built-in formats (TCG Advanced, OCG, GOAT, Edison, Classic Plus, Ohne Banliste) plus custom formats under
`/formats`, with live validation in the deckbuilder. See
[`docs/adr/0005-rule-format-model.md`](adr/0005-rule-format-model.md).
Card-filter ATK/DEF ranges never match a `?` stat (#140); the editor uses the shared facet
menus (#120) and format tiles open on a click anywhere (#141).

Classic Plus, a house format whose rules describe what cards do (floodgates, hand traps,
draw, burn, revival, mass removal, protection, negation), is a built-in with its own banlist,
generated from the card texts by a classifier subagent and reviewed; see
[`docs/adr/0022-classic-plus-format.md`](adr/0022-classic-plus-format.md).

Tester-Feedback Sept 2026:

- [x] Edison (SJC Edison, April 2010) is a built-in format: the TCG Forbidden & Limited List of
  March 2010 from the Format Library as a static list, plus a card pool up to Duelist Pack: Kaiba;
  see [`docs/adr/0030-edison-format.md`](adr/0030-edison-format.md).

### Phase 5: AI Deck Assistance

Goal: Help users create and improve decks using their inventory and selected rule formats.

Scope:

- generate deck suggestions from owned cards
- improve an existing deck
- explain card choices
- support play style preferences
- respect selected rule formats
- separate owned-card suggestions from missing-card suggestions

Product outcome:

Users can get meaningful deckbuilding help that understands their collection and constraints.

Implemented: deck assistance lives in the chat assistant at `/assistant` (see
[Phase 8](#phase-8-chat-assistent-mit-werkzeugen)). Deck help happens in the chat: the user
names the deck, the assistant reads it with its tools (the deck link and the deck entry points
were removed, #130, [ADR 0021](adr/0021-no-deck-link-in-assistant-conversations.md)). The
assistant prefers the user's inventory (`search_inventory` reports each owned card's
copy limit in a format and leaves out forbidden cards), checks proposals with `validate_deck`,
and every proposed deck or deck change shows the rule engine's legality verdict and the cards
the user doesn't own (enough of) — separately from the deck itself — before it is confirmed.
Talks to any OpenAI-compatible Chat Completions endpoint (OpenAI, OpenRouter, Ollama, LM Studio,
OpenCode Zen, ...); without a configured provider, the UI shows an "Assistent nicht verfügbar"
notice. See [`docs/adr/0011-deck-assistance-in-chat.md`](adr/0011-deck-assistance-in-chat.md)
(which replaced the original one-shot builder at `/decks/assistent` and the deck editor's
"KI-Vorschläge" panel from [ADR 0006](adr/0006-ai-deck-assistant.md)) and
[`docs/adr/0009-openai-compatible-assistant-provider.md`](adr/0009-openai-compatible-assistant-provider.md).

### Phase 6: Sharing and Social Features

Goal: Let users selectively share collections and decks.

Scope:

- user profiles
- collection sharing permissions
- deck sharing permissions
- shared links or selected-user access
- viewing another user's shared cards or decks
- optional trade or wishlist concepts

Product outcome:

Users can compare collections and decks with other players when they choose to share them.

Implemented: public profiles at `/players/<handle>` with an editable profile under `/profile`,
plus per-resource sharing (privat, nur über Link, öffentlich, oder für einzelne Spieler
freigegeben) for decks, single collections, and the whole inventory — shared views are read-only
and never disclose the owner's availability data. Includes a wishlist under `/wishlist` that
can be published on the profile. Trading is explicitly out of scope. See
[`docs/adr/0007-sharing-and-profile-model.md`](adr/0007-sharing-and-profile-model.md).

### Phase 7: Tournament Mode

Goal: Track tournaments and match results inside the app.

Scope:

- tournament creation
- participant management
- rule format selection
- deck registration
- round and pairing tracking
- match result entry
- standings
- tournament history

Product outcome:

Groups can run and track Yu-Gi-Oh tournaments using decks and formats already modeled in the app.

Implemented: tournaments under `/tournaments` with Swiss or round-robin pairings, participants
added as app users (by e-mail) or as guests, deck registration that snapshots the decklist and
its legality in the selected rule format, round-by-round pairings with match result entry,
live standings with OMW%/GW%/OGW% tiebreakers, and a history of finished tournaments. See
[`docs/adr/0008-tournament-model.md`](adr/0008-tournament-model.md).

Tester-Feedback Sept 2026 (done, see
[`docs/adr/0031-tournament-league-scoring.md`](adr/0031-tournament-league-scoring.md)):

- [x] no draws; quick results 2:0, 2:1, 1:2, 0:2
- [x] scoring by games per tournament (2:0 ranks above 2:1), classic 3/0 kept for existing tournaments
- [x] byes give no points by default ("spielfrei"), configurable per tournament
- [x] round robin as a league table (Pl., Sp., S, N, Spiele, Diff., Pkt.) with "Spieltag n" and a crosstable
- [x] "Aus der Wertung nehmen": withdraw a player from everybody's standings, reversible while running
- [x] no pairing swaps in a round robin
- [x] scoring and bye scoring chosen at creation, editable during registration, shown on the detail page

### Phase 8: Chat-Assistent mit Werkzeugen

Goal: Replace the deck assistant's single-purpose entry points and the
inventory's photo/voice modes with one conversational assistant that can act
on the user's whole collection.

Scope:

- a persisted, multi-turn chat with the assistant
- a tool layer over the catalog, inventory, decks, and formats (search,
  read, and validate — no direct writes)
- write requests (add cards to the inventory, create a deck, change a
  deck's cards or its format) proposed as pending actions the user must
  confirm
- image input (a card photo) identified by the model and confirmed against
  the catalog
- ~~voice dictation into the chat composer~~ (removed, see below)
- conversation list with rename-by-first-message titles and deletion

Product outcome:

Users can ask the assistant about their collection in one place — "which
Blue-Eyes cards do I own", "build me a GOAT deck from what I have", "what's
on this photo" — and have it propose changes they explicitly confirm, instead
of switching between a deck-only builder and a text/photo/voice entry form.

Implemented: a new page at `/assistant` with a persisted conversation per
thread, a tool layer (`search_catalog`, `get_card`, `search_inventory`,
`list_collections`, `list_decks`, `get_deck`, `list_formats`,
`validate_deck`, plus the write tools `add_to_inventory`, `create_deck`,
`update_deck_cards`, and `set_deck_format`) that only ever produces a
pending action for a write,
shown as an action card the user applies or rejects. Image attachments live
in the chat composer, replacing the Foto mode `/inventory/quick-entry` used to
have (its Sprache mode was replaced by Web Speech dictation in the composer,
since removed because it didn't work reliably); the Liste mode there is
unchanged. Works with any OpenAI-compatible Chat Completions endpoint that
supports streaming and tool calls, with an optional
`NUXT_ASSISTANT_VISION_MODEL` override for image-containing turns. See
[`docs/adr/0010-chat-assistant-with-tools.md`](adr/0010-chat-assistant-with-tools.md).
Since [ADR 0011](adr/0011-deck-assistance-in-chat.md) the chat is also the only deck
assistant: the one-shot `/decks/assistent` builder and the deck editor's "KI-Vorschläge"
panel are gone, replaced by the chat; deck proposals carry a legality/missing-cards preview.
Since [ADR 0021](adr/0021-no-deck-link-in-assistant-conversations.md) (#130) conversations
aren't linked to decks and there are no deck entry points.
The recommended OpenCode Go model is `mimo-v2.6-pro` (MiMo V2.6 Pro), which
covers text, streamed tool calls, and image turns without a separate vision
model; see [`.env.example`](../.env.example).
Since [ADR 0020](adr/0020-assistant-on-the-ai-sdk.md) (#84) the assistant runs on the
Vercel AI SDK with Nuxt UI's chat components, stores messages as AI SDK `UIMessage` parts
(older conversations are converted when read), guards against looping tool calls (#54), and
offers a model picker (`NUXT_ASSISTANT_MODELS`), and names new conversations with a separate
title model (`NUXT_ASSISTANT_TITLE_MODEL`, #129).
Answers render as sanitized Markdown (tables, headings, code; [ADR 0023](adr/0023-markdown-in-assistant-answers.md), #123).

### Phase 9: German and English (#34)

Goal: Make the app usable in English as well as German, including card names.

Scope, as three stacked parts:

- F1: English, language-neutral route slugs, with permanent redirects from
  every old German URL (bookmarks and handed-out share links keep working)
- F2: an i18n layer, a UI language switch, and extraction of the UI strings
- F3: a card display language and bilingual card search

Product outcome:

Users pick the language of the interface and of card names, and a shared link
works the same for every reader regardless of their language.

Status: F1 is implemented — every page moved to an English path (`/inventory`,
`/catalog`, `/players/<handle>`, …) and old German URLs answer with a single
`301` to their new one. See
[`docs/adr/0013-english-url-scheme.md`](adr/0013-english-url-scheme.md).

F2 is implemented, as four stacked PRs:

- F2a — foundation: `@nuxtjs/i18n` with per-namespace de/en catalogues, the
  locale resolution (profile → `ui_locale` cookie → Accept-Language → German)
  rendered on the server, `user_profile.locale`, the "Anzeigesprache /
  Interface language" switch (profile settings, login and public pages), and
  the app shell, auth, profile and dashboard strings
- F2b — the collection side (inventory, quick entry, catalog, collections,
  wishlist, sharing, player pages): owned-copy labels from one
  `useCardOptionItems()`, "Drucksprache / Printing language", locale-formatted
  counts, and error codes (`data.code`) instead of raw server messages
- F2c — decks, formats and tournaments (and the player deck page): deck
  validation issues and deck warnings as code + parameters rendered by
  `useValidationText()` (their `message` is canonical English for the
  assistant model), the rule describer on the client, built-in formats stored
  in English and shown by id through `useFormatLabel()`, copies named in the
  interface language, and tournament errors as `errors.api.<code>` with
  parameters
- F2d — the assistant: the prompt, tool descriptions and tool results are
  English in one version, with a per-turn instruction to reply in the
  interface language; tool activity (with deck names instead of deck IDs,
  #53), action cards and assistant errors are rendered on the client from
  structured events and codes; saved fallback texts are localized when
  created. Plus the final gates (`no-raw-text` on every Vue file, no
  `shared/plural` in the UI, a scan for hard-coded German in `app/` and
  `shared/`) and Accept-Language detection switched on, so an English
  browser gets the English UI without choosing it

See [`docs/adr/0014-ui-internationalisation.md`](adr/0014-ui-internationalisation.md).

F3 is implemented, as four stacked PRs:

- F3a — the data layer (implemented): official German card names and texts
  from the ygoresources card-history repo in `catalog_card_translation`,
  joined through the new `catalog_card.konami_id` from YGOPRODeck; a folded
  `name_search` on cards and translations; a streamed tarball sync that is
  skipped when the repo's commit is unchanged (`catalog:sync-translations`,
  `POST /api/admin/catalog/translations/sync`, and after every
  `catalog:sync`); German fixture data for tests. No visible change yet
- F3b — bilingual card search everywhere (implemented): every card search
  (catalog, inventory, deck editor, rule format picker, wishlist, shared
  views, deck list, the assistant's search tools) matches the English and
  the German name, folded for case, umlauts, `ß`, spaces and punctuation
  ("blauaugiger w drache", "BLAUÄUGIGER"); "also search card text" covers
  the German text. Quick entry recognizes German names too, fuzzy matches
  included, and now folds `ß`. Results are still shown in English
- F3c — the card language (implemented): a "Kartensprache / Card language"
  setting on the profile (follow the interface language, German, English;
  anonymous visitors follow the interface), and German card names across the
  app — catalog tiles and detail (German text, the English name as a
  subtitle, a source credit (removed from the UI again in round 4, #87)),
  inventory list and overview, quick entry,
  deck editor, player pages, wishlist, validation messages, the format
  editor and the assistant's action cards. Cards without German data (OCG-only
  cards, tokens, …) stay English. Lists sorted by name sort by the German name
  in German; switching the setting applies at once
- F3d — card data labels and the assistant (implemented): card types,
  attributes and races (including the Spell/Trap subtypes) are shown in the
  card language with Konami's official German words ("FINSTERNIS", "Hexer",
  "Empfänger-Monster", "Schnell") — on tiles, subtitles, deck rows and in the
  filters, whose values stay English; unknown values are shown as stored.
  The assistant names cards in the card language: in German its tool results
  (and the linked deck's context, until ADR 0021 removed it) carry the
  official German name (`nameDe`, `descDe` for a card's text), and the model
  calls cards by it; in English nothing changes

Phase 9 (#34) is done.

See [`docs/adr/0015-german-card-data.md`](adr/0015-german-card-data.md).

### Phase 10: Visual design system — "Duel Arena" (proposal)

Goal: Give the app its own look — modern and calm, but unmistakably about
dueling with cards — and a dark mode, without giving up accessibility.

Scope:

- semantic color tokens instead of raw Tailwind palette classes in `app/`,
  enforced by a test gate
- a dark-first color mode with a toggle, stored in a cookie so the server
  renders the right theme; the PWA and `theme-color` follow it
- self-hosted typography: a display face for page titles, a numeric face for
  counters and scores, Inter for everything else
- card-frame accents (type colors as stripes and dots, never as the only
  signal), an original card back for missing images and a foil highlight
- a new app shell, auth hero, dashboard "duelist card", fanned deck tiles,
  chat bubbles and "activated spell" action cards
- automated axe checks (both color modes) and a color-mode E2E spec

Product outcome:

The app feels like a duel arena at night, with the card scans as the
brightest thing on screen, and it reads well in both light and dark mode.

Status: implemented and merged (PR #79), approved by the owner. After a first look the owner asked for a sidebar that
follows the color mode (no always-dark sidebar) and for the assistant pages
to get the same page header as every other page; both are in. See
[`docs/adr/0016-visual-design-system.md`](adr/0016-visual-design-system.md).

Round 4 (#88): one card detail overlay for the catalog and the inventory —
the floating tilt/foil card with the card text in the card language; the
catalog adds the English name, printings and actions, the inventory the
owned quantity per collection with notes (#87: no source credit in the UI,
ADR 0017). #63: the catalog filters use the inventory's multi-select menus.
#134: whole cards are click targets (`stretched-link`), clickable things show
the pointer, `?` ATK/DEF, select menus as wide as their options.
#135: the inventory's "Übersicht" is "Galerie" (`?view=gallery`; the old
`view=overview` still works). A gallery tile and a list row open the same
detail panel, where the copies are edited in place: per collection the
collection, the quantity (− / input / +), removal and the note, plus "Zu
Sammlung hinzufügen"; every change is saved at once. The list rows are for
reading (type, attribute, the start of the card text, quantity, collection,
note); the edit dialog, the row controls and "In Liste bearbeiten" are gone.
Moving copies into a collection that already holds the card keeps both notes.

Round 5 (#110, #114, #144, #145, #146): the inventory's detail panel is in
the URL (`?card=<id>` deep links it; Back closes it, Forward reopens it), and
"Liste" takes the search panel's filters too (type, attribute, race, level,
card text). The deck editor and the wishlist rows use the shared quantity
stepper. The card overlay also opens from deck rows, the deck editor's add
panel, wishlist rows and the selected card in quick entry. A retired
passcode typed into the inventory's card picker finds its replacement.
Adding copies to a row that already has a note keeps both notes.

Owner feedback (#148): the gallery's count line is gone (the header has the
total); the catalog can also search the card text (`?inText=1`); the deck
editor's card overlay has no printings and edits the card's quantity per
section; the deck header counts Normal, Effect and Ritual monsters, Spells
and Traps, and the Extra Deck's Fusion/Synchro/Xyz/Link.

Round 6 (#148, card data): lists show a card's own artwork (ADR 0025), Link
ratings in all lists, no empty sets in the set filter, the Pendulum scale in
the overlay, a `?` ATK/DEF card in the E2E catalog.

Round 6 (#148, decks): the deck editor's add panel can also search the card
text; the card-kind chips also show on the shared deck view and, compact, on
the deck tiles (`/decks` and the profile page); `POST /api/decks` takes
`format_id` (the assistant's `create_deck` uses it too); the deck, wishlist
and inventory steppers queue their writes (`useQueuedWrites`) and keep the
keyboard focus; quick entry uses the quantity stepper.

## Recommended Build Order

1. Card catalog and personal inventory
2. Collections, boxes, and inventory search
3. User accounts and ownership boundaries
4. Deckbuilder based on owned cards
5. Rule formats and deck validation
6. Photo and voice entry
7. AI deck assistance
8. Sharing and social features
9. Tournament mode
10. Chat assistant with tools
11. German and English
12. Visual design system (Duel Arena)

## Key Product Principle

Keep the main concepts separate from the start:

- a catalog card is a global reference card
- an owned card is a user's copy of a catalog card
- a collection is a way to organize owned cards
- a deck is a saved construction using owned cards
- a rule format defines what is legal for a deck

This separation should make later features easier to add without reshaping the product model.
