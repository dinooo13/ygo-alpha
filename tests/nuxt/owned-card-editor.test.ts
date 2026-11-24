import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, enableAutoUnmount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, type Component } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp, UDropdownMenu, USelect } from '#components'
import OwnedCardEditor from '~/components/inventory/OwnedCardEditor.vue'
import ConfirmDialog from '~/components/layout/ConfirmDialog.vue'
import { setTestLocale } from './fixtures/locale'

// The inventory's detail panel editor (#135): the card's rows, edited in
// place, every write saved at once and one after another.

interface Row {
  id: string
  collectionId: string | null
  quantity: number
  note: string | null
  printingId?: string | null
}

// The card's printings (`GET /api/catalog/cards/:id/printings`, ADR 0034).
const LOB = `${46986414}|LOB-005|UR`
const SDY = `${46986414}|SDY-006|UR`
const printings = [
  { id: LOB, setCode: 'LOB-005', setName: 'Legend of Blue Eyes White Dragon', rarity: 'Ultra Rare', rarityCode: 'UR' },
  { id: SDY, setCode: 'SDY-006', setName: 'Starter Deck: Yugi', rarity: 'Ultra Rare', rarityCode: 'UR' },
]
const printingFor = (id: string | null | undefined) => printings.find(printing => printing.id === id)

interface Call {
  url: string
  method: string
  body?: Record<string, unknown>
}

const CARD_ID = 46986414
const collections = [
  { id: 'col-1', name: 'Box 1' },
  { id: 'col-2', name: 'Binder' },
  { id: 'col-3', name: 'Deckbox' },
]

/**
 * A tiny in-memory `/api/inventory`. `hold` makes writes wait until
 * `release()`, to see the queue at work; `fail` rejects the next write.
 */
function fakeServer(initial: Row[]) {
  let rows = initial.map(row => ({ ...row }))
  const calls: Call[] = []
  const held: Array<() => void> = []
  const state = { hold: false, fail: null as unknown, mergeInto: null as string | null }

  const fetch = vi.fn(async (url: string, options: { method?: string, body?: Record<string, unknown>, query?: unknown } = {}) => {
    const method = options.method ?? 'GET'
    if (method === 'GET' && url.endsWith('/printings')) {
      return { items: printings }
    }
    if (method === 'GET') {
      return {
        items: rows.map(row => ({
          ...row,
          catalogCardId: CARD_ID,
          printingId: row.printingId ?? null,
          printingSetCode: printingFor(row.printingId)?.setCode ?? null,
          printingRarity: printingFor(row.printingId)?.rarity ?? null,
          printingRarityCode: printingFor(row.printingId)?.rarityCode ?? null,
        })),
        total: rows.length,
      }
    }
    calls.push({ url, method, body: options.body })
    if (state.hold) {
      await new Promise<void>(resolve => held.push(resolve))
    }
    if (state.fail) {
      const error = state.fail
      state.fail = null
      throw error
    }
    const id = url.split('/').at(-1)!
    if (method === 'POST') {
      const created: Row = { id: `new-${rows.length}`, collectionId: (options.body!.collection_id as string | null), quantity: 1, note: null }
      rows.push(created)
      return created
    }
    if (method === 'DELETE') {
      rows = rows.filter(row => row.id !== id)
      return null
    }
    const row = rows.find(r => r.id === id)!
    if (state.mergeInto) {
      const target = rows.find(r => r.id === state.mergeInto)!
      target.quantity += row.quantity
      rows = rows.filter(r => r.id !== id)
      state.mergeInto = null
      return target
    }
    Object.assign(row, options.body)
    return row
  })

  return {
    fetch,
    calls,
    state,
    release: () => held.splice(0).forEach(resolve => resolve()),
    rows: () => rows,
  }
}

function body() {
  return new DOMWrapper(document.body)
}

