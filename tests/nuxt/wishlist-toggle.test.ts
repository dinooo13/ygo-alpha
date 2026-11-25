import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick, ref } from 'vue'
import AddToWishlistButton from '~/components/wishlist/AddToWishlistButton.vue'
import { useWishlistToggle } from '~/composables/useWishlistToggle'

afterEach(() => {
  vi.unstubAllGlobals()
})

enableAutoUnmount(afterEach)

type Toggle = ReturnType<typeof useWishlistToggle>

/**
 * A stand-in for the catalog page: it owns the toggle state and shows one
 * button for card 42 while `showButton` is true (the grid tile, which the
 * page swaps for skeletons while a search loads).
 */
async function mountHost(initialIds: number[] = []) {
  let wishlist!: Toggle
  const showButton = ref(true)
  const ids = ref(initialIds)
  const Host = defineComponent({
    setup() {
      wishlist = useWishlistToggle(ids)
      return () => showButton.value
        ? h(AddToWishlistButton, {
            inWishlist: wishlist.isWishlisted(42),
            loading: wishlist.isSaving(42),
            error: wishlist.errorFor(42),
            onToggle: () => wishlist.toggle(42),
          })
        : h('div', { class: 'skeleton' })
    },
  })
  const component = await mountSuspended(Host)
  return { component, wishlist: () => wishlist, showButton, ids }
}

function deferred() {
  let resolve!: (value?: unknown) => void
  let reject!: (error: unknown) => void
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('useWishlistToggle', () => {
  it('is seeded from the wishlisted ids', async () => {
    const { wishlist, ids } = await mountHost([7, 42])

    expect(wishlist().isWishlisted(42)).toBe(true)
    expect(wishlist().isWishlisted(1)).toBe(false)

    ids.value = [1]
    await nextTick()
    expect(wishlist().isWishlisted(1)).toBe(true)
    expect(wishlist().isWishlisted(42)).toBe(false)
  })

  it('adds with POST and removes with DELETE', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(undefined))
    vi.stubGlobal('$fetch', fetchMock)
    const { component, wishlist } = await mountHost()

    expect(component.text()).toContain('Zur Wunschliste')
    await component.find('button').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/wishlist', { method: 'POST', body: { catalogCardId: 42 } })
    expect(wishlist().isWishlisted(42)).toBe(true)
    expect(component.text()).toContain('Auf der Wunschliste')

    await component.find('button').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/wishlist/card/42', { method: 'DELETE' })
    expect(wishlist().isWishlisted(42)).toBe(false)
  })

  it('sends a quantity only when one is given (the deck editor\'s shortfall, #178)', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(undefined))
    vi.stubGlobal('$fetch', fetchMock)
    const { wishlist } = await mountHost()

    await wishlist().toggle(42, 2)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/wishlist', { method: 'POST', body: { catalogCardId: 42, quantity: 2 } })
    expect(wishlist().isWishlisted(42)).toBe(true)

    // A removal ignores it.
    await wishlist().toggle(42, 2)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/wishlist/card/42', { method: 'DELETE' })

    await wishlist().toggle(42)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/wishlist', { method: 'POST', body: { catalogCardId: 42 } })
  })

  it('ignores a second toggle while the first one is saving', async () => {
    const { wishlist } = await mountHost()
    // Stubbed after mounting: a pending `$fetch` would also hold up the mount.
    const request = deferred()
    const fetchMock = vi.fn(() => request.promise)
    vi.stubGlobal('$fetch', fetchMock)

    const first = wishlist().toggle(42)
    expect(wishlist().isSaving(42)).toBe(true)
    await wishlist().toggle(42)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    request.resolve()
    await first
    expect(wishlist().isSaving(42)).toBe(false)
    expect(wishlist().isWishlisted(42)).toBe(true)
  })

  it('keeps the state and shows an error when the request fails', async () => {
    vi.stubGlobal('$fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    const { component, wishlist } = await mountHost()

    await component.find('button').trigger('click')
    await flushPromises()

    expect(wishlist().isWishlisted(42)).toBe(false)
    expect(wishlist().errorFor(42)).toBeTruthy()
    expect(component.find('p.text-error').text()).toBe(wishlist().errorFor(42))
  })

  it('keeps a toggle that finishes after its button was unmounted (#98)', async () => {
    const { component, wishlist, showButton } = await mountHost()
    const request = deferred()
    vi.stubGlobal('$fetch', vi.fn(() => request.promise))

    await component.find('button').trigger('click')
    // The search reloads: the grid (and the button) is replaced by skeletons.
    showButton.value = false
    await nextTick()
    expect(component.find('button').exists()).toBe(false)

    request.resolve()
    await flushPromises()
    expect(wishlist().isWishlisted(42)).toBe(true)

    // The new grid shows the card as wishlisted.
    showButton.value = true
    await nextTick()
    expect(component.text()).toContain('Auf der Wunschliste')
  })
})
