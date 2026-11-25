// The rarities a card can be printed in (ADR 0034), from Yugipedia's
// rarity table (https://yugipedia.com/wiki/Module:Data/static/rarity/data,
// fetched 2026-11-25): a stable key, the abbreviation and the English name as
// printed on products. YGOPRODeck's `set_rarity` / `set_rarity_code` are
// mapped onto these keys (`normalizeRarity`); its spellings vary ("PLatinum
// Secret Rare", no code for Quarter Century Secret Rare) and some entries are
// no rarity at all ("New", "2", "Reprint"), which map to none.

export type RarityGroup =
  | 'nonFoil' | 'foil' | 'secret' | 'precious' | 'millennium' | 'parallel'
  | 'duelTerminal' | 'kaiba' | 'rush' | 'colorful' | 'other'

export interface Rarity {
  /** Stable key, stored in `owned_card.rarity` and `catalog_printing.rarity_key`. */
  key: string
  /** Abbreviation, e.g. "QCScR". */
  abbr: string
  /** English name as printed, e.g. "Quarter Century Secret Rare". */
  name: string
  group: RarityGroup
}

export const RARITIES: readonly Rarity[] = [
  { key: "c", abbr: "C", name: "Common", group: 'nonFoil' },
  { key: "nr", abbr: "NR", name: "Normal Rare", group: 'nonFoil' },
  { key: "sp", abbr: "SP", name: "Short Print", group: 'nonFoil' },
  { key: "ssp", abbr: "SSP", name: "Super Short Print", group: 'nonFoil' },
  { key: "r", abbr: "R", name: "Rare", group: 'nonFoil' },
  { key: "sr", abbr: "SR", name: "Super Rare", group: 'foil' },
  { key: "ur", abbr: "UR", name: "Ultra Rare", group: 'foil' },
  { key: "utr", abbr: "UtR", name: "Ultimate Rare", group: 'foil' },
  { key: "gr", abbr: "GR", name: "Ghost Rare", group: 'foil' },
  { key: "hgr", abbr: "HGR", name: "Holographic Rare", group: 'foil' },
  { key: "scr", abbr: "ScR", name: "Secret Rare", group: 'secret' },
  { key: "pscr", abbr: "PScR", name: "Prismatic Secret Rare", group: 'secret' },
  { key: "uscr", abbr: "UScR", name: "Ultra Secret Rare", group: 'secret' },
  { key: "scur", abbr: "ScUR", name: "Secret Ultra Rare", group: 'secret' },
  { key: "escr", abbr: "EScR", name: "Extra Secret Rare", group: 'secret' },
  { key: "20scr", abbr: "20ScR", name: "20th Secret Rare", group: 'secret' },
  { key: "10000scr", abbr: "10000ScR", name: "10000 Secret Rare", group: 'secret' },
  { key: "qcscr", abbr: "QCScR", name: "Quarter Century Secret Rare", group: 'secret' },
  { key: "str", abbr: "StR", name: "Starlight Rare", group: 'secret' },
  { key: "gmr", abbr: "GMR", name: "Grand Master Rare", group: 'secret' },
  { key: "gur", abbr: "GUR", name: "Gold Rare", group: 'precious' },
  { key: "gscr", abbr: "GScR", name: "Gold Secret Rare", group: 'precious' },
  { key: "ggr", abbr: "GGR", name: "Ghost/Gold Rare", group: 'precious' },
  { key: "pgr", abbr: "PGR", name: "Premium Gold Rare", group: 'precious' },
  { key: "plr", abbr: "PlR", name: "Platinum Rare", group: 'precious' },
  { key: "plscr", abbr: "PlScR", name: "Platinum Secret Rare", group: 'precious' },
  { key: "mlr", abbr: "MLR", name: "Millennium Rare", group: 'millennium' },
  { key: "mlsr", abbr: "MLSR", name: "Millennium Super Rare", group: 'millennium' },
  { key: "mlur", abbr: "MLUR", name: "Millennium Ultra Rare", group: 'millennium' },
  { key: "mlscr", abbr: "MLScR", name: "Millennium Secret Rare", group: 'millennium' },
  { key: "mlgr", abbr: "MLGR", name: "Millennium Gold Rare", group: 'millennium' },
  { key: "npr", abbr: "NPR", name: "Normal Parallel Rare", group: 'parallel' },
  { key: "rpr", abbr: "RPR", name: "Rare Parallel Rare", group: 'parallel' },
  { key: "spr", abbr: "SPR", name: "Super Parallel Rare", group: 'parallel' },
  { key: "upr", abbr: "UPR", name: "Ultra Parallel Rare", group: 'parallel' },
  { key: "scpr", abbr: "ScPR", name: "Secret Parallel Rare", group: 'parallel' },
  { key: "escpr", abbr: "EScPR", name: "Extra Secret Parallel Rare", group: 'parallel' },
  { key: "hgpr", abbr: "HGPR", name: "Holographic Parallel Rare", group: 'parallel' },
  { key: "dnpr", abbr: "DNPR", name: "Duel Terminal Normal Parallel Rare", group: 'duelTerminal' },
  { key: "dnrpr", abbr: "DNRPR", name: "Duel Terminal Normal Rare Parallel Rare", group: 'duelTerminal' },
  { key: "drpr", abbr: "DRPR", name: "Duel Terminal Rare Parallel Rare", group: 'duelTerminal' },
  { key: "dspr", abbr: "DSPR", name: "Duel Terminal Super Parallel Rare", group: 'duelTerminal' },
  { key: "dupr", abbr: "DUPR", name: "Duel Terminal Ultra Parallel Rare", group: 'duelTerminal' },
  { key: "dscpr", abbr: "DScPR", name: "Duel Terminal Secret Parallel Rare", group: 'duelTerminal' },
  { key: "kcc", abbr: "KCC", name: "Kaiba Corporation Common", group: 'kaiba' },
  { key: "kcr", abbr: "KCR", name: "Kaiba Corporation Rare", group: 'kaiba' },
  { key: "kcsr", abbr: "KCSR", name: "Kaiba Corporation Super Rare", group: 'kaiba' },
  { key: "kcur", abbr: "KCUR", name: "Kaiba Corporation Ultra Rare", group: 'kaiba' },
  { key: "rr", abbr: "RR", name: "Rush Rare", group: 'rush' },
  { key: "grr", abbr: "GRR", name: "Gold Rush Rare", group: 'rush' },
  { key: "orr", abbr: "ORR", name: "Over Rush Rare", group: 'rush' },
  { key: "forr", abbr: "FORR", name: "Full Over Rush Rare", group: 'rush' },
  { key: "urblue", abbr: "URBlue", name: "Ultra Rare (Special Blue Version)", group: 'colorful' },
  { key: "urpurple", abbr: "URPurple", name: "Ultra Rare (Special Purple Version)", group: 'colorful' },
  { key: "urred", abbr: "URRed", name: "Ultra Rare (Special Red Version)", group: 'colorful' },
  { key: "scrblue", abbr: "ScRBlue", name: "Secret Rare (Special Blue Version)", group: 'colorful' },
  { key: "scrred", abbr: "ScRRed", name: "Secret Rare (Special Red Version)", group: 'colorful' },
  { key: "rrred", abbr: "RRRed", name: "Rush Rare (Special Red Version)", group: 'colorful' },
  { key: "orrblack", abbr: "ORRBlack", name: "Over Rush Rare (Premium Black Version)", group: 'colorful' },
  { key: "qcscrtdgreen", abbr: "QCScRTDGreen", name: "Quarter Century Secret Rare Tokyo Dome Green Version", group: 'colorful' },
  { key: "qcscrsv", abbr: "QCScRSV", name: "Quarter Century Secret Rare (Special Version)", group: 'colorful' },
  { key: "hfr", abbr: "HFR", name: "Holofoil Rare", group: 'other' },
  { key: "sfr", abbr: "SFR", name: "Starfoil Rare", group: 'other' },
  { key: "msr", abbr: "MSR", name: "Mosaic Rare", group: 'other' },
  { key: "shr", abbr: "SHR", name: "Shatterfoil Rare", group: 'other' },
  { key: "cr", abbr: "CR", name: "Collector's Rare", group: 'other' },
  { key: "urpr", abbr: "URPR", name: "Ultra Rare (Pharaoh's Rare)", group: 'other' },
]

