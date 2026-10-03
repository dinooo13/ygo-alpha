import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import JustSavedPanel from '~/components/entry/JustSavedPanel.vue'
import InventoryListRow from '~/components/inventory/InventoryListRow.vue'
import MoveCopiesModal from '~/components/inventory/MoveCopiesModal.vue'
import type { MoveEntry } from '~/components/inventory/MoveCopiesModal.vue'
import CollectionsTargetSelect from '~/components/collections/TargetSelect.vue'
import type { SavedCopy } from '~/utils/saved-copies'
import { setTestLocale } from './fixtures/locale'
import { selectWithOption } from './fixtures/select-wrapper'

const toastAdd = vi.hoisted(() => vi.fn())
mockNuxtImport('useToast', () => () => ({ add: toastAdd }))

const collections = [
  { id: 'box-1', name: 'Box 1', description: null, cardCount: 4, visibility: 'private' as const },
  { id: 'box-2', name: 'Deck-Box', description: null, cardCount: 0, visibility: 'private' as const },
]

type Call = [string, { method?: string, body?: { items: Array<Record<string, unknown>> } }]

function moveCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return (fetchMock.mock.calls as unknown as Call[]).filter(call => call[0] === '/api/inventory/move')
}

afterEach(async () => {
  vi.unstubAllGlobals()
  toastAdd.mockClear()
  document.body.innerHTML = ''
  await setTestLocale('de')
})

enableAutoUnmount(afterEach)

function movedAnswer(items: Array<{ ownedCardId: string, resultId: string, quantity: number }>) {
  return {
    moved: items.reduce((sum, item) => sum + item.quantity, 0),
    items: items.map(item => ({ catalogCardId: 1, fromCollectionId: null, toCollectionId: 'box-2', remaining: 0, ...item })),
  }
}

