import type { CardValueKind } from '~/utils/card-values'

// Shape of one aggregated row from `GET /api/inventory/search`, shared by the
// "Galerie" tile and its detail panel (#135).
export interface InventoryCollectionBreakdown {
  collectionId: string | null
  collectionName: string | null
  quantity: number
}

/**
 * A known printing behind a "Galerie" tile (set code and/or rarity key, ADR
 * 0034) and its copies.
 */
export interface InventoryPrintingBreakdown {
  setCode: string | null
  rarity: string | null
  quantity: number
}

export interface InventorySearchResultItem {
  catalogCardId: number
  name: string
  /** Official German name (ADR 0015); null when there is none. */
  nameDe?: string | null
  type: string
  attribute: string | null
  race: string | null
  level: number | null
  /** A Link monster's rating; null for other cards. */
  linkval?: number | null
  atk: number | null
  def: number | null
  imageSmall: string | null
  imageLarge?: string | null
  /** YGOPRODeck no longer lists the card (ADR 0019). */
  retired?: boolean
  totalQuantity: number
  collectionBreakdown?: InventoryCollectionBreakdown[]
  /** Known printings only; copies without set code and rarity are not listed. */
  printingBreakdown?: InventoryPrintingBreakdown[]
}

/** Collection name for a breakdown row; `t` translates the two fallbacks (ADR 0014). */
export function breakdownLabel(entry: InventoryCollectionBreakdown, t: (key: string) => string): string {
  if (!entry.collectionId) {
    return t('inventory.breakdown.noCollection')
  }
  return entry.collectionName ?? t('inventory.breakdown.unnamedCollection')
}

export function breakdownKey(entry: InventoryCollectionBreakdown): string {
  return entry.collectionId ?? '__none__'
}

/**
 * "Type · Attribute · Race"; `label` turns each stored English value into its
 * label in the card language (`useCardText().cardValue`, ADR 0015).
 */
export function cardSubtitle(
  item: Pick<InventorySearchResultItem, 'type' | 'attribute' | 'race'>,
  label: (kind: CardValueKind, value: string) => string = (_kind, value) => value,
): string {
  const parts: Array<[CardValueKind, string | null]> = [['type', item.type], ['attribute', item.attribute], ['race', item.race]]
  return parts
    .filter((part): part is [CardValueKind, string] => Boolean(part[1]))
    .map(([kind, value]) => label(kind, value))
    .join(' · ')
}
