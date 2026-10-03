# 0031: Tournament scoring, byes, no draws, league tables and withdrawing

## Status

Accepted. Partially supersedes [0008](0008-tournament-model.md): the 3/1/0
match points of decision 5, the "winner and draw are derived" and
"a bye is auto-reported as 2–0" parts of decision 6, and its statement that
pairings can be swapped regardless of the pairing system. Everything else in
0008 stands.

## Context

Tester feedback after the first real tournaments:

- A 2:0 and a 2:1 earned the same points, so the order did not reflect how
  clearly a match was won.
- A bye counted as a 2:0 win. The player who sat out gained three points for
  nothing, which skewed small round-robin fields where everybody sits out once
  but the tiebreakers then compare unequal numbers of played matches.
- "Unentschieden" was offered although Yu-Gi-Oh! matches are played to a
  winner.
- A round robin showed OMW%/GW%/OGW%, which the testers read as "chance to
  win". A round robin wants a league table.
- A player who left halfway could only be "dropped": their past results kept
  counting, so the table stayed unfair for everybody they had played.
- Swapping pairings in a round robin broke the fixed circle-method schedule.

## Decision

1. **No draws.** A match always has a winner. The API rejects `{ draw: true }`
   and equal game counts (including 0:0) with `draws_not_allowed` (400); the
   UI offers the four best-of-3 outcomes as quick buttons (2:0, 2:1, 1:2, 0:2,
   scores read A:B, each button named after the winning side) and disables
   "Ergebnis speichern" for equal counts. Draws already stored stay readable:
   the standings still score a stored draw as one point each, and the match row
   still labels it. `tournament_match.is_draw` is kept for exactly that.
2. **`tournament.scoring`: `'games'` | `'match'`.** `games` awards 3 for a win
   without dropping a game, 2 for a win that dropped at least one, 1 for a loss
   in which the loser won a game, 0 otherwise — so 2:0 outranks 2:1, and a
   close loss beats a clean one. `match` is the classic 3/0 (draw 1). New
   tournaments of both pairing systems default to `games`; the migration
   backfills `match` into every existing tournament so none of their standings
   move. It is chosen when creating a tournament and editable only during
   registration: changing it later would silently re-rank results already
   entered (`tournament_started`, 409).
3. **`tournament.bye_scoring`: `'none'` | `'win'`.** `none` (new default): a bye
   gives no points, is not a match played, adds no games, and is stored as a
   reported 0:0 without a winner; it shows as "Spielfrei". `win` is the old
   behavior (a 2:0 win; 3 points, a match played, 2 games). Existing
   tournaments are backfilled with `win`. Swiss pairing is unchanged under
   either value: the bye still goes to the lowest-ranked player who has not had
   one. The standings read the setting, not the stored bye row, so the stored
   games are informational.
3a. **Match-win percentages stay correct under both schemes.** A single match
   is worth at most 3 points under either scheme, so own and opponents' MW%
   are still `points / (3 × matches played)`, floored at 1/3, i.e. the share
   of the available points that was earned. With `byeScoring: 'none'` a bye is
   not a played match and so sits in neither numerator nor denominator.
4. **Round robin is a league table.** The columns are Pl., Name, Sp. (matches
   played), S, N, Spiele (games won:lost), Diff., Pkt. (plus U for tournaments
   scored `match`). Tiebreakers: points, game difference, head-to-head (only
   when *exactly two* are level on both, using their direct match(es);
   with three or more it is not transitive and is skipped), games won, seed.
   OMW%/GW%/OGW% are shown and used for Swiss only. The tiebreaker choice
   follows `pairing_system`, so existing round-robin tournaments also read as
   a league table now; their points are unchanged, only the order among players
   level on points can differ. Rounds are labelled "Spieltag n". A crosstable
   (row's games : column's games) is an alternative view of the same data.
5. **Withdrawing ("Aus der Wertung nehmen") is a flag, not a status or a
   deletion.** `tournament_participant.withdrawn` (default false), settable by
   the organizer while the tournament runs and reversible then. Nothing is
   rewritten; standings are computed on read, so the flag simply makes
   `computeStandings` ignore every match with that participant, on both sides,
   past and future. A withdrawn participant is listed last, without a place,
   marked "Aus der Wertung genommen". The match DTO carries `voided` (either
   side withdrawn): a voided match needs no result — it does not block
   completing a round and `reportMatchResult` refuses it (`match_voided`) — and
   an unplayed one reads as "spielfrei" for the opponent, with no points
   whatever `bye_scoring` says (it is not a bye match, it is a void one).
   - Round robin keeps a withdrawn player in the circle: the fixtures are still
     created, so the schedule stays complete and reinstating restores real
     matches. Swiss treats a withdrawn player like a dropped one for *pairing*
     (no new pairings) and ignores their results for everybody's standings and
     tiebreakers.
   - This is separate from "Aussteigen lassen" (`dropped`): a drop keeps all
     past results and, in a round robin, gives the opponent a bye from then on;
     it stays as it was.
   - Reinstating a player whose void match sits in an already completed round
     leaves that match unplayed (a completed round cannot be reopened); it
     counts for nobody until the organizer deals with it, and the table then
     shows a player with fewer matches. Accepted: completed rounds stay frozen.
6. **Round-robin pairings are fixed.** `canEditPairings` is false for
   `round_robin` and `swapPairing` answers `pairings_fixed` (409); the UI hides
   the swap button.

## Alternatives considered

- *Deleting or rewriting a withdrawn player's matches.* Irreversible and loses
  the record; the on-read computation makes the flag free.
- *Turning a withdrawn player's future round-robin fixtures into byes.* The
  opponent's spot could not be restored when reinstating, and it would depend
  on `bye_scoring`.
- *A participant status enum (active/dropped/withdrawn).* The two states are
  independent (a withdrawn player may also have been dropped, and reinstating
  one must not touch the other), so two booleans are simpler and
  backward-compatible.
- *Replacing `scoring` by one global switch.* Existing tournaments must not
  change; a column with a backfill is the smallest thing that guarantees it.

## Consequences

- Migration `0018_tournament_scoring_withdrawn`: three `ADD COLUMN`s with
  defaults plus `UPDATE tournament SET scoring = 'match', bye_scoring = 'win'`
  (the only rows that exist when it runs are tournaments from before this ADR).
  Participants default to `withdrawn = 0`. A migration test seeds a legacy
  tournament, applies 0018 and checks its standings are unchanged.
- `computeStandings` takes `{ scoring, byeScoring, pairingSystem }` explicitly;
  there is no default, so no call site can silently fall back to a scheme.
- A withdrawn player's matches are still stored and shown (dimmed, "Zählt
  nicht"); only the standings ignore them.
- The chat assistant has no tournament tools, so nothing there changes.
