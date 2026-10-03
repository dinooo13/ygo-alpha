# 0008: Tournament model

## Status

Accepted — partially superseded by [0031](0031-tournament-league-scoring.md):
the 3/1/0 match points (decision 5), draws and the auto-reported 2–0 bye
(decision 6), and pairing swaps in every pairing system are replaced there.
Everything else stands.

## Context

- Phase 7 of the roadmap: create tournaments, manage participants, pick a rule
  format, register decks, track rounds/pairings, record results, show standings,
  keep history.
- Existing constraints: decks are user-scoped constructions over catalog cards
  (ADR 0004); rule formats are JSON rule sets evaluated by a pure engine and
  legality is deliberately never stored (ADR 0005); ownership boundaries answer
  404, not 403 (ADR 0002/0004).
- The app has exactly one social primitive today: `user.email` is unique. Phase 6
  (profiles/sharing) is being built in parallel and must not be a dependency.

## Decision

1. **One organizer owns the tournament.** `tournament.organizer_user_id` cascades
   from `user`. Every write is organizer-scoped; a tournament the caller neither
   organizes nor plays in is 404. Two exceptions are participant-scoped: reading
   the detail, and registering one's own deck during registration (403 for
   anything else a linked participant attempts).
2. **Participants are linked users or guests.** `tournament_participant.user_id`
   is a nullable `SET NULL` FK; NULL means a free-text guest. A linked row is
   created by an exact, case-insensitive email lookup, and the response only ever
   carries the matched user's `name` — never an email, never a user id. Unique
   index on `(tournament_id, user_id)`; SQLite's NULL-distinct semantics let any
   number of guests coexist. No profile, handle, or sharing concept is used, so
   Phase 6 can land independently.
3. **Deck registration stores a snapshot, and the legality verdict with it.**
   This is the one place the app deliberately departs from ADR 0005's
   "validation is computed at read time and never stored": a tournament is a
   record of what was played. Editing or deleting a deck, editing the format's
   rules, or a catalog/banlist refresh must not retroactively change what a
   player registered. `deck_id` is kept as a `SET NULL` back-reference for
   convenience only; `deck_snapshot` is the authority.
4. **Guest decks come from the organizer's decks; linked players register their
   own.** A guest has no account and no decks, so the organizer registers one of
   *their* decks for that row. The organizer may never set a deck for a row
   linked to another user — that would require reading a foreign deck.
5. **Pairing and standings are pure modules.** `shared/tournament-pairing.ts` and
   `shared/tournament-standings.ts` take plain rows and return plain rows, like
   `shared/rule-formats.ts`. Swiss is greedy top-down with backtracking to avoid
   rematches plus a documented fallback; round robin is the circle method derived
   from the frozen seed order, so no schedule table is persisted. Standings use
   match points 3/1/0 with OMW% → GW% → OGW% → seed as tiebreakers, every rate
   floored at 1/3 and rounded to 4 decimals.
6. **Results are stored as game counts; winner and draw are derived on write**
   and persisted, so both "2–1" and "A won" entry styles share one storage shape.
   A bye is a match with `participant_b_id IS NULL`, auto-reported as 2–0.
7. **A three-state machine guards every write:** `registration` → `running` →
   `finished`. State violations are 409 with a machine-readable `data.code` that
   the German UI maps to a message; ownership violations stay 404/403.
8. **Starting the tournament creates round 1** and renumbers seeds to 1..n, so a
   running tournament always has pairings.

## Consequences

- Tournament history is stable: standings for a finished tournament are a pure
  function of immutable match rows, so nothing needs to be denormalized.
- A decklist is duplicated between `deck_card` and `deck_snapshot`. That is the
  intended cost of an immutable record; the snapshot is bounded by deck size.
- Changing a tournament's format after decks were registered does not re-validate
  them; the stored verdicts reflect the format at registration time. The UI says
  so, and the organizer can ask players to re-register.
- Participants cannot be added after the start, which keeps the round-robin
  circle and the Swiss seeds well defined. Late entries mean a new tournament.
- Pairings can only be swapped, and only before the round's first result. A full
  manual pairing editor is out of scope.
- Tournaments reference `rule_format.id` directly, which ADR 0005 anticipated;
  built-in and custom formats need no special handling. Reading a tournament's
  format row is intentionally not user-scoped — participants must be able to see
  the name of the format they are judged against — but the rule JSON never
  leaves the server through a tournament endpoint.
- Nothing here depends on Phase 6. If profiles later add display names or
  sharing, a tournament participant can be enriched additively.
