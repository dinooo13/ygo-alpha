import { describe, expect, it } from 'vitest'
import {
  countEntryLines,
  deckPasscodes,
  deckRecipeRows,
  decodeYdke,
  encodeOmegaCode,
  encodeRecipe,
  encodeYdk,
  encodeYdke,
  mergeDecklistEntries,
  omegaPayload,
  parseSectionHeader,
  readOmegaPayload,
  uint32sToBytes,
  ydkFileName,
} from '../../shared/decklist'
import type { DecklistEntry, DecklistSections } from '../../shared/decklist'
import { parseDecklist } from '../../server/utils/decklist-parse'

// The sample code from ungive/omega-api-decks: 43 Main + Extra cards, 10 Side cards, no trailer.
const OMEGA_CODE = '0+a6LjWfEYbv/L/MAMIXps0AY4kjoiww/PbQdlYYFuz7zgDDKmaXWGB4zsmPjCC8uMSeGYRfys5kheHgpcuZQXj3GXs4XnDhIQscP7oGx/ll7xlguPCSLrM1cx1L/+bXjBYbk1k0uaWYg753MQcD8Ub3TWD8MGIuGIPsBNkBAA=='
// A Cyber Dragon deck from a current Omega "Export" (tester, Oct 2026): 55 Main +
// Extra cards, 3 Side cards, then Cyber End Dragon (01546123) as the cover card.
const OMEGA_CODE_WITH_COVER = 'M2c2mqjLAsP2338wZt6Zz/KTNYKZaVIH8znNu0xq/wIZKnKMGaYknWSs/hjI8HpKDmNCgSDDf54Y5ifnzBlgeN0VHcbzu7VYa7V/MNqtn8P8U3MfyyTNZIbfd0QYeYztmK7WXGDeuzyfsfbbfgavAk/mYytvsUjfMGd4r/qPRXpSIuMzhi+MOn8Dmdt4brC+Vw9kEOmdz/I7LYCx8LAFS9ziA4wlhg4M/b7bmH/PMmSeHRLBLHRzAZO150nW7uniDN0cL1gafAxZBbfdZH7Snc0S9GkHS+8CJlZu85/MMAxSBwA='
const YDKE_SAMPLE = 'ydke://o6lXBZyFNAI=!viOnAg==!7ydRAA==!'
// The same deck as OMEGA_CODE_WITH_COVER, as Omega's German "Rezept" and its YDK export.
const OMEGA_RECIPE_DE = `Monster
3 Cyber Drache
1 Cyber-Eltanin
1 Jinzo
1 Cyberfinsternis Gewürm
1 Cyber Drache Drei
1 Hüter der Drachenmagie
1 Cyber Drache Zwei
1 Cyber Phönix
1 Cyber Drache Vier
1 Cyberfinsternis Schimäre
1 Cyber Drachenmark
1 Cyber Drache Nächster
1 Cyber Drache Herz
3 Cybertal
1 Cyber-Jormungardr
Zauber
1 Cyber Reparaturwerkstatt
1 Cyber-Drehsystem
1 Cyber-Notfall
1 Elegante Wohltäterin
1 Fusionsentsendung
1 Harpyien-Flederwisch
1 Kraftbündnis
1 Maschinenduplizierung
1 Polymerisation
1 Raigeki
1 Topf der Gier
1 Törichtes Begräbnis
1 Überlastfusion
1 Wiedergeburt
1 Begrenzer-Entferner
1 Cyber-Ewig
1 Cyberlast-Fusion
1 Feindkontrolle
1 Mystischer Raum-Taifun
1 Zukunftsfusion
1 Megawandler
1 Voreiliges Begräbnis
Falle
1 Bodenlose Fallgrube
1 Fallgrube
1 Magischer Zylinder
1 Reißender Tribut
1 Sakuretsu-Rüstung
1 Spiegelkraft
1 Ruf der Gejagten
Extra
1 Cyber End-Drache
1 Cyber Ewigkeitsdrache
1 Chimeratech-Megaflottendrache
1 Chimeratech-Überdrache
1 Cyber Zwillings-Drache
1 Chimeratech-Festungsdrache
1 Chimeratech-Amoklaufdrache
Side
3 Cyber Dragon, the Luminous Mech Dragon`
const OMEGA_YDK = `#Created by YGO Omega
#tags=
#main
70095154
70095154
70095154
33093439
77585513
56100345
59281922
48048590
5373478
3370104
29975188
5370235
23893227
1142880
56364287
3657444
3657444
3657444
19715246
86686671
33041277
60600126
79571449
6498706
18144507
37630732
63995093
24094653
12580477
55144522
81439174
3659803
83764719
23171611
32768230
55704876
98045062
5318639
77565204
22046459
70828913
29401950
4206964
62279055
53582587
56120475
44095762
97077563
#extra
1546123
82315403
87116928
64599569
74157028
79229522
84058253
!side
66664203
66664203
66664203`

