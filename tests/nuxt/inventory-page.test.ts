import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, enableAutoUnmount } from '@vue/test-utils'
import { nextTick, type Component } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import CollectionActions from '~/components/collections/CollectionActions.vue'
import AddToInventoryModal from '~/components/inventory/AddToInventoryModal.vue'
import InventoryCardTile from '~/components/inventory/InventoryCardTile.vue'
import InventoryListRow from '~/components/inventory/InventoryListRow.vue'
import { UApp } from '#components'
import InventoryPage from '~/pages/inventory/index.vue'
import { setTestLocale } from './fixtures/locale'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  return setTestLocale('de')
})

// mountSuspended never unmounts; a later locale switch would re-render every earlier mount (#104).
enableAutoUnmount(afterEach)

// UModal teleports its content to <body>.
function body() {
  return new DOMWrapper(document.body)
}

const inventoryState = vi.hoisted(() => ({
  response: {
    items: [] as Array<Record<string, unknown>>,
    total: 0,
  },
  pending: false,
}))

mockNuxtImport('useFetch', () => {
  return () => ({
    data: ref(inventoryState.response),
    pending: ref(inventoryState.pending),
    refresh: vi.fn(),
  })
})

describe('inventory page', () => {
  it('renders the empty inventory state', async () => {
    inventoryState.response = { items: [], total: 0 }
    inventoryState.pending = false

    const component = await mountSuspended(InventoryPage)

    expect(component.text()).toContain('Keine Karten im Inventar')
    expect(component.text()).toContain('Karte hinzufügen')
  })

  it('renders owned cards from the inventory API as info rows (#135)', async () => {
    inventoryState.pending = false
    inventoryState.response = ownedDarkMagician()

    const component = await mountSuspended(InventoryPage)

    // The card name is the row's one button; it opens the detail panel.
    const nameButton = component.findAll('li button').filter(button => button.text() === 'Dark Magician')
    expect(nameButton).toHaveLength(1)
    expect(nameButton[0]!.attributes('aria-haspopup')).toBe('dialog')

    const text = component.text()
    expect(text).toContain('Normales Monster')
    // Attribute and card text in the card language (ADR 0015).
    expect(text).toContain('FINSTERNIS')
    expect(component.find('[data-testid="card-text-excerpt"]').text()).toBe('Kartentext: Der ultimative Hexer in Bezug auf Angriff und Verteidigung.')
    expect(text).toContain('×3')
    expect(text).toContain('(keine Sammlung)')
    expect(text).toContain('Binder 2')

    // Reading only: no collection select, no edit or delete buttons.
    expect(component.find('li [role="combobox"]').exists()).toBe(false)
    expect(component.find('[aria-label="Karte bearbeiten"]').exists()).toBe(false)
    expect(component.find('[aria-label="Karte entfernen"]').exists()).toBe(false)
    // No collector details since ADR 0017.
    expect(component.text()).not.toMatch(/Drucksprache|Zustand|Auflage|Legend of Blue Eyes|Ultra Rare/)

    // The thumbnail keeps the whole card visible instead of cropping it.
    const thumbnail = component.find('img[alt="Dark Magician"]')
    expect(thumbnail.exists()).toBe(true)
    expect(thumbnail.classes()).toContain('object-contain')
    expect(thumbnail.classes()).not.toContain('object-cover')
  })

  it('shows the collection name, and hides it when the page is scoped to one', async () => {
    inventoryState.pending = false
    inventoryState.response = ownedDarkMagician({ collectionId: 'box-1' })

    const component = await mountSuspended(InventoryPage)
    // The collections come from the same mocked `useFetch` here: an unknown
    // id falls back to the "unnamed" label.
    expect(component.text()).toContain('Sammlung: Unbenannte Sammlung')

    const item = ownedDarkMagician().items[0] as never
    const scoped = await mountSuspended(InventoryListRow, { props: { item, collectionLabel: 'Box 1', showCollection: false } })
    expect(scoped.text()).not.toContain('Box 1')
    const shown = await mountSuspended(InventoryListRow, { props: { item, collectionLabel: 'Box 1', showCollection: true } })
    expect(shown.text()).toContain('Sammlung: Box 1')
  })

  function twoOwnedCards() {
    return {
      total: 2,
      items: [
        ownedDarkMagician().items[0]!,
        ownedDarkMagician({ id: 'owned-2', cardName: 'Pot of Greed', cardNameDe: null, quantity: 1 }).items[0]!,
      ],
    }
  }

  it('moves some or all copies of a row to another collection', async () => {
    inventoryState.pending = false
    inventoryState.response = twoOwnedCards()

    const component = await mountSuspended(InventoryPage)

    // A row's own button opens the dialog for just that stack.
    await component.find('button[aria-label="Dark Magician verschieben"]').trigger('click')
    await nextTick()
    expect(body().text()).toContain('Karten verschieben')
    expect(body().text()).toContain('3 Kopien in (keine Sammlung)')
    expect(body().find('input[name="quantity"]').exists()).toBe(true)
  })

  it('selects rows and moves the selection as whole stacks', async () => {
    inventoryState.pending = false
    inventoryState.response = twoOwnedCards()

    const component = await mountSuspended(InventoryPage)

    // "Auswählen" turns the rows into a selection.
    expect(component.find('[aria-label="Dark Magician auswählen"]').exists()).toBe(false)
    await component.findAll('button').find(button => button.text() === 'Auswählen')!.trigger('click')
    const moveSelection = () => component.findAll('button').find(button => button.text().includes('In Sammlung verschieben'))!
    expect(component.text()).toContain('0 Einträge ausgewählt')
    expect(moveSelection().attributes('disabled')).toBeDefined()

    await component.find('[aria-label="Dark Magician auswählen"]').trigger('click')
    await component.find('[aria-label="Pot of Greed auswählen"]').trigger('click')
    expect(component.text()).toContain('2 Einträge ausgewählt')

    await moveSelection().trigger('click')
    await nextTick()
    expect(body().text()).toContain('2 Einträge, 4 Kopien')
    expect(body().find('input[name="quantity"]').exists()).toBe(false)
  })

  it('falls back to the English card text and cuts a long one with "…"', async () => {
    inventoryState.pending = false
    const long = 'A'.repeat(240)
    inventoryState.response = {
      total: 2,
      items: [
        ownedDarkMagician({ cardTextExcerptDe: null }).items[0]!,
        ownedDarkMagician({ id: 'owned-2', cardTextExcerpt: long, cardTextExcerptDe: null }).items[0]!,
      ],
    }

    const component = await mountSuspended(InventoryPage)

    const excerpts = component.findAll('[data-testid="card-text-excerpt"]').map(p => p.text())
    expect(excerpts[0]).toBe('Kartentext: The ultimate wizard in terms of attack and defense.')
    expect(excerpts[1]).toBe(`Kartentext: ${long}…`)
  })

  it('renders in English', async () => {
    await setTestLocale('en')
    inventoryState.pending = false
    inventoryState.response = ownedDarkMagician()

    const component = await mountSuspended(InventoryPage)

    const text = component.text()
    expect(component.find('h1').text()).toBe('All cards')
    expect(text).toContain('0 cards')
    expect(text).toContain('Quick entry')
    expect(text).toContain('Add card')
    expect(text).toContain('List')
    expect(text).toContain('Gallery')
    expect(text).not.toContain('Overview')
    expect(text).toContain('Also search card text')
    expect(text).toContain('New collection')
    expect(component.find('input[aria-label="Search inventory"]').exists()).toBe(true)
    expect(text).toContain('Note: Binder 2')
    expect(text).toContain('Quantity: ×3')
    expect(text).toContain('Collection: (no collection)')
    expect(text).toContain('DARK')
    expect(text).toContain('Card text: The ultimate wizard')
    expect(text).not.toMatch(/Printing language|Condition|Near Mint/)
    expect(text).not.toMatch(/Karte|Sammlung|Übersicht|Galerie|Liste|FINSTERNIS|Hexer/)
  })

  it('shows the note of a row', async () => {
    inventoryState.pending = false
    inventoryState.response = ownedDarkMagician()

    const component = await mountSuspended(InventoryPage)

    const note = component.find('li p[title="Binder 2"]')
    expect(note.exists()).toBe(true)
    // The sr-only prefix names the field for screen readers.
    expect(note.text()).toBe('Notiz: Binder 2')
  })

  it('formats large quantities for the locale (#62)', async () => {
    inventoryState.pending = false
    inventoryState.response = ownedDarkMagician({ quantity: 1234 })

    const component = await mountSuspended(InventoryPage)

    expect(component.text()).toContain('×1.234')
  })

  it('renders skeleton rows while the list is loading', async () => {
    inventoryState.response = { items: [], total: 0 }
    inventoryState.pending = true

    const component = await mountSuspended(InventoryPage)

    expect(component.text()).not.toContain('Inventar wird geladen...')
    expect(component.find('ul[aria-busy="true"]').exists()).toBe(true)
    expect(component.findAll('ul[aria-busy="true"] li')).toHaveLength(5)

    inventoryState.pending = false
  })
})

