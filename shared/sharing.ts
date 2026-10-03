// Wire contract for Phase 6 (sharing and social features), shared by the
// server and the UI. Dependency-free (same discipline as
// shared/assistant-chat.ts): no Drizzle, no h3, no Vue. See
// docs/adr/0007-sharing-and-profile-model.md for the design rationale.

import type { DeckBreakdownGroup } from './deck-breakdown'
import type { DeckCover } from './deck-cover'
import type { DeckSection } from './deck-sections'
import type { AppLocale } from './locale'
import type { DeckValidation, DeckWarning } from './rule-formats'

// Labels live in the i18n catalogues: `sharing.visibility.<v>.{label,description}`
// (ADR 0014).
export const VISIBILITIES = ['private', 'link', 'public'] as const
export type Visibility = typeof VISIBILITIES[number]

export const SHARE_RESOURCE_TYPES = ['deck', 'collection', 'inventory'] as const
export type ShareResourceType = typeof SHARE_RESOURCE_TYPES[number]

export const WISHLIST_VISIBILITIES = ['private', 'public'] as const
export type WishlistVisibility = typeof WISHLIST_VISIBILITIES[number]

/** Upper bound for one wishlist item's quantity (server check and the row's stepper). */
export const MAX_WISHLIST_QUANTITY = 99

export interface UserSearchItem { userId: string, handle: string, displayName: string }
export interface ShareGrantItem { userId: string, handle: string, displayName: string, createdAt: string }

export interface ShareState {
  resourceType: ShareResourceType
  resourceId: string
  visibility: Visibility
  /** NULL while private. Owner-only: never returned by a /api/profiles/** endpoint. */
  shareToken: string | null
  grants: ShareGrantItem[]
}

export interface ShareUpdateBody { visibility?: Visibility, regenerateToken?: boolean }

export interface OwnProfile {
  userId: string
  handle: string
  displayName: string
  bio: string | null
  inventoryVisibility: Visibility
  wishlistVisibility: WishlistVisibility
  /** Chosen interface language (ADR 0014); null = not chosen. */
  locale: AppLocale | null
  /** Chosen card language (ADR 0015); null = follow the interface language. */
  cardLocale: AppLocale | null
  createdAt: string
  updatedAt: string
}

export interface PublicProfileSummary { handle: string, displayName: string, bio: string | null }

export interface SharedDeckSummary {
  id: string
  name: string
  description: string | null
  mainCount: number
  extraCount: number
  sideCount: number
  cardCount: number
  formatName: string | null
  legal: boolean | null
  /** Null for non-owners: an owner-side setting the grant does not entitle them to see. */
  visibility: Visibility | null
  updatedAt: string
  /** Cover card for the deck tile (#29); `null` for a deck without Main/Extra cards. */
  cover: DeckCover | null
  /** Copies per card kind in Main and Extra (#148), for the tile chips; `[]` for a deck without Main/Extra cards. */
  breakdown: DeckBreakdownGroup[]
}

export interface SharedCollectionSummary {
  id: string
  name: string
  description: string | null
  cardCount: number
  /** Null for non-owners: an owner-side setting the grant does not entitle them to see. */
  visibility: Visibility | null
}

export interface PublicProfileResponse {
  profile: PublicProfileSummary
  viewer: { isAuthenticated: boolean, isOwner: boolean }
  decks: SharedDeckSummary[]
  collections: SharedCollectionSummary[]
  inventory: { visible: boolean, cardCount: number }
  wishlist: { visible: boolean, itemCount: number }
}

/** Deck card row WITHOUT owned / usedInDeck / shortfall. */
export interface SharedDeckCardRow {
  catalogCardId: number
  name: string
  /** Official German name (ADR 0015); null when there is none. */
  nameDe: string | null
  type: string
  frameType: string | null
  attribute: string | null
  race: string | null
  level: number | null
  /** A Link monster's rating; null for other cards. */
  linkval: number | null
  atk: number | null
  def: number | null
  imageSmall: string | null
  /** Full-size scan for click-to-enlarge. */
  imageLarge: string | null
  section: DeckSection
  quantity: number
  /** YGOPRODeck no longer lists the card (ADR 0019). */
  retired: boolean
}

export interface SharedDeckView {
  owner: PublicProfileSummary
  /** `coverCardId`: the effective cover (ADR 0012), carried by the Omega code export. */
  deck: { id: string, name: string, description: string | null, updatedAt: string, coverCardId: number | null }
  sections: Record<DeckSection, SharedDeckCardRow[]>
  counts: { main: number, extra: number, side: number, total: number }
  limits: { mainMin: number, mainMax: number, extraMax: number, sideMax: number, maxCopies: number }
  warnings: DeckWarning[]
  format: { id: string, name: string, isBuiltin: boolean } | null
  validation: DeckValidation | null
  /** True when the *viewer* is the owner (UI shows a "Bearbeiten" link). */
  isOwner: boolean
}

export interface SharedCardListItem {
  catalogCardId: number
  name: string
  /** Official German name (ADR 0015); null when there is none. */
  nameDe: string | null
  type: string
  frameType: string | null
  attribute: string | null
  race: string | null
  level: number | null
  /** A Link monster's rating; null for other cards. */
  linkval: number | null
  atk: number | null
  def: number | null
  imageSmall: string | null
  /** Full-size scan for click-to-enlarge. */
  imageLarge: string | null
  /** Copies the owner holds in this source. */
  quantity: number
  /** YGOPRODeck no longer lists the card (ADR 0019). */
  retired: boolean
}

interface SharedCardListPage {
  owner: PublicProfileSummary
  items: SharedCardListItem[]
  total: number
  page: number
  pageSize: number
  isOwner: boolean
}

/** The owner's whole inventory. The UI titles it (`players.inventory.title`); the server sends no display name. */
export interface SharedInventoryResponse extends SharedCardListPage {
  source: { kind: 'inventory' }
}

export interface SharedCollectionResponse extends SharedCardListPage {
  source: { kind: 'collection', id: string, name: string }
}

export type SharedCardListResponse = SharedInventoryResponse | SharedCollectionResponse

export interface WishlistItemView {
  id: string
  catalogCardId: number
  name: string
  /** Official German name (ADR 0015); null when there is none. */
  nameDe: string | null
  type: string
  imageSmall: string | null
  /** YGOPRODeck no longer lists the card (ADR 0019); the item still resolves. */
  retired: boolean
  quantity: number
  note: string | null
  /** Owner-only: copies already in the inventory. Absent in the public view. */
  owned?: number
  createdAt: string
  updatedAt: string
}

export interface WishlistResponse { items: WishlistItemView[], total: number, page: number, pageSize: number }
export interface SharedWishlistResponse extends WishlistResponse { owner: PublicProfileSummary }