const OMEGA_RECIPE = `Monster
3 Tearlaments Havnis
1 Danger!? Jackalope?
Spell
2 Polymerization
Trap
2 Tearlaments Sulliek
Extra
2 Spright Elf
Side
2 Cosmic Cyclone`

function copies(entries: DecklistEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.quantity, 0)
}

function names(sections: DecklistSections) {
  return {
    main: sections.main.map(entry => `${entry.quantity} ${entry.name}`),
    extra: sections.extra.map(entry => `${entry.quantity} ${entry.name}`),
    side: sections.side.map(entry => `${entry.quantity} ${entry.name}`),
  }
}

describe('parseSectionHeader', () => {
  it.each([
    ['Monster', 'main'], ['Monsters', 'main'], ['Monster Cards', 'main'], ['Monsterkarte', 'main'], ['Monsterkarten', 'main'],
    ['Spell', 'main'], ['Spells', 'main'], ['Spell Cards', 'main'], ['Zauber', 'main'], ['Zauberkarte', 'main'], ['Zauberkarten', 'main'],
    ['Trap', 'main'], ['Traps', 'main'], ['Trap Cards', 'main'], ['Falle', 'main'], ['Fallen', 'main'], ['Fallenkarte', 'main'], ['Fallenkarten', 'main'],
    ['Main', 'main'], ['Main Deck', 'main'], ['Maindeck', 'main'], ['Main-Deck', 'main'], ['Hauptdeck', 'main'],
    ['Extra', 'extra'], ['Extra Deck', 'extra'], ['Extradeck', 'extra'], ['Extra-Deck', 'extra'],
    ['Side', 'side'], ['Side Deck', 'side'], ['Sidedeck', 'side'], ['Side-Deck', 'side'],
  ] as const)('reads %s', (header, section) => {
    expect(parseSectionHeader(header)).toBe(section)
    expect(parseSectionHeader(header.toUpperCase())).toBe(section)
    expect(parseSectionHeader(`${header}:`)).toBe(section)
    expect(parseSectionHeader(`${header} (21)`)).toBe(section)
    expect(parseSectionHeader(`${header}: 21`)).toBe(section)
    expect(parseSectionHeader(`  ${header.toLowerCase()} (21):  `)).toBe(section)
  })

  it('reads the YDK markers', () => {
    expect(parseSectionHeader('#main')).toBe('main')
    expect(parseSectionHeader('#extra')).toBe('extra')
    expect(parseSectionHeader('!side')).toBe('side')
  })

  it('leaves card lines and comments alone', () => {
    for (const line of ['3 Monster Reborn', 'Monster Reborn', 'Monster Egg', 'Monster-Ei', 'Fallen-Tribut', '#created by Fabian', '3', '46986414', 'Dark Magician (SDY-006)', '']) {
      expect(parseSectionHeader(line), line).toBeNull()
    }
  })
})