export const RARITY_GROUPS: readonly RarityGroup[] = [
  'nonFoil', 'foil', 'secret', 'precious', 'millennium', 'parallel',
  'duelTerminal', 'kaiba', 'rush', 'colorful', 'other',
]

const BY_KEY = new Map(RARITIES.map(rarity => [rarity.key, rarity]))

/** The rarity with this key, or `undefined`. */
export function rarityByKey(key: string | null | undefined): Rarity | undefined {
  return key ? BY_KEY.get(key) : undefined
}

/** "Ultra Rare (UR)" for a rarity key; `null` for none or an unknown key. */
export function rarityLabel(key: string | null | undefined): string | null {
  const rarity = rarityByKey(key)
  return rarity ? `${rarity.name} (${rarity.abbr})` : null
}

/** Whether `key` is one of `RARITIES`. */
export function isRarityKey(key: unknown): key is string {
  return typeof key === 'string' && BY_KEY.has(key)
}

// Spellings → key: lower case, letters and digits only, from Yugipedia's
// `normalize` table (plus YGOPRODeck's "Ultra Rare (Pharaoh's Rare)").
const ALIASES: Record<string, string> = {
  "10000scr": '10000scr',
  "10000secret": '10000scr',
  "20scr": '20scr',
  "20thsecret": '20scr',
  alternate: 'str',
  altr: 'str',
  c: 'c',
  collector: 'cr',
  collectors: 'cr',
  common: 'c',
  cr: 'cr',
  dnpr: 'dnpr',
  dnrpr: 'dnrpr',
  drpr: 'drpr',
  dscpr: 'dscpr',
  dspr: 'dspr',
  duelterminalnormalparallel: 'dnpr',
  duelterminalnormalrareparallel: 'dnrpr',
  duelterminalrareparallel: 'drpr',
  duelterminalsecretparallel: 'dscpr',
  duelterminalsuperparallel: 'dspr',
  duelterminalultraparallel: 'dupr',
  dupr: 'dupr',
  escpr: 'escpr',
  escr: 'escr',
  extrasecret: 'escr',
  extrasecretparallel: 'escpr',
  forr: 'forr',
  fulloverrush: 'forr',
  ggr: 'ggr',
  ghost: 'gr',
  ghostgold: 'ggr',
  gmr: 'gmr',
  gold: 'gur',
  goldrush: 'grr',
  goldsecret: 'gscr',
  goldultra: 'gur',
  gr: 'gr',
  grandmaster: 'gmr',
  grr: 'grr',
  gscr: 'gscr',
  gur: 'gur',
  hfr: 'hfr',
  hgpr: 'hgpr',
  hgr: 'hgr',
  holofoil: 'hfr',
  holographic: 'hgr',
  holographicparallel: 'hgpr',
  kaibacorporation: 'kcr',
  kaibacorporationcommon: 'kcc',
  kaibacorporationnormal: 'kcc',
  kaibacorporationsuper: 'kcsr',
  kaibacorporationultra: 'kcur',
  kcc: 'kcc',
  kcn: 'kcc',
  kcr: 'kcr',
  kcs: 'kcsr',
  kcsr: 'kcsr',
  kcu: 'kcur',
  kcur: 'kcur',
  millennium: 'mlr',
  millenniumgold: 'mlgr',
  millenniumsecret: 'mlscr',
  millenniumsuper: 'mlsr',
  millenniumultra: 'mlur',
  mlgr: 'mlgr',
  mlr: 'mlr',
  mlscr: 'mlscr',
  mlsr: 'mlsr',
  mlur: 'mlur',
  mosaic: 'msr',
  mr: 'mlr',
  msr: 'msr',
  n: 'c',
  normal: 'nr',
  normalparallel: 'npr',
  npr: 'npr',
  nr: 'nr',
  orr: 'orr',
  orrblack: 'orrblack',
  overrush: 'orr',
  overrushrarepremiumblackversion: 'orrblack',
  pgr: 'pgr',
  pharaoh: 'urpr',
  pharaohsrareultra: 'urpr',
  platinum: 'plr',
  platinumsecret: 'plscr',
  plr: 'plr',
  plscr: 'plscr',
  premiumgold: 'pgr',
  prismatic: 'pscr',
  prismaticsecret: 'pscr',
  pscr: 'pscr',
  qcscr: 'qcscr',
  qcscrsv: 'qcscrsv',
  qcscrtdgreen: 'qcscrtdgreen',
  quartercenturysecret: 'qcscr',
  quartercenturysecretrarespecialversion: 'qcscrsv',
  quartercenturysecretraretokyodomegreenversion: 'qcscrtdgreen',
  r: 'r',
  rare: 'r',
  rareparallel: 'rpr',
  rpr: 'rpr',
  rr: 'rr',
  rrred: 'rrred',
  rush: 'rr',
  rushrarespecialredversion: 'rrred',
  scpr: 'scpr',
  scr: 'scr',
  scrblue: 'scrblue',
  scrred: 'scrred',
  scur: 'scur',
  secret: 'scr',
  secretparallel: 'scpr',
  secretrarespecialblueversion: 'scrblue',
  secretrarespecialredversion: 'scrred',
  secretultra: 'scur',
  sfr: 'sfr',
  shatterfoil: 'shr',
  shortprint: 'sp',
  shr: 'shr',
  sp: 'sp',
  spr: 'spr',
  sr: 'sr',
  ssp: 'ssp',
  starfoil: 'sfr',
  starlight: 'str',
  str: 'str',
  super: 'sr',
  superparallel: 'spr',
  supershortprint: 'ssp',
  ultimate: 'utr',
  ultra: 'ur',
  ultraparallel: 'upr',
  ultrapharaoh: 'urpr',
  ultrararepharaoh: 'urpr',
  ultrararepharaohs: 'urpr',
  ultrararespecialblueversion: 'urblue',
  ultrararespecialpurpleversion: 'urpurple',
  ultrararespecialredversion: 'urred',
  ultrasecret: 'uscr',
  upr: 'upr',
  ur: 'ur',
  urblue: 'urblue',
  urpr: 'urpr',
  urpurple: 'urpurple',
  urred: 'urred',
  uscr: 'uscr',
  utr: 'utr',
}

/**
 * Maps a rarity name or abbreviation as YGOPRODeck or a user writes it
 * ("Ultra Rare", "(UR)", "QCScR", "PLatinum Secret Rare") to a rarity key;
 * `null` when it is no known rarity ("New", "2", "Reprint").
 */
export function normalizeRarity(text: string | null | undefined): string | null {
  const compact = (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!compact) {
    return null
  }
  const direct = ALIASES[compact]
  if (direct) {
    return direct
  }
  return compact.endsWith('rare') ? ALIASES[compact.slice(0, -'rare'.length)] ?? null : null
}