describe('MoveCopiesModal', () => {
  const single: MoveEntry[] = [{ ownedCardId: 'stack-1', name: 'Dark Magician', quantity: 3, collectionId: 'box-1' }]

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('moves some copies of one stack: the stepper defaults to all and the target leaves out the current collection', async () => {
    const fetchMock = vi.fn(async () => movedAnswer([{ ownedCardId: 'stack-1', resultId: 'stack-2', quantity: 2 }]))
    vi.stubGlobal('$fetch', fetchMock)

    const component = await mountSuspended(MoveCopiesModal, { props: { open: true, entries: single, collections } })

    expect(document.body.textContent).toContain('Dark Magician')
    expect(document.body.textContent).toContain('3 Kopien in Box 1')
    const quantity = document.querySelector<HTMLInputElement>('input[name="quantity"]')!
    expect(quantity.value).toBe('3')

    const select = selectWithOption(component.findAllComponents({ name: 'USelect' }), 'box-2')!
    const values = (select.props('items') as Array<{ value: string }>).map(item => item.value)
    expect(values).toEqual(['__none__', 'box-2', '__new__'])

    // "Verschieben" waits for a target.
    const submit = () => [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Verschieben')!
    expect(submit().disabled).toBe(true)

    await select.setValue('box-2')
    ;(document.querySelector('button[aria-label="Eine Kopie weniger verschieben"]') as HTMLButtonElement).click()
    await nextTick()
    expect(quantity.value).toBe('2')
    expect(submit().disabled).toBe(false)

    submit().click()
    await flushPromises()
    // The shared collection counts are refreshed before the dialog reports back.
    await vi.waitFor(() => expect(component.emitted('moved')).toHaveLength(1))

    expect(moveCalls(fetchMock).map(call => call[1].body)).toEqual([
      { items: [{ ownedCardId: 'stack-1', quantity: 2, toCollectionId: 'box-2' }] },
    ])
    expect(component.emitted('moved')).toHaveLength(1)
    expect(component.emitted('update:open')?.at(-1)).toEqual([false])
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '2 Kopien nach „Deck-Box“ verschoben', color: 'success' }))
  })

  it('moves "ohne Sammlung" as a null target', async () => {
    const fetchMock = vi.fn(async () => movedAnswer([{ ownedCardId: 'stack-1', resultId: 'stack-1', quantity: 3 }]))
    vi.stubGlobal('$fetch', fetchMock)

    const component = await mountSuspended(MoveCopiesModal, { props: { open: true, entries: single, collections } })
    await selectWithOption(component.findAllComponents({ name: 'USelect' }), '__none__')!.setValue('__none__')
    ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Verschieben')!.click()
    await flushPromises()

    expect(moveCalls(fetchMock)[0]![1].body).toEqual({ items: [{ ownedCardId: 'stack-1', quantity: 3, toCollectionId: null }] })
  })

  it('does not offer "ohne Sammlung" for a stack that already is in none', async () => {
    const entries: MoveEntry[] = [{ ownedCardId: 'stack-1', name: 'Dark Magician', quantity: 1, collectionId: null }]
    const component = await mountSuspended(MoveCopiesModal, { props: { open: true, entries, collections } })

    const values = (selectWithOption(component.findAllComponents({ name: 'USelect' }), 'box-1')!.props('items') as Array<{ value: string }>).map(item => item.value)
    expect(values).toEqual(['box-1', 'box-2', '__new__'])
  })

  it('moves a selection as whole stacks and leaves the ones already in the target', async () => {
    const fetchMock = vi.fn(async () => movedAnswer([{ ownedCardId: 'a', resultId: 'a', quantity: 2 }]))
    vi.stubGlobal('$fetch', fetchMock)
    const entries: MoveEntry[] = [
      { ownedCardId: 'a', name: 'Dark Magician', quantity: 2, collectionId: null },
      { ownedCardId: 'b', name: 'Pot of Greed', quantity: 1, collectionId: 'box-2' },
    ]

    const component = await mountSuspended(MoveCopiesModal, { props: { open: true, entries, collections } })

    expect(document.body.textContent).toContain('2 Einträge, 3 Kopien')
    expect(document.querySelector('input[name="quantity"]')).toBeNull()

    await selectWithOption(component.findAllComponents({ name: 'USelect' }), 'box-2')!.setValue('box-2')
    expect(document.body.textContent).toContain('1 Eintrag ist schon dort und bleibt.')
    ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Verschieben')!.click()
    await flushPromises()

    // No quantity: whole stacks. Pot of Greed is in Deck-Box already and is not sent.
    expect(moveCalls(fetchMock)[0]![1].body).toEqual({ items: [{ ownedCardId: 'a', toCollectionId: 'box-2' }] })
  })

  it('shows why a move failed and stays open', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => {
      throw {
        data: {
          statusCode: 400,
          data: { code: 'items_invalid', errors: [{ index: 0, message: 'quantity must be at most 2', code: 'move_quantity_exceeds', params: { max: 2 } }] },
        },
      }
    }))

    const component = await mountSuspended(MoveCopiesModal, { props: { open: true, entries: single, collections } })
    await selectWithOption(component.findAllComponents({ name: 'USelect' }), 'box-2')!.setValue('box-2')
    ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Verschieben')!.click()
    await flushPromises()

    expect(document.querySelector('[role="alert"]')?.textContent).toBe('So viele Kopien gibt es nicht mehr (höchstens 2).')
    expect(component.emitted('moved')).toBeUndefined()
    expect(component.emitted('update:open')).toBeUndefined()
  })

  it('renders in English', async () => {
    await setTestLocale('en')
    await mountSuspended(MoveCopiesModal, { props: { open: true, entries: single, collections } })

    expect(document.body.textContent).toContain('Move cards')
    expect(document.body.textContent).toContain('3 copies in Box 1')
    expect(document.body.textContent).toContain('Target collection')
    expect(document.body.textContent).not.toMatch(/Sammlung|verschieben|Kopien/)
  })
})