describe('parseDecklist: ydke', () => {
  it('reads the three sections of a ydke link', () => {
    const parsed = parseDecklist(YDKE_SAMPLE)

    expect(parsed.format).toBe('ydke')
    expect(parsed.sections.main).toEqual([
      { passcode: 89631139, quantity: 1, raw: '89631139' },
      { passcode: 36996508, quantity: 1, raw: '36996508' },
    ])
    expect(parsed.sections.extra).toEqual([{ passcode: 44508094, quantity: 1, raw: '44508094' }])
    expect(parsed.sections.side).toEqual([{ passcode: 5318639, quantity: 1, raw: '5318639' }])
  })

  it('merges the copies of a card and reads empty sections', () => {
    const link = encodeYdke({ main: [1, 1, 1, 0xFBFFFFFF], extra: [], side: [] })
    expect(link.endsWith('!!!')).toBe(true)

    const parsed = parseDecklist(link.replace('ydke://', 'YDKE://'))
    expect(parsed.format).toBe('ydke')
    expect(parsed.sections.main).toEqual([
      { passcode: 1, quantity: 3, raw: '1' },
      { passcode: 0xFBFFFFFF, quantity: 1, raw: String(0xFBFFFFFF) },
    ])
    expect(parsed.sections.extra).toEqual([])
    expect(parsed.sections.side).toEqual([])
  })

  it('reads URL-safe base64', () => {
    // 0xFBFFFFFF encodes with "+" and "/" in standard base64 ("+///" … ).
    const standard = encodeYdke({ main: [0xFBFFFFFF, 0xFFFFFFFE], extra: [], side: [] })
    expect(standard).toMatch(/[+/]/)
    const urlSafe = `ydke://${standard.slice('ydke://'.length).replace(/\+/g, '-').replace(/\//g, '_')}`

    expect(parseDecklist(urlSafe).sections.main.map(entry => entry.passcode)).toEqual([0xFBFFFFFF, 0xFFFFFFFE])
  })

  it('rejects a ydke link that cannot be read', () => {
    expect(() => parseDecklist('ydke://nope')).toThrow()
    expect(() => parseDecklist('ydke://AAA!!!')).toThrow()
    expect(() => parseDecklist('ydke://@@@!!!')).toThrow()
    expect(decodeYdke('ydke://nope')).toBeNull()
  })
})

describe('parseDecklist: YGO Omega deck code', () => {
  it('reads Main and Extra mixed, then the Side Deck', () => {
    const parsed = parseDecklist(OMEGA_CODE)

    expect(parsed.format).toBe('omega')
    expect(parsed.sections.main[0]).toEqual({ passcode: 27204311, quantity: 3, raw: '27204311' })
    expect(parsed.sections.main[1]).toEqual({ passcode: 13893596, quantity: 2, raw: '13893596' })
    // Not separated: all 43 Main + Extra cards are in `main`.
    expect(parsed.sections.extra).toEqual([])
    expect(copies(parsed.sections.main)).toBe(43)
    expect(copies(parsed.sections.side)).toBe(10)
  })

  it('reads a current export with the cover card after the Side Deck', () => {
    const parsed = parseDecklist(OMEGA_CODE_WITH_COVER)

    expect(parsed.format).toBe('omega')
    expect(parsed.sections.main[0]).toEqual({ passcode: 70095154, quantity: 3, raw: '70095154' })
    expect(copies(parsed.sections.main)).toBe(55)
    // The cover card is not an extra copy: Cyber End Dragon is in the deck once.
    expect(parsed.sections.main.find(entry => entry.passcode === 1546123)?.quantity).toBe(1)
    expect(parsed.sections.side).toEqual([{ passcode: 66664203, quantity: 3, raw: '66664203' }])
    expect(parsed.cover).toBe(1546123)
    expect(parseDecklist(OMEGA_CODE).cover).toBeNull()
  })

  it('reads the same deck from Omega\'s code, YDK and German recipe', () => {
    const code = parseDecklist(OMEGA_CODE_WITH_COVER)
    const ydk = parseDecklist(OMEGA_YDK)
    const recipe = parseDecklist(OMEGA_RECIPE_DE)
    const passcodes = (entries: DecklistEntry[]) => entries.map(entry => [entry.passcode, entry.quantity]).sort((a, b) => a[0]! - b[0]!)

    expect(ydk.format).toBe('ydk')
    // The code mixes Main and Extra; the YDK keeps them apart.
    expect(passcodes(code.sections.main)).toEqual(passcodes(mergeDecklistEntries([...ydk.sections.main, ...ydk.sections.extra])))
    expect(passcodes(code.sections.side)).toEqual(passcodes(ydk.sections.side))
    expect(ydk.cover).toBeNull()

    expect(recipe.format).toBe('text')
    expect([copies(recipe.sections.main), copies(recipe.sections.extra), copies(recipe.sections.side)]).toEqual([48, 7, 3])
    expect(copies(recipe.sections.main) + copies(recipe.sections.extra)).toBe(copies(code.sections.main))
    // "Falle" is a header, not a card.
    expect(recipe.sections.main.some(entry => entry.name === 'Falle')).toBe(false)
    expect(recipe.sections.main.at(-1)).toMatchObject({ name: 'Ruf der Gejagten', quantity: 1 })
  })

  it('tolerates whitespace around the code and a wrapped line', () => {
    const wrapped = `  ${OMEGA_CODE.slice(0, 40)}\n${OMEGA_CODE.slice(40)}\n`

    expect(parseDecklist(wrapped).format).toBe('omega')
  })

  it('is no Omega code when the payload does not inflate or its counts do not fit', () => {
    expect(parseDecklist('Kuriboh').format).toBe('text')
    expect(parseDecklist('AAAAAAAAAAAAAAAAAAAA').format).toBe('text')
    expect(parseDecklist('Kuriboh\nRaigeki\nHinotama').format).toBe('text')
    expect(parseDecklist(OMEGA_CODE.slice(0, 60)).format).toBe('text')
  })
})

