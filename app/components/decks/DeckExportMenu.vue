<script setup lang="ts">
/**
 * "Exportieren": the deck as a YDK file, a ydke:// link, an Omega text recipe
 * or an Omega deck code. The encoders are pure (`shared/decklist.ts`); this
 * only hands the result to the clipboard or the browser. Used by the deck
 * editor and the shared deck view, so whoever can see a deck can export it.
 */
import { deckPasscodes, deckRecipeRows, encodeOmegaCode, encodeRecipe, encodeYdk, encodeYdke, isPasscode, ydkFileName } from '~~/shared/decklist'
import type { ExportCardRow } from '~~/shared/decklist'
import type { DeckSection } from '~~/shared/deck-sections'

const props = defineProps<{
  name: string
  sections: Record<DeckSection, ExportCardRow[]>
  /** The deck's effective cover (ADR 0012); the Omega code carries it. */
  coverCardId?: number | null
}>()

const { t } = useI18n()
const count = useCount()
const toast = useToast()

const isEmpty = computed(() => Object.values(props.sections).every(rows => rows.length === 0))

/** A copy without a passcode can't go into a passcode format; say so instead of exporting a smaller deck silently. */
function notifySkipped(skipped: number) {
  if (skipped > 0) {
    toast.add({ title: count('decks.export.toast.skipped', skipped), color: 'warning' })
  }
}

async function copy(text: string, copiedKey: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: t(copiedKey), color: 'success' })
  }
  catch {
    toast.add({ title: t('decks.export.errors.copyFailed'), color: 'error' })
  }
}

function downloadYdk() {
  const { passcodes, skipped } = deckPasscodes(props.sections)
  const url = URL.createObjectURL(new Blob([encodeYdk(passcodes)], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = ydkFileName(props.name)
  link.click()
  URL.revokeObjectURL(url)
  toast.add({ title: t('decks.export.toast.downloaded', { name: link.download }), color: 'success' })
  notifySkipped(skipped)
}

async function copyYdke() {
  const { passcodes, skipped } = deckPasscodes(props.sections)
  await copy(encodeYdke(passcodes), 'decks.export.toast.ydke')
  notifySkipped(skipped)
}

async function copyRecipe() {
  await copy(encodeRecipe(deckRecipeRows(props.sections)), 'decks.export.toast.recipe')
}

async function copyOmega() {
  const { passcodes, skipped } = deckPasscodes(props.sections)
  try {
    const cover = isPasscode(props.coverCardId) ? props.coverCardId : null
    await copy(await encodeOmegaCode(passcodes, cover), 'decks.export.toast.omega')
  }
  catch {
    toast.add({ title: t('decks.export.errors.omegaFailed'), color: 'error' })
    return
  }
  notifySkipped(skipped)
}

const items = computed(() => [
  [
    { label: t('decks.export.ydk'), icon: 'i-lucide-download', onSelect: downloadYdk },
    { label: t('decks.export.ydke'), icon: 'i-lucide-link', onSelect: copyYdke },
    { label: t('decks.export.omega'), icon: 'i-lucide-braces', onSelect: copyOmega },
    { label: t('decks.export.recipe'), icon: 'i-lucide-list', onSelect: copyRecipe },
  ],
])
</script>

<template>
  <UDropdownMenu :items="items">
    <UButton
      icon="i-lucide-file-down"
      trailing-icon="i-lucide-chevron-down"
      color="neutral"
      variant="outline"
      :label="t('decks.export.menu')"
      :disabled="isEmpty"
      :title="isEmpty ? t('decks.export.empty') : undefined"
    />
  </UDropdownMenu>
</template>