describe('CollectionsTargetSelect', () => {
  it('offers "Neue Sammlung…" last and opens the create form instead of selecting it', async () => {
    const component = await mountSuspended(CollectionsTargetSelect, { props: { collections, modelValue: '', label: 'Ziel' } })

    const select = selectWithOption(component.findAllComponents({ name: 'USelect' }), '__new__')!
    expect((select.props('items') as Array<{ label: string }>).at(-1)!.label).toBe('Neue Sammlung…')

    await select.setValue('__new__')
    await nextTick()

    // The model is untouched; the create dialog is open.
    expect(component.emitted('update:modelValue')).toBeUndefined()
    expect(document.body.textContent).toContain('Erstellen')
    expect(document.querySelector('input[name="name"]')).toBeTruthy()
  })

  it('selects the collection the form created', async () => {
    document.body.innerHTML = ''
    vi.stubGlobal('$fetch', vi.fn(async () => ({ id: 'new-box', name: 'Neu' })))
    const component = await mountSuspended(CollectionsTargetSelect, { props: { collections, modelValue: '', label: 'Ziel' } })

    await selectWithOption(component.findAllComponents({ name: 'USelect' }), '__new__')!.setValue('__new__')
    await nextTick()
    const input = document.querySelector<HTMLInputElement>('input[name="name"]')!
    input.value = 'Neu'
    input.dispatchEvent(new Event('input'))
    document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))

    await vi.waitFor(() => expect(component.emitted('update:modelValue')?.at(-1)).toEqual(['new-box']))
  })

  it('can leave out "ohne Sammlung", "Neue Sammlung" and given collections', async () => {
    const component = await mountSuspended(CollectionsTargetSelect, {
      props: { collections, modelValue: '', label: 'Ziel', allowNone: false, allowNew: false, excludeIds: ['box-1'] },
    })

    const values = (component.findComponent({ name: 'USelect' }).props('items') as Array<{ value: string }>).map(item => item.value)
    expect(values).toEqual(['box-2'])
  })
})