describe('parseDecklist: YDK', () => {
  const YDK = `#created by Fabian
#main
46986414
46986414
5318639
#extra
44508094
!side
55144522
`

  it('reads the sections and merges one line per copy', () => {
    const parsed = parseDecklist(YDK)

    expect(parsed.format).toBe('ydk')
    expect(parsed.sections.main).toEqual([
      { passcode: 46986414, quantity: 2, raw: '46986414' },
      // A 7-digit passcode lost its leading zero: 05318639.
      { passcode: 5318639, quantity: 1, raw: '5318639' },
    ])
    expect(parsed.sections.extra).toEqual([{ passcode: 44508094, quantity: 1, raw: '44508094' }])
    expect(parsed.sections.side).toEqual([{ passcode: 55144522, quantity: 1, raw: '55144522' }])
  })

  it('reads Windows line endings, other comments and a file without a trailing newline', () => {
    const parsed = parseDecklist('#created by x\r\n#some other comment\r\n#main\r\n46986414\r\n#extra\r\n!side\r\n55144522')

    expect(parsed.format).toBe('ydk')
    expect(parsed.sections.main).toHaveLength(1)
    expect(parsed.sections.extra).toEqual([])
    expect(parsed.sections.side).toHaveLength(1)
  })

  it('reads a YDK without markers as a list of passcodes', () => {
    const parsed = parseDecklist('46986414\n46986414\n5318639')

    expect(parsed.format).toBe('ydk')
    expect(parsed.sections.main).toHaveLength(2)
  })
})

describe('parseDecklist: text recipe', () => {
  it("reads Omega's recipe", () => {
    const parsed = parseDecklist(OMEGA_RECIPE)

    expect(parsed.format).toBe('text')
    expect(names(parsed.sections)).toEqual({
      main: ['3 Tearlaments Havnis', '1 Danger!? Jackalope?', '2 Polymerization', '2 Tearlaments Sulliek'],
      extra: ['2 Spright Elf'],
      side: ['2 Cosmic Cyclone'],
    })
    expect(parsed.sections.main[0]!.raw).toBe('3 Tearlaments Havnis')
  })

  it('reads EDOPro-style headers with counts, in English and German', () => {
    const edopro = parseDecklist('Main Deck: 3\n3x Kuriboh\nExtra Deck: 1\nStardust Dragon\nSide Deck: 2\nRaigeki x2')
    expect(names(edopro.sections)).toEqual({ main: ['3 Kuriboh'], extra: ['1 Stardust Dragon'], side: ['2 Raigeki'] })

    const german = parseDecklist('Monsterkarten (1)\n3 Kuriboh\nZauberkarten (1)\n2 Raigeki\nFallenkarten\n1 Mirror Force\nExtradeck\nStardust Dragon\nSidedeck\n1 Hinotama')
    expect(names(german.sections)).toEqual({
      main: ['3 Kuriboh', '2 Raigeki', '1 Mirror Force'],
      extra: ['1 Stardust Dragon'],
      side: ['1 Hinotama'],
    })
  })

  it('reads the quantity shapes and ids of a line', () => {
    const parsed = parseDecklist('3 Kuriboh\n2x Raigeki\nHinotama x3\nPot of Greed\nDark Magician (SDY-006)\n46986414')

    expect(parsed.sections.main).toEqual([
      { name: 'Kuriboh', quantity: 3, raw: '3 Kuriboh' },
      { name: 'Raigeki', quantity: 2, raw: '2x Raigeki' },
      { name: 'Hinotama', quantity: 3, raw: 'Hinotama x3' },
      { name: 'Pot of Greed', quantity: 1, raw: 'Pot of Greed' },
      { name: 'Dark Magician', setCode: 'SDY-006', quantity: 1, raw: 'Dark Magician (SDY-006)' },
      { passcode: 46986414, quantity: 1, raw: '46986414' },
    ])
  })

  it('puts everything but the Side Deck in main when there is no Extra header', () => {
    const parsed = parseDecklist('3 Kuriboh\n1 Stardust Dragon\nSide\n1 Hinotama')

    expect(names(parsed.sections)).toEqual({ main: ['3 Kuriboh', '1 Stardust Dragon'], extra: [], side: ['1 Hinotama'] })
  })

  it('merges lines for the same card within a section, but keeps a possible name with a number apart', () => {
    const parsed = parseDecklist('Kuriboh\nkuriboh x2\n2x Raigeki\nRaigeki')
    expect(parsed.sections.main).toEqual([
      { name: 'Kuriboh', quantity: 3, raw: 'Kuriboh' },
      { name: 'Raigeki', quantity: 3, raw: '2x Raigeki' },
    ])

    // "7 Colored Fish" is a card; merging the two lines by name would turn 14 copies into one card.
    const fish = parseDecklist('7 Colored Fish\n7 Colored Fish')
    expect(fish.sections.main).toHaveLength(2)
  })

  it('caps merged copies at 99', () => {
    expect(mergeDecklistEntries([
      { passcode: 1, quantity: 60, raw: '1' },
      { passcode: 1, quantity: 60, raw: '1' },
    ])).toEqual([{ passcode: 1, quantity: 99, raw: '1' }])
  })

  it('returns nothing for blank input', () => {
    const parsed = parseDecklist('  \n\n')

    expect(parsed.format).toBe('text')
    expect(parsed.sections).toEqual({ main: [], extra: [], side: [] })
  })
})