async function mountEditor(initial: Row[], props: Record<string, unknown> = {}) {
  const server = fakeServer(initial)
  vi.stubGlobal('$fetch', server.fetch)
  const afterWrite = vi.fn()
  const component: VueWrapper = await mountSuspended(defineComponent({
    setup: () => () => h(UApp, null, {
      default: () => [
        h(OwnedCardEditor, { catalogCardId: CARD_ID, cardLabel: 'Dunkler Magier', collections, afterWrite, ...props }),
        h(ConfirmDialog),
      ],
    }),
  }), { attachTo: document.body })
  await flushPromises()
  return { component, server, afterWrite }
}

// The generic Nuxt UI components need a plain `Component` for the lookup's types.
function collectionSelects(component: VueWrapper): VueWrapper[] {
  return component.findAllComponents(USelect as Component) as VueWrapper[]
}

function addMenu(component: VueWrapper): VueWrapper {
  return component.findComponent(UDropdownMenu as Component) as VueWrapper
}

function rowIds(component: VueWrapper) {
  return component.findAll('[data-row-id]').map(li => li.attributes('data-row-id'))
}

function button(label: string) {
  const found = body().find(`[aria-label="${label}"]`)
  expect(found.exists(), label).toBe(true)
  return found
}

function textButton(text: string) {
  const found = body().findAll('button').find(b => b.text() === text)
  expect(found, text).toBeTruthy()
  return found!
}

async function typeQuantity(label: string, value: string) {
  const input = body().find<HTMLInputElement>(`input[aria-label="${label}"]`)
  await input.setValue(value)
  await input.trigger('change')
}

const threeRows: Row[] = [
  { id: 'r-box', collectionId: 'col-1', quantity: 1, note: null },
  { id: 'r-binder', collectionId: 'col-2', quantity: 3, note: 'vorne' },
  { id: 'r-none', collectionId: null, quantity: 2, note: null },
]

afterEach(async () => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  await setTestLocale('de')
})
enableAutoUnmount(afterEach)