function ownedDarkMagician(overrides: Record<string, unknown> = {}) {
  return {
    total: 1,
    items: [
      {
        id: 'owned-1',
        catalogCardId: 46986414,
        collectionId: null,
        quantity: 3,
        note: 'Binder 2',
        cardName: 'Dark Magician',
        cardType: 'Normal Monster',
        cardAttribute: 'DARK',
        cardTextExcerpt: 'The ultimate wizard in terms of attack and defense.',
        cardTextExcerptDe: 'Der ultimative Hexer in Bezug auf Angriff und Verteidigung.',
        imageUrlSmall: 'https://images.example/dm-small.jpg',
        ...overrides,
      },
    ] as Array<Record<string, unknown>>,
  }
}

describe('add to inventory modal', () => {
  it('opens repeatedly without logging select errors', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const component = await mountSuspended(AddToInventoryModal, {
      props: {
        open: false,
        card: {
          id: 46986414,
          name: 'Dark Magician',
          type: 'Normal Monster',
        },
      },
    })

    await component.setProps({ open: true })
    await nextTick()
    await component.setProps({ open: false })
    await nextTick()
    await component.setProps({ open: true })
    await nextTick()

    expect(consoleError).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('formats the collection counts for the locale (#62)', async () => {
    const component = await mountSuspended(CollectionActions, {
      props: { modelValue: '', collections: [], allCount: 1234, unassignedCount: 0 },
    })

    expect(component.text()).toContain('Alle Sammlungen (1.234)')
  })

  it('only adds: its own title, and a quantity stepper (#135)', async () => {
    const component = await mountSuspended(AddToInventoryModal, {
      props: {
        open: true,
        card: { id: 46986414, name: 'Dark Magician', type: 'Normal Monster' },
      },
    })
    await nextTick()

    const dialog = body().find('[role="dialog"]')
    expect(dialog.find('h2').text()).toBe('Karte hinzufügen')
    expect(dialog.find('[aria-label="Eine weniger"]').attributes('disabled')).toBeDefined()
    expect(dialog.find('[aria-label="Eine mehr"]').exists()).toBe(true)
    expect(dialog.find<HTMLInputElement>('input[name="quantity"]').element.value).toBe('1')
    expect(dialog.findAll('button').map(button => button.text())).toContain('Hinzufügen')
    expect(dialog.text()).not.toContain('Karte bearbeiten')

    await dialog.find('[aria-label="Eine mehr"]').trigger('click')
    await nextTick()
    expect(dialog.find<HTMLInputElement>('input[name="quantity"]').element.value).toBe('2')

    component.unmount()
  })

  it('asks only for quantity, collection and note (ADR 0017)', async () => {
    const component = await mountSuspended(AddToInventoryModal, {
      props: {
        open: true,
        card: { id: 46986414, name: 'Dark Magician', type: 'Normal Monster' },
      },
    })
    await nextTick()

    const text = document.body.textContent ?? ''
    expect(text).toContain('Anzahl')
    expect(text).toContain('Sammlung')
    expect(text).toContain('Notiz')
    expect(text).not.toMatch(/Drucksprache|Zustand|Auflage|Set-Ausgabe/)

    component.unmount()
  })
})

describe('retired card badge (ADR 0019)', () => {
  // The badge's tooltip needs the provider UApp gives the real app.
  function inApp(component: Component, props: Record<string, unknown>) {
    return mountSuspended(defineComponent({
      setup: () => () => h(UApp, null, { default: () => h(component, props) }),
    }))
  }

  const listItem = ownedDarkMagician().items[0]!
  const listProps = { collectionLabel: '(keine Sammlung)', showCollection: true }
  const tileItem = {
    catalogCardId: 46986414,
    name: 'Dark Magician',
    type: 'Normal Monster',
    attribute: 'DARK',
    race: 'Spellcaster',
    level: 7,
    atk: 2500,
    def: 2100,
    imageSmall: null,
    totalQuantity: 2,
    collectionBreakdown: [],
  }

  it('shows on a list row only when the card is retired', async () => {
    const retired = await inApp(InventoryListRow, { ...listProps, item: { ...listItem, cardRetired: true } })
    expect(retired.find('[data-testid="card-retired-badge"]').text()).toBe('Nicht mehr im Katalog')

    const active = await inApp(InventoryListRow, { ...listProps, item: { ...listItem, cardRetired: false } })
    expect(active.find('[data-testid="card-retired-badge"]').exists()).toBe(false)
  })

  it('shows on a gallery tile only when the card is retired', async () => {
    const retired = await inApp(InventoryCardTile, { item: { ...tileItem, retired: true } })
    expect(retired.find('[data-testid="card-retired-badge"]').text()).toBe('Nicht mehr im Katalog')

    const active = await inApp(InventoryCardTile, { item: { ...tileItem, retired: false } })
    expect(active.find('[data-testid="card-retired-badge"]').exists()).toBe(false)
  })
})