describe('countEntryLines', () => {
  it('counts distinct card lines, not headers, comments or repeats', () => {
    expect(countEntryLines('#created by x\n#main\n1\n1\n1\n2\n#extra\n3\n!side\n4\n')).toBe(4)
    expect(countEntryLines(OMEGA_RECIPE)).toBe(6)
    expect(countEntryLines(YDKE_SAMPLE)).toBe(1)
    expect(countEntryLines('')).toBe(0)
  })
})

describe('encoders', () => {
  const passcodes = { main: [46986414, 46986414, 55144522, 5318639], extra: [44508094], side: [83764719, 83764719] }

  it('round-trips a ydke link', () => {
    const link = encodeYdke(passcodes)

    expect(link).toMatch(/^ydke:\/\/[^!]*![^!]*![^!]*!$/)
    expect(decodeYdke(link)).toEqual(passcodes)
    expect(encodeYdke(decodeYdke(YDKE_SAMPLE)!)).toBe(YDKE_SAMPLE)
  })

  it('writes a YDK file that reads back, with one passcode per copy', () => {
    const ydk = encodeYdk(passcodes)

    expect(ydk).toBe('#created by ygo-alpha\n#main\n46986414\n46986414\n55144522\n5318639\n#extra\n44508094\n!side\n83764719\n83764719\n')
    const parsed = parseDecklist(ydk)
    expect(parsed.format).toBe('ydk')
    expect(parsed.sections.main.map(entry => [entry.passcode, entry.quantity])).toEqual([[46986414, 2], [55144522, 1], [5318639, 1]])
    expect(parsed.sections.extra.map(entry => entry.passcode)).toEqual([44508094])
    expect(parsed.sections.side.map(entry => [entry.passcode, entry.quantity])).toEqual([[83764719, 2]])
  })

  it('writes the bytes of an Omega code: counts, then passcodes', () => {
    const payload = omegaPayload([1, 2, 3], [4])

    expect(Array.from(payload.slice(0, 2))).toEqual([3, 1])
    expect(payload).toHaveLength(2 + 4 * 4)
    expect(readOmegaPayload(payload.slice(0, payload.length - 1))).toBeNull()
    expect(readOmegaPayload(payload)).toEqual({ mainAndExtra: [1, 2, 3], side: [4], cover: null })
    // The cover card follows the counted passcodes; anything after it is ignored.
    const withCover = omegaPayload([1, 2, 3], [4], 2)
    expect(withCover).toHaveLength(2 + 4 * 5)
    expect(readOmegaPayload(withCover)).toEqual({ mainAndExtra: [1, 2, 3], side: [4], cover: 2 })
    expect(readOmegaPayload(new Uint8Array([...withCover, ...uint32sToBytes([99])]))).toEqual({ mainAndExtra: [1, 2, 3], side: [4], cover: 2 })
    expect(() => omegaPayload(Array.from({ length: 256 }, () => 1), [])).toThrow(RangeError)
  })

  it('writes an Omega code that the parser reads back, Main and Extra mixed', async () => {
    const code = await encodeOmegaCode(passcodes)
    const parsed = parseDecklist(code)

    expect(parsed.format).toBe('omega')
    expect(parsed.sections.main.map(entry => [entry.passcode, entry.quantity])).toEqual([
      [46986414, 2],
      [55144522, 1],
      [5318639, 1],
      [44508094, 1],
    ])
    expect(parsed.sections.side.map(entry => [entry.passcode, entry.quantity])).toEqual([[83764719, 2]])
  })

  it("re-encodes Omega's own code to the same cards", async () => {
    const parsed = parseDecklist(OMEGA_CODE)
    const again = parseDecklist(await encodeOmegaCode({
      main: parsed.sections.main.flatMap(entry => Array.from({ length: entry.quantity }, () => entry.passcode!)),
      extra: [],
      side: parsed.sections.side.flatMap(entry => Array.from({ length: entry.quantity }, () => entry.passcode!)),
    }))

    expect(again.sections).toEqual(parsed.sections)
  })

  it('re-encodes a current Omega export with its cover card', async () => {
    const parsed = parseDecklist(OMEGA_CODE_WITH_COVER)
    const again = parseDecklist(await encodeOmegaCode({
      main: parsed.sections.main.flatMap(entry => Array.from({ length: entry.quantity }, () => entry.passcode!)),
      extra: [],
      side: parsed.sections.side.flatMap(entry => Array.from({ length: entry.quantity }, () => entry.passcode!)),
    }, parsed.cover))

    expect(again).toEqual(parsed)
  })

  it("writes Omega's recipe in the deck's order and reads it back", () => {
    const recipe = encodeRecipe([
      { name: 'Raigeki', type: 'Spell Card', section: 'main', quantity: 1 },
      { name: 'Mirror Force', type: 'Trap Card', section: 'main', quantity: 2 },
      { name: 'Kuriboh', type: 'Effect Monster', section: 'main', quantity: 3 },
      { name: 'Dark Magician', type: 'Normal Monster', section: 'main', quantity: 1 },
      { name: 'Stardust Dragon', type: 'Synchro Monster', section: 'extra', quantity: 1 },
      { name: 'Hinotama', type: 'Spell Card', section: 'side', quantity: 2 },
    ])

    expect(recipe).toBe([
      'Monster', '1 Dark Magician', '3 Kuriboh',
      'Spell', '1 Raigeki',
      'Trap', '2 Mirror Force',
      'Extra', '1 Stardust Dragon',
      'Side', '2 Hinotama',
    ].join('\n'))
    expect(names(parseDecklist(recipe).sections)).toEqual({
      main: ['1 Dark Magician', '3 Kuriboh', '1 Raigeki', '2 Mirror Force'],
      extra: ['1 Stardust Dragon'],
      side: ['2 Hinotama'],
    })
  })

  it('leaves empty groups out of the recipe', () => {
    expect(encodeRecipe([{ name: 'Raigeki', type: 'Spell Card', section: 'main', quantity: 1 }])).toBe('Spell\n1 Raigeki')
    expect(encodeRecipe([])).toBe('')
  })

  it('takes the passcodes of a deck, and counts copies without one', () => {
    const sections = {
      main: [
        { catalogCardId: 46986414, name: 'Dark Magician', type: 'Normal Monster', quantity: 2 },
        { catalogCardId: 0, name: 'Placeholder', type: 'Effect Monster', quantity: 3 },
      ],
      extra: [{ catalogCardId: 44508094, name: 'Stardust Dragon', type: 'Synchro Monster', quantity: 1 }],
      side: [],
    }

    expect(deckPasscodes(sections)).toEqual({
      passcodes: { main: [46986414, 46986414], extra: [44508094], side: [] },
      skipped: 3,
    })
    expect(deckRecipeRows(sections)).toHaveLength(3)
  })

  it('names the YDK file after the deck', () => {
    expect(ydkFileName('Meine Drachen')).toBe('meine-drachen.ydk')
    expect(ydkFileName('  Blue-Eyes: Ära #1!  ')).toBe('blue-eyes-ära-1.ydk')
    expect(ydkFileName('!!!')).toBe('deck.ydk')
    expect(ydkFileName('x'.repeat(200)).length).toBeLessThanOrEqual(64)
  })
})