describe('JustSavedPanel', () => {
  const saved: SavedCopy[] = [
    { ownedCardId: 's1', catalogCardId: 46986414, name: 'Dark Magician', nameDe: null, quantity: 2, collectionId: 'box-1' },
    { ownedCardId: 's2', catalogCardId: 55144522, name: 'Pot of Greed', nameDe: null, quantity: 1, collectionId: 'box-1' },
  ]

  it('lists what was saved with its collection', async () => {
    const component = await mountSuspended(JustSavedPanel, { props: { copies: saved, collections } })
    const text = component.text()

    expect(text).toContain('Gerade gespeichert')
    expect(text).toContain('3 Kopien sind jetzt im Inventar')
    expect(text).toContain('Dark Magician')
    expect(text).toContain('×2')
    expect(text).toContain('Box 1')
    expect(component.findAll('button').find(button => button.text().includes('In andere Sammlung verschieben'))!.attributes('disabled')).toBeDefined()
  })

  it('moves exactly the saved copies and then shows them in the target', async () => {
    const fetchMock = vi.fn(async () => movedAnswer([
      { ownedCardId: 's1', resultId: 't1', quantity: 2 },
      { ownedCardId: 's2', resultId: 't2', quantity: 1 },
    ]))
    vi.stubGlobal('$fetch', fetchMock)

    const component = await mountSuspended(JustSavedPanel, { props: { copies: saved, collections } })
    await selectWithOption(component.findAllComponents({ name: 'USelect' }), 'box-2')!.setValue('box-2')
    await component.findAll('button').find(button => button.text().includes('In andere Sammlung verschieben'))!.trigger('click')
    await vi.waitFor(() => expect(component.emitted('update:copies')).toBeDefined())

    // The saved quantity (not the stack's total) of each stack, nothing else.
    expect(moveCalls(fetchMock)[0]![1].body).toEqual({
      items: [
        { ownedCardId: 's1', quantity: 2, toCollectionId: 'box-2' },
        { ownedCardId: 's2', quantity: 1, toCollectionId: 'box-2' },
      ],
    })
    const update = component.emitted('update:copies')!.at(-1)![0] as SavedCopy[]
    expect(update.map(entry => [entry.ownedCardId, entry.collectionId, entry.quantity])).toEqual([['t1', 'box-2', 2], ['t2', 'box-2', 1]])
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '3 Kopien nach „Deck-Box“ verschoben' }))

    await component.setProps({ copies: update })
    expect(component.text()).toContain('Deck-Box')
    expect(component.text()).not.toContain('Box 1')
  })

  it('leaves out the copies that are unticked', async () => {
    const fetchMock = vi.fn(async () => movedAnswer([{ ownedCardId: 's1', resultId: 't1', quantity: 2 }]))
    vi.stubGlobal('$fetch', fetchMock)

    const component = await mountSuspended(JustSavedPanel, { props: { copies: saved, collections } })
    await component.find('[aria-label="Pot of Greed auswählen"]').trigger('click')
    await selectWithOption(component.findAllComponents({ name: 'USelect' }), 'box-2')!.setValue('box-2')
    await component.findAll('button').find(button => button.text().includes('In andere Sammlung verschieben'))!.trigger('click')
    await flushPromises()

    expect(moveCalls(fetchMock)[0]![1].body).toEqual({ items: [{ ownedCardId: 's1', quantity: 2, toCollectionId: 'box-2' }] })
  })

  it('can be dismissed', async () => {
    const component = await mountSuspended(JustSavedPanel, { props: { copies: saved, collections } })

    await component.findAll('button').find(button => button.text().includes('Schließen'))!.trigger('click')

    expect(component.emitted('update:copies')?.at(-1)).toEqual([[]])
  })

  it('keeps the panel and says why when the move fails', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => {
      throw { data: { statusCode: 400, data: { code: 'collection_not_found' } } }
    }))

    const component = await mountSuspended(JustSavedPanel, { props: { copies: saved, collections } })
    await selectWithOption(component.findAllComponents({ name: 'USelect' }), 'box-2')!.setValue('box-2')
    await component.findAll('button').find(button => button.text().includes('In andere Sammlung verschieben'))!.trigger('click')
    await flushPromises()

    expect(component.find('[role="alert"]').text()).toBe('Diese Sammlung gibt es nicht mehr.')
    expect(component.emitted('update:copies')).toBeUndefined()
  })

  it('renders in English', async () => {
    await setTestLocale('en')
    const component = await mountSuspended(JustSavedPanel, { props: { copies: saved, collections } })

    expect(component.text()).toContain('Just saved')
    expect(component.text()).toContain('3 copies are in your inventory now')
    expect(component.text()).toContain('Move to another collection')
    expect(component.text()).not.toMatch(/Sammlung|gespeichert|Kopien/)
  })
})

describe('InventoryListRow: Verschieben and selection', () => {
  const item = { id: 'row-1', collectionId: 'box-1', quantity: 2, cardName: 'Dark Magician', cardType: 'Normal Monster', imageUrlSmall: null }

  it('has a move button that does not open the card', async () => {
    const component = await mountSuspended(InventoryListRow, { props: { item, collectionLabel: 'Box 1', showCollection: true } })

    await component.find('button[aria-label="Dark Magician verschieben"]').trigger('click')

    expect(component.emitted('move')).toHaveLength(1)
    expect(component.emitted('open')).toBeUndefined()
  })

  it('shows a checkbox only while selecting', async () => {
    const component = await mountSuspended(InventoryListRow, { props: { item, collectionLabel: 'Box 1', showCollection: true } })
    expect(component.find('[aria-label="Dark Magician auswählen"]').exists()).toBe(false)

    await component.setProps({ selectable: true, selected: false })
    const box = component.find('[aria-label="Dark Magician auswählen"]')
    expect(box.exists()).toBe(true)

    await box.trigger('click')
    expect(component.emitted('toggle')).toHaveLength(1)
    expect(component.emitted('open')).toBeUndefined()
  })
})
