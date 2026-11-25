// Client + mappers for the YGOPRODeck v7 `cardinfo` API.
// Docs: https://ygoprodeck.com/api-guide/
//
// A single unfiltered request returns the full card database (~13k cards),
// which stays well within the documented 20 req/s rate limit, so this
// module never paginates.

import { foldCardName } from '../../shared/card-name-fold'
import { printingKey } from '../../shared/printing'
import { normalizeRarity } from '../../shared/rarity'

const YGOPRODECK_CARDINFO_URL = 'https://db.ygoprodeck.com/api/v7/cardinfo.php'

export interface YgoproCardSet {
  set_name: string
  set_code: string
  set_rarity: string
  set_rarity_code?: string
  set_price: string
}

export interface YgoproCardImage {
  id: number
  image_url: string
  image_url_small?: string
  image_url_cropped?: string
}

export interface YgoproMisc {
  tcg_date?: string
  ocg_date?: string
  /** Konami's card id, the join key to the German card data (ADR 0015). */
  konami_id?: number
}

export interface YgoproBanlistInfo {
  ban_tcg?: string
  ban_ocg?: string
  ban_goat?: string
}

export interface YgoproCard {
  id: number
  name: string
  type: string
  frameType?: string
  desc: string
  race?: string
  archetype?: string
  attribute?: string
  atk?: number
  def?: number
  level?: number
  linkval?: number
  scale?: number
  linkmarkers?: string[]
  banlist_info?: YgoproBanlistInfo
  card_prices?: Record<string, string>[]
  card_sets?: YgoproCardSet[]
  card_images?: YgoproCardImage[]
  misc_info?: YgoproMisc[]
  ygoprodeck_url?: string
}

interface YgoproCardInfoResponse {
  data: YgoproCard[]
}

/**
 * Fetches the entire YGOPRODeck card database in a single request.
 * `misc=yes` adds `misc_info`: tcg/ocg release dates (Phase 4
 * release-date-based rule formats) and the Konami id (ADR 0015).
 */
export async function fetchAllCards(): Promise<YgoproCard[]> {
  const response = await $fetch<YgoproCardInfoResponse>(YGOPRODECK_CARDINFO_URL, {
    query: { misc: 'yes' },
  })
  return response.data
}

/** Slugifies a set name into a stable, URL/id-safe `catalog_set.id`. */
export function slugifySetName(setName: string): string {
  return setName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface CatalogCardRow {
  id: number
  name: string
  type: string
  frameType: string | null
  desc: string
  race: string | null
  archetype: string | null
  attribute: string | null
  atk: number | null
  def: number | null
  level: number | null
  linkval: number | null
  scale: number | null
  linkMarkers: string[] | null
  banlistInfo: YgoproBanlistInfo | null
  cardPrices: Record<string, string> | null
  tcgDate: string | null
  ocgDate: string | null
  ygoprodeckUrl: string | null
  syncedAt: Date
  konamiId: number | null
  nameSearch: string
}

export interface CatalogSetRow {
  id: string
  name: string
}

export interface CatalogPrintingRow {
  id: string
  cardId: number
  setId: string
  setCode: string
  /** YGOPRODeck's `set_rarity` as given ("PLatinum Secret Rare", "New"). */
  rarity: string | null
  /** The rarity key it maps to (shared/rarity.ts), `null` when it names none. */
  rarityKey: string | null
  price: string | null
}

export interface CatalogCardImageRow {
  id: number
  cardId: number
  imageUrl: string
  imageUrlSmall: string | null
  imageUrlCropped: string | null
}

export interface MappedCard {
  card: CatalogCardRow
  sets: CatalogSetRow[]
  printings: CatalogPrintingRow[]
  images: CatalogCardImageRow[]
}

// Link monsters: "Link Monster" (the only type YGOPRODeck names that way).
const LINK_TYPE = /\blink\b/i

/**
 * Maps a single YGOPRODeck card into catalog row shapes. Pure function so
 * it is directly unit-testable without a database.
 */
export function mapCardToRows(card: YgoproCard, syncedAt: Date): MappedCard {
  const misc = card.misc_info?.[0]
  const cardPrices = card.card_prices?.[0] ?? null
  const konamiId = Number.isInteger(misc?.konami_id) ? misc?.konami_id ?? null : null

  const sets: CatalogSetRow[] = []
  const printings: CatalogPrintingRow[] = []
  for (const set of card.card_sets ?? []) {
    const setId = slugifySetName(set.set_name)
    sets.push({ id: setId, name: set.set_name })
    // The name first; the code only when the name is no rarity YGOPRODeck
    // spells recognisably (they never disagree in the full response).
    const rarityKey = normalizeRarity(set.set_rarity) ?? normalizeRarity(set.set_rarity_code)
    // One printing per card, set code and rarity (ADR 0034): the set code
    // alone repeats across rarities, and the sync used to keep only the last.
    printings.push({
      id: printingKey({ cardId: card.id, setCode: set.set_code, rarityKey, rarity: set.set_rarity }),
      cardId: card.id,
      setId,
      setCode: set.set_code,
      rarity: set.set_rarity ?? null,
      rarityKey,
      price: set.set_price ?? null,
    })
  }

  const images: CatalogCardImageRow[] = (card.card_images ?? []).map(image => ({
    id: image.id,
    cardId: card.id,
    imageUrl: image.image_url,
    imageUrlSmall: image.image_url_small ?? null,
    imageUrlCropped: image.image_url_cropped ?? null,
  }))

  return {
    card: {
      id: card.id,
      name: card.name,
      type: card.type,
      frameType: card.frameType ?? null,
      desc: card.desc,
      race: card.race ?? null,
      archetype: card.archetype ?? null,
      attribute: card.attribute ?? null,
      atk: card.atk ?? null,
      def: card.def ?? null,
      // YGOPRODeck sends `level: 0` for Link monsters; they have no level
      // (ADR 0023), so the level facet and format level ranges skip them.
      level: LINK_TYPE.test(card.type) ? null : card.level ?? null,
      linkval: card.linkval ?? null,
      scale: card.scale ?? null,
      linkMarkers: card.linkmarkers ?? null,
      banlistInfo: card.banlist_info ?? null,
      cardPrices,
      tcgDate: misc?.tcg_date ?? null,
      ocgDate: misc?.ocg_date ?? null,
      ygoprodeckUrl: card.ygoprodeck_url ?? null,
      syncedAt,
      konamiId,
      nameSearch: foldCardName(card.name),
    },
    sets,
    printings,
    images,
  }
}
