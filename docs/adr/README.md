# Architecture Decision Records

Records of structural decisions (data schema, persistence, auth, core
dependencies, cross-cutting patterns). See
[`docs/WORKFLOW.md` §5](../WORKFLOW.md#5-when-to-write-an-adr) for when to
add one. Don't rewrite an accepted ADR to reverse it — add a new one and
mark the old as superseded.

| # | Title | Status |
|---|-------|--------|
| [0001](0001-card-catalog-data-model.md) | Card catalog data model and YGOPRODeck import | Accepted (admin endpoint gate superseded by [0027](0027-invite-code-and-admin-token.md)) |
| [0002](0002-owned-card-inventory-data-model.md) | Owned-card inventory data model | Accepted (collector parts superseded by [0017](0017-inventory-without-collector-details.md)) |
| [0003](0003-client-side-ocr-and-speech-entry.md) | Client-side OCR and speech entry, server-side matching | Accepted |
| [0004](0004-deck-data-model.md) | Deck data model | Accepted |
| [0005](0005-rule-format-model.md) | Rule format model | Accepted |
| [0006](0006-ai-deck-assistant.md) | AI deck assistant | Superseded by [0011](0011-deck-assistance-in-chat.md) |
| [0007](0007-sharing-and-profile-model.md) | Sharing and profile model | Accepted |
| [0008](0008-tournament-model.md) | Tournament model | Accepted |
| [0009](0009-openai-compatible-assistant-provider.md) | OpenAI-compatible assistant provider | Accepted (structured-output parts superseded by [0011](0011-deck-assistance-in-chat.md), the no-SDK transport by [0020](0020-assistant-on-the-ai-sdk.md)) |
| [0010](0010-chat-assistant-with-tools.md) | Chat assistant with tools | Accepted (partly superseded by [0011](0011-deck-assistance-in-chat.md); engine parts by [0020](0020-assistant-on-the-ai-sdk.md)) |
| [0011](0011-deck-assistance-in-chat.md) | Deck assistance in the chat assistant | Accepted (deck link superseded by [0021](0021-no-deck-link-in-assistant-conversations.md)) |
| [0012](0012-deck-cover-card.md) | Deck cover card chosen by the user | Accepted |
| [0013](0013-english-url-scheme.md) | English URL scheme and permanent redirects from German paths | Accepted (`/decks/assistent` target changed by [0021](0021-no-deck-link-in-assistant-conversations.md)) |
| [0014](0014-ui-internationalisation.md) | UI internationalisation (German and English) | Accepted |
| [0015](0015-german-card-data.md) | German card data and card display language | Accepted (implemented: F3a–F3c); UI credit superseded by [0017](0017-inventory-without-collector-details.md) |
| [0016](0016-visual-design-system.md) | Visual design system and theming (Duel Arena) | Accepted |
| [0017](0017-inventory-without-collector-details.md) | Inventory without collector details | Accepted |
| [0018](0018-product-name-ygo-alpha.md) | Product name "YGO Alpha" | Accepted |
| [0019](0019-retired-catalog-cards.md) | Retired catalog cards | Accepted (extended by [0024](0024-passcode-aliases-and-catalog-cleanup.md)) |
| [0020](0020-assistant-on-the-ai-sdk.md) | The chat assistant on the Vercel AI SDK | Accepted, implemented (84a–84c); per-turn deck context removed by [0021](0021-no-deck-link-in-assistant-conversations.md); proposals end the turn: [0026](0026-proposal-ends-the-assistant-turn.md) |
| [0021](0021-no-deck-link-in-assistant-conversations.md) | No deck link in assistant conversations | Accepted (`deck_id` dropped by migration 0017, #137) |
| [0022](0022-classic-plus-format.md) | Classic Plus as a built-in format with its own banlist | Accepted |
| [0023](0023-markdown-in-assistant-answers.md) | Markdown in assistant answers | Accepted |
| [0024](0024-passcode-aliases-and-catalog-cleanup.md) | Passcode aliases and catalog cleanup | Accepted (extended by [0025](0025-primary-artwork-and-set-facet.md)) |
| [0025](0025-primary-artwork-and-set-facet.md) | Primary artwork and the set facet | Accepted |
| [0026](0026-proposal-ends-the-assistant-turn.md) | A proposal ends the assistant turn | Accepted |
| [0027](0027-invite-code-and-admin-token.md) | Invite-only sign-up and an admin token for the catalog syncs | Accepted |
| [0028](0028-plesk-deployment.md) | Deployment to the Plesk host | Accepted |
| [0029](0029-security-headers.md) | Security headers and a hash-based Content Security Policy | Accepted |
| [0029](0029-edison-format.md) | Edison as a built-in format with a static banlist | Accepted |
