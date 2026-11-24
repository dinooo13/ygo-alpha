// Types of the shared card detail overlay (`CardDetailModal`, #88).

/** `GET /api/catalog/cards/:id`: the card with both languages, its printings and its scans. */
export interface CatalogCardDetail {
  card: {
    id: number
    name: string
    nameDe: string | null
    type: string
    frameType: string | null
    desc: string
    descDe: string | null
    race: string | null
    archetype: string | null
    attribute: string | null
    atk: number | null
    def: number | null
    level: number | null
    linkval: number | null
    scale: number | null
    linkMarkers: string[] | null
    banlistInfo: Record<string, string> | null
    cardPrices: Record<string, string> | null
    tcgDate: string | null
    ocgDate: string | null
    ygoprodeckUrl: string | null
    /** YGOPRODeck no longer lists the card (ADR 0019); it still resolves by id. */
    retired: boolean
    /** The active card a retired one was renumbered to, if any. */
    replacedById: number | null
  }
  printings: Array<{
    /** `catalog_printing.id` (ADR 0034); older fixtures may lack it. */
    id?: string
    setCode: string
    setName: string
    rarity: string | null
    rarityCode?: string | null
    price: string | null
  }>
  images: Array<{
    id: number
    imageUrl: string
    imageUrlSmall: string | null
    imageUrlCropped: string | null
  }>
}

/**
 * What the caller already knows about the card (a catalog tile, an inventory
 * search result), shown at once while the full detail loads.
 */
export interface CardDetailPreview {
  name: string
  nameDe?: string | null
  type: string
  frameType?: string | null
  attribute: string | null
  race?: string | null
  level: number | null
  /** A Link monster's rating. */
  linkval?: number | null
  atk: number | null
  def: number | null
  imageSmall?: string | null
  imageLarge?: string | null
}

/**
 * `catalog` adds the English name, printings and release dates; `deck` (the
 * deck editor) is `catalog` without the printings; `inventory` shows only the card.
 */
export type CardDetailVariant = 'catalog' | 'deck' | 'inventory'

/** The card an overlay action works on (the shape `AddToInventoryModal` takes). */
export interface CardDetailSummary {
  id: number
  name: string
  nameDe?: string | null
  type: string
}
