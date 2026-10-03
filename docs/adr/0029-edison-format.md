# 0029: Edison as a built-in format with a static banlist

## Status

Accepted.

## Context

Edison is the most played retro format: the TCG as of SJC Edison
(2010-04-24). Its rules are two things the rule engine
([ADR 0005](0005-rule-format-model.md)) already models: a banlist (the TCG
Forbidden & Limited List of March 2010) and a card pool (TCG cards released
up to and including Duelist Pack: Kaiba; The Shining Darkness, released
2010-05-11, is not legal). The catalog's `banlist_info` only carries
YGOPRODeck's current lists (`ban_tcg`, `ban_ocg`, `ban_goat`), so the March
2010 list has to come from somewhere else.

## Decision

Edison follows the Classic Plus pattern ([ADR 0022](0022-classic-plus-format.md)).

- **A banlist source.** `edison` is a banlist source next to `tcg`, `ocg`,
  `goat` and `classic-plus`. `server/utils/edison-banlist.json` lists the
  Forbidden, Limited and Semi-Limited card ids, and `loadCardDataForValidation`
  adds a card's status to its `banlistInfo` as `ban_edison`, so the engine
  reads it like every other list. Like GOAT it is one of Konami's lists, so
  the UI calls it "Offizielle Banliste (Edison)".
- **The list is fetched, then committed.** `scripts/edison/fetch-banlist.ts`
  reads `GET https://formatlibrary.com/api/banlists/march-2010?category=TCG`
  (43 forbidden, 70 limited, 19 semi-limited) and writes the JSON. The Format
  Library names a card by the passcode of one of its artworks; with a catalog
  database the script resolves such a passcode to the card's main passcode
  (two cards need it), like `resolvePasscode`. The file is static: nothing
  fetches it at runtime, and a catalog refresh doesn't touch it. Cross-check
  against https://edisonformat.net/rules/banlist when the script runs again.
- **A built-in format.** `edison` has the standard deck sizes, 3 copies, the
  `edison` banlist and a GOAT-style card pool rule:
  `not_matching { releasedBefore: '2010-04-25', region: 'tcg' } -> 0 copies`.
  `releasedBefore` compares strictly, so a card first released in the TCG on
  2010-04-24 or earlier is legal. The first later date in the catalog is
  2010-05-01 (The Shining Darkness), the last legal one 2010-04-16 (Duelist
  Pack: Kaiba). As with GOAT, a card without a TCG date is not legal.

## Consequences

- The card pool is by a card's *first* TCG release. Cards that were reprinted
  in the Hidden Arsenal sets after the cut-off but first appeared earlier are
  legal, which is what the format wants. The Hidden Arsenal exceptions the
  Edison community allows (cards first released in a later Hidden Arsenal) are
  not modeled; the format description says so.
- The banlist doesn't follow catalog refreshes. It only changes by running
  the script again.
- A clone of Edison keeps following the committed banlist; its copy limits
  can be tightened with the format's own rules, not loosened.
