# 0018: Product name "YGO Alpha"

## Status

Accepted (#83, `chore/rename-ygo-alpha`).

## Context

The app called itself "yugioh alpha": in the wordmark, in every page title
(`"{page} – yugioh alpha"`, ADR 0014 §5), in the PWA manifest, in the
package name `yugioh-alpha` and in the User-Agent of its outbound requests
(ADR 0010). "Yu-Gi-Oh!" is a Konami trademark. Using it as our own product
name suggests an official product or an endorsement that doesn't exist, and
the app is starting to be seen by people other than its owner (public
profiles, shared inventories, the installable PWA).

Using the trademark to *describe* the game the app is for ("an app for the
Yu-Gi-Oh! trading card game") is a different thing: that is plain,
nominative use, and players need it to understand what the app does.

## Decision

1. **Name.** The product is called **"YGO Alpha"**. The slug (package name,
   User-Agent prefix, future repo name) is **`ygo-alpha`**.
2. **"Yu-Gi-Oh!" only describes the game.** It may appear where it names
   the game (the README intro, the manifest description, the first line of
   the assistant's system prompt, code comments about game rules), in the
   name of the external source `db-ygoresources-com/yugioh-card-history`,
   and in card and set data ("Starter Deck: Yugi", "Yami Yugi"). It is
   never part of our own name, the wordmark or a page title.
3. **Where the name shows up.**
   - Wordmark (`LayoutBrandMark`): "YGO" in `text-highlighted`, "Alpha" in
     `text-secondary`, same display face and two-tone look as before.
   - Page titles: `app.pageTitle` is now `"{page} – YGO Alpha"` (de and en).
   - `nuxt.config.ts` default title, PWA `name` and `short_name`:
     `YGO Alpha`. The manifest description stays German-only (ADR 0014):
     "Inoffizielles Fan-Tool für Sammlung, Decks, Formate und Turniere im
     Yu-Gi-Oh!-Sammelkartenspiel".
   - `package.json` `name`: `ygo-alpha`.
   - User-Agents: `ygo-alpha/<package version>` for the assistant provider
     and `ygo-alpha catalog sync (<repo URL>)` for the card-text sync. The
     repo URL stays until the repository itself is renamed.
4. **Disclaimer.** A short notice (`app.disclaimer`, de and en) says that
   YGO Alpha is an unofficial fan project, not affiliated with or endorsed
   by Konami, and that Yu-Gi-Oh! is a Konami trademark. It shows:
   - at the top of the README,
   - in the footer of the auth layout (`/login`, `/register`),
   - in the footer of the public layout (`/players/**`, the views anonymous
     visitors see).

   It is not shown in the signed-in shell for now; the shell rework (#86)
   can revisit that.
5. **Stored identifiers are kept.** None of them contains "yugioh", so no
   user state is lost:

   | Identifier | Decision |
   |---|---|
   | `ygo-color-mode` cookie | Keep. It already says YGO; renaming it would reset everyone's theme. |
   | `ui_locale` cookie | Keep (neutral name). |
   | better-auth session cookie (default `better-auth.*` prefix) | Keep. A new prefix would sign everyone out. |
   | SQLite file `data/app.db` | Keep (neutral name). |
   | Service-worker caches (workbox defaults, no `cacheId`) | Keep. Don't add a `cacheId`: it would only orphan the precache once. |
   | PWA identity (no manifest `id`, keyed by `start_url` `/`) | Unchanged. Installed apps pick up the new `name` on their next manifest update. |
   | Docker/compose names | None are set; nothing to do. |
   | Outbound User-Agents | Renamed (see 3). Nothing stored depends on them. |

6. **Guard.** `tests/nuxt/brand-name.test.ts` fails if "yugioh" shows up in
   `app/`, `server/`, `shared/`, the locale files, `nuxt.config.ts`,
   `pwa.config.ts` or `package.json`, except as part of
   `yugioh-card-history` or of the current repo URL.

## Not chosen

- **Keep "yugioh alpha" and only add a disclaimer.** A disclaimer doesn't
  fix a product name built on someone else's trademark.
- **A name with no reference to the game at all.** "YGO" is the common
  community abbreviation, not the trademark; it keeps the app recognisable
  to players.
- **Renaming stored keys to match.** Nothing stored carries the old name,
  and a rename would cost users their theme or their session for no gain.

## Consequences

- The GitHub repository was renamed from `dinooo13/yugioh-alpha` to
  `dinooo13/ygo-alpha`; the repo URL in the card-text sync User-Agent
  follows, and local clones update their remote.
- Accepted ADRs keep the old name in their text; they are history.
- Anyone installing the PWA sees "YGO Alpha"; existing installs switch on
  their next manifest update.

## Relationship to other ADRs

- **ADR 0014 §5:** the page-title pattern is now `"{page} – YGO Alpha"`.
  Nothing else in 0014 changes, so it gets no status line.
- **ADR 0010:** the assistant provider's User-Agent is now
  `ygo-alpha/<package version>`. The header itself (and why it is sent)
  is unchanged, so 0010 gets no status line either.
- **ADR 0016:** the wordmark keeps its design; only the text changes.