describe('InventoryOwnedCardEditor', () => {
  it('loads the card\'s rows and sorts them: no collection first, then by name', async () => {
    const { component, server } = await mountEditor(threeRows)

    expect(server.fetch).toHaveBeenCalledWith('/api/inventory', { query: { catalogCardId: CARD_ID, pageSize: 100 } })
    expect(rowIds(component)).toEqual(['r-none', 'r-binder', 'r-box'])
    expect(component.text()).toContain('Im Inventar')
    expect(component.text()).toContain('×6 ges.')
    expect(component.text()).toContain('Notiz: vorne')
    expect(component.find<HTMLInputElement>('input[aria-label="Anzahl in Binder"]').element.value).toBe('3')
    expect(component.find('[aria-label="Sammlung ändern (jetzt: (keine Sammlung))"]').exists()).toBe(true)
    expect(component.find('[data-focused]').exists()).toBe(false)
  })

  it('+ saves the new quantity at once, and a quick "+ +" sends 3, then 4, one after another', async () => {
    const { server, afterWrite } = await mountEditor([{ id: 'r-none', collectionId: null, quantity: 2, note: null }])
    server.state.hold = true

    await button('Eine Kopie mehr in (keine Sammlung)').trigger('click')
    await button('Eine Kopie mehr in (keine Sammlung)').trigger('click')
    await flushPromises()

    // Optimistic: the field shows 4 already; only the first write is out.
    expect(body().find<HTMLInputElement>('input[aria-label="Anzahl in (keine Sammlung)"]').element.value).toBe('4')
    expect(server.calls).toEqual([{ url: '/api/inventory/r-none', method: 'PATCH', body: { quantity: 3 } }])

    server.release()
    await flushPromises()
    expect(server.calls).toHaveLength(2)
    server.release()
    await flushPromises()

    expect(server.calls.map(call => call.body)).toEqual([{ quantity: 3 }, { quantity: 4 }])
    expect(server.rows()[0]!.quantity).toBe(4)
    expect(afterWrite).toHaveBeenCalledTimes(2)
    expect(body().text()).toContain('(keine Sammlung): 4 Kopien')
  })

  it('saves a typed quantity', async () => {
    const { server } = await mountEditor(threeRows)

    await typeQuantity('Anzahl in Box 1', '5')
    await flushPromises()

    expect(server.calls).toEqual([{ url: '/api/inventory/r-box', method: 'PATCH', body: { quantity: 5 } }])
  })

  it('asks before removing a row: typing 0 and Bestätigen deletes it', async () => {
    const { component, server, afterWrite } = await mountEditor(threeRows)

    await typeQuantity('Anzahl in Box 1', '0')
    await vi.waitFor(() => {
      expect(body().text()).toContain('Dunkler Magier aus Box 1 entfernen?')
    })
    await textButton('Bestätigen').trigger('click')
    await flushPromises()

    expect(server.calls).toEqual([{ url: '/api/inventory/r-box', method: 'DELETE', body: undefined }])
    expect(rowIds(component)).toEqual(['r-none', 'r-binder'])
    expect(afterWrite).toHaveBeenCalledTimes(1)
  })

  it('− at 1 asks too, and Abbrechen keeps the row without a request', async () => {
    const { component, server } = await mountEditor(threeRows)

    await button('Eine Kopie weniger in Box 1').trigger('click')
    await vi.waitFor(() => {
      expect(body().text()).toContain('Aus Sammlung entfernen')
    })
    await textButton('Abbrechen').trigger('click')
    await flushPromises()

    expect(server.calls).toEqual([])
    expect(rowIds(component)).toEqual(['r-none', 'r-binder', 'r-box'])
    expect(component.find<HTMLInputElement>('input[aria-label="Anzahl in Box 1"]').element.value).toBe('1')
  })

  it('the remove button asks and deletes', async () => {
    const { server } = await mountEditor(threeRows)

    await button('Aus Binder entfernen').trigger('click')
    await vi.waitFor(() => {
      expect(body().text()).toContain('Dunkler Magier aus Binder entfernen?')
    })
    await textButton('Bestätigen').trigger('click')
    await flushPromises()

    expect(server.calls).toEqual([{ url: '/api/inventory/r-binder', method: 'DELETE', body: undefined }])
  })

  it('moves a row to another collection, or to none', async () => {
    const { component, server } = await mountEditor(threeRows)
    const selects = collectionSelects(component)

    // Rows in display order: none, Binder, Box 1.
    selects[2]!.vm.$emit('update:modelValue', 'col-3')
    await flushPromises()
    selects[1]!.vm.$emit('update:modelValue', '__no_collection__')
    await flushPromises()

    expect(server.calls).toEqual([
      { url: '/api/inventory/r-box', method: 'PATCH', body: { collectionId: 'col-3' } },
      { url: '/api/inventory/r-binder', method: 'PATCH', body: { collectionId: null } },
    ])
  })

  it('reloads the rows and says so when a move merges into another row', async () => {
    const { component, server } = await mountEditor(threeRows)
    server.state.mergeInto = 'r-none'

    collectionSelects(component)[2]!.vm.$emit('update:modelValue', '__no_collection__')
    await flushPromises()

    expect(rowIds(component)).toEqual(['r-none', 'r-binder'])
    expect(component.find<HTMLInputElement>('input[aria-label="Anzahl in (keine Sammlung)"]').element.value).toBe('3')
    await vi.waitFor(() => {
      expect(body().text()).toContain('Mit den Kopien in (keine Sammlung) zusammengelegt.')
    })
  })

  it('offers only the collections the card isn\'t in yet, and adds one copy', async () => {
    const { component, server } = await mountEditor([{ id: 'r-box', collectionId: 'col-1', quantity: 1, note: null }])

    const items = (addMenu(component).props() as { items: unknown }).items as Array<{ label: string, onSelect: () => void }>
    expect(items.map(item => item.label)).toEqual(['(keine Sammlung)', 'Binder', 'Deckbox'])

    items[2]!.onSelect()
    await flushPromises()

    expect(server.calls).toEqual([{ url: '/api/inventory', method: 'POST', body: { catalog_card_id: CARD_ID, collection_id: 'col-3', quantity: 1 } }])
    expect(rowIds(component)).toEqual(['r-box', 'new-1'])
  })

  it('hides "Zu Sammlung hinzufügen" when the card is in every collection', async () => {
    const { component } = await mountEditor([
      { id: 'a', collectionId: null, quantity: 1, note: null },
      { id: 'b', collectionId: 'col-1', quantity: 1, note: null },
      { id: 'c', collectionId: 'col-2', quantity: 1, note: null },
      { id: 'd', collectionId: 'col-3', quantity: 1, note: null },
    ])

    expect(addMenu(component).exists()).toBe(false)
  })

  it('says so when nothing is left, and keeps the add menu', async () => {
    const { component } = await mountEditor([])

    expect(component.text()).toContain('Diese Karte ist nicht mehr in deinem Inventar.')
    expect(addMenu(component).exists()).toBe(true)
  })

  it('edits a note with an explicit save; an empty one is sent as null; Abbrechen sends nothing', async () => {
    const { component, server } = await mountEditor(threeRows)
    const binder = () => component.find('[data-row-id="r-binder"]')

    await binder().findAll('button').find(b => b.text() === 'Notiz bearbeiten')!.trigger('click')
    await binder().find('textarea[aria-label="Notiz für Binder"]').setValue('  hinten  ')
    await binder().find('form').trigger('submit')
    await flushPromises()
    expect(binder().text()).toContain('Notiz: hinten')

    await binder().findAll('button').find(b => b.text() === 'Notiz bearbeiten')!.trigger('click')
    await binder().find('textarea').setValue('   ')
    await binder().find('form').trigger('submit')
    await flushPromises()

    const box = () => component.find('[data-row-id="r-box"]')
    await box().findAll('button').find(b => b.text() === 'Notiz hinzufügen')!.trigger('click')
    await box().find('textarea').setValue('egal')
    await box().findAll('button').find(b => b.text() === 'Abbrechen')!.trigger('click')
    await flushPromises()

    expect(server.calls).toEqual([
      { url: '/api/inventory/r-binder', method: 'PATCH', body: { note: 'hinten' } },
      { url: '/api/inventory/r-binder', method: 'PATCH', body: { note: null } },
    ])
    expect(binder().text()).not.toContain('Notiz:')
    expect(box().find('textarea').exists()).toBe(false)
  })

  it('shows the translated error and reloads when a write fails', async () => {
    const { component, server } = await mountEditor(threeRows)
    server.state.fail = { data: { statusCode: 400, data: { code: 'quantity_too_large', params: { max: 999 } } } }
    const loads = () => server.fetch.mock.calls.filter(([url, options]) => !options?.method && url === '/api/inventory').length

    expect(loads()).toBe(1)
    await typeQuantity('Anzahl in Binder', '7')
    await flushPromises()

    expect(component.find('p[role="alert"]').text()).toBe('Die Anzahl darf höchstens 999 betragen.')
    expect(loads()).toBe(2)
    // Back to what the server has.
    expect(component.find<HTMLInputElement>('input[aria-label="Anzahl in Binder"]').element.value).toBe('3')
  })

  // The queue is the shared `useQueuedWrites` (#148): a failed write reloads
  // before the next one starts, doesn't block it, and skips `afterWrite`.
  it('runs the write queued behind a failed one after the reload', async () => {
    const { server, afterWrite } = await mountEditor(threeRows)
    server.state.hold = true
    server.state.fail = new Error('offline')
    const requests = () => server.fetch.mock.calls
      .filter(([url]) => !url.endsWith('/printings'))
      .map(([url, options]) => `${options?.method ?? 'GET'} ${url}`)

    await typeQuantity('Anzahl in Binder', '7')
    await typeQuantity('Anzahl in Box 1', '4')
    await flushPromises()
    expect(server.calls).toHaveLength(1)

    server.release()
    await flushPromises()
    // The failed PATCH, then the reload, then the queued PATCH.
    expect(requests().slice(1)).toEqual(['PATCH /api/inventory/r-binder', 'GET /api/inventory', 'PATCH /api/inventory/r-box'])
    expect(body().find('p[role="alert"]').text()).toBe('Die Änderung konnte nicht gespeichert werden.')

    server.release()
    await flushPromises()
    expect(server.rows().find(row => row.id === 'r-box')!.quantity).toBe(4)
    expect(server.rows().find(row => row.id === 'r-binder')!.quantity).toBe(3)
    expect(afterWrite).toHaveBeenCalledTimes(1)
  })

  it('highlights the row it was opened from', async () => {
    const { component } = await mountEditor(threeRows, { focusRowId: 'r-binder' })

    expect(component.find('[data-focused]').attributes('data-row-id')).toBe('r-binder')
  })

  it('renders in English', async () => {
    await setTestLocale('en')
    const { component } = await mountEditor(threeRows)

    const text = component.text()
    expect(text).toContain('In your inventory')
    expect(text).toContain('Add to collection')
    expect(text).toContain('Edit note')
    expect(component.find('[aria-label="Quantity in (no collection)"]').exists()).toBe(true)
    expect(component.find('[aria-label="One more copy in Binder"]').exists()).toBe(true)
    expect(component.find('[aria-label="Remove from Box 1"]').exists()).toBe(true)
    expect(component.find('[aria-label="Change collection (now: Binder)"]').exists()).toBe(true)
    expect(text).not.toMatch(/Sammlung|Notiz|Kopie/)
  })

  describe('printings (ADR 0034)', () => {
    // Found by name, the component loses its prop types; narrowed to what the tests use.
    interface PrintingSelectWrapper {
      props: (key: string) => unknown
      vm: { $emit: (event: string, ...args: unknown[]) => void }
    }

    function printingSelects(component: VueWrapper): PrintingSelectWrapper[] {
      return component.findAllComponents({ name: 'InventoryPrintingSelect' }) as unknown as PrintingSelectWrapper[]
    }

    it('shows each stack\'s printing, "unknown" ones first, and names it in the labels', async () => {
      const { component } = await mountEditor([
        { id: 'r-sdy', collectionId: 'col-1', quantity: 1, note: null, printingId: SDY },
        { id: 'r-unknown', collectionId: 'col-1', quantity: 2, note: null },
        { id: 'r-lob', collectionId: 'col-1', quantity: 1, note: null, printingId: LOB },
      ])

      expect(rowIds(component)).toEqual(['r-unknown', 'r-lob', 'r-sdy'])
      expect(printingSelects(component).map(select => select.props('modelValue'))).toEqual([null, LOB, SDY])
      expect(printingSelects(component)[0]!.props('printings')).toEqual(printings)
      // Two stacks in one collection stay apart in the controls' names.
      button('Anzahl in Box 1 · LOB-005 (UR)')
      button('Printing ändern (Box 1 · SDY-006 (UR))')
      button('Printing ändern (Box 1)')
    })

    it('saves a picked printing at once and reports a merge into an existing stack', async () => {
      const { component, server, afterWrite } = await mountEditor([
        { id: 'r-unknown', collectionId: null, quantity: 2, note: null },
        { id: 'r-lob', collectionId: null, quantity: 1, note: null, printingId: LOB },
      ])

      await printingSelects(component)[0]!.vm.$emit('update:modelValue', SDY)
      await flushPromises()
      expect(server.calls).toEqual([{ url: '/api/inventory/r-unknown', method: 'PATCH', body: { printingId: SDY } }])
      expect(afterWrite).toHaveBeenCalledTimes(1)

      // Back to "unknown" … and then into the LOB-005 stack, which merges.
      server.state.mergeInto = 'r-lob'
      await printingSelects(component).find(select => select.props('modelValue') === SDY)!.vm.$emit('update:modelValue', LOB)
      await flushPromises()
      expect(server.calls.at(-1)).toEqual({ url: '/api/inventory/r-unknown', method: 'PATCH', body: { printingId: LOB } })
      expect(body().text()).toContain('Mit den Kopien in (keine Sammlung) zusammengelegt.')
      expect(rowIds(component)).toEqual(['r-lob'])
    })
  })
})
