<script setup lang="ts">
import { deckBreakdownGroups } from '~~/shared/deck-breakdown'
import type { SharedDeckView } from '~~/shared/sharing'

definePageMeta({ layout: 'public' })

const route = useRoute()
const { t } = useI18n()
const count = useCount()
const validationText = useValidationText()
const { formatName } = useFormatLabel()

const { data, error } = await useFetch<SharedDeckView>(
  () => `/api/profiles/${route.params.handle}/decks/${route.params.id}`,
  {
    query: computed(() => ({ token: route.query.token || undefined })),
    headers: import.meta.server ? useRequestHeaders(['cookie']) : undefined,
  },
)

// The card-kind chips (#148), from the rows the view already has.
const breakdown = computed(() => (data.value ? deckBreakdownGroups(data.value.sections) : []))

usePageTitle(() => data.value?.deck.name ?? t('players.deck.fallbackTitle'))
useHead({
  meta: [
    { name: 'referrer', content: 'no-referrer' },
    { name: 'robots', content: 'noindex, nofollow' },
  ],
})
</script>

<template>
  <div class="space-y-6">
    <SharingNotFoundNotice v-if="error" />

    <template v-else-if="data">
      <div>
        <LayoutBackLink
          :to="`/players/${route.params.handle}`"
          :label="t('players.backToProfile')"
        />
      </div>

      <LayoutPageHeader
        :title="data.deck.name"
        truncate
      >
        <template #description>
          <span class="inline-flex items-center gap-1.5">
            <ProfileAvatar
              size="2xs"
              :name="data.owner.displayName"
              :handle="data.owner.handle"
            />
            <span>{{ t('players.deck.sharedBy', { name: data.owner.displayName }) }}</span>
          </span>
        </template>
        <p
          v-if="data.deck.description"
          class="mt-1 max-w-prose text-sm text-muted"
        >
          {{ data.deck.description }}
        </p>
        <p class="mt-1 text-sm text-muted">
          {{ count('players.deck.summary', data.counts.total) }}
        </p>
        <DecksDeckKindBreakdown
          :groups="breakdown"
          class="mt-2"
        />

        <template #actions>
          <DecksDeckExportMenu
            :name="data.deck.name"
            :sections="data.sections"
          />
          <UButton
            v-if="data.isOwner"
            icon="i-lucide-pencil"
            :label="t('decks.menu.edit')"
            :to="`/decks/${route.params.id}`"
          />
        </template>
      </LayoutPageHeader>

      <section
        v-if="data.format"
        class="panel p-4"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-base font-semibold text-highlighted">
            {{ formatName(data.format) }}
          </h2>
          <UBadge
            v-if="data.validation"
            :color="data.validation.legal ? 'success' : 'error'"
            variant="subtle"
            :label="data.validation.legal ? t('validation.badge.legal') : t('validation.badge.notLegal')"
            :aria-label="t('players.deck.legality')"
          />
        </div>

        <!--
          The issues behind "Nicht legal" ARE delivered to every viewer (see
          `SharedDeckView.validation` / server/utils/shared-views.ts) — a
          guest previously saw only the bare badge with no way to learn why
          (UX review #21). Collapsed by default so it doesn't compete with
          the badge for attention.
        -->
        <UCollapsible
          v-if="data.validation && !data.validation.legal && data.validation.issues.length > 0"
          class="mt-2"
        >
          <template #default="{ open }">
            <UButton
              color="neutral"
              variant="link"
              size="xs"
              class="tap-target px-0"
              :label="open ? t('players.deck.hideDetails') : t('players.deck.showDetails')"
              :trailing-icon="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            />
          </template>
          <template #content>
            <ul class="mt-2 list-inside list-disc space-y-0.5 text-sm text-error">
              <li
                v-for="(issue, index) in data.validation.issues"
                :key="`${issue.code}-${issue.cardId ?? issue.section ?? index}`"
              >
                {{ validationText(issue) }}
              </li>
            </ul>
          </template>
        </UCollapsible>
      </section>

      <!--
        Owner-only: this is deck-building coaching ("your main deck is a bit
        short"), not information a guest can act on (UX review #21).
      -->
      <UAlert
        v-if="data.isOwner && data.warnings.length > 0"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="t('decks.warningsTitle')"
      >
        <template #description>
          <ul class="list-inside list-disc space-y-0.5">
            <li
              v-for="warning in data.warnings"
              :key="`${warning.code}-${warning.cardId ?? ''}`"
            >
              {{ validationText(warning) }}
            </li>
          </ul>
        </template>
      </UAlert>

      <SharingSharedDeckSections
        :sections="data.sections"
        :counts="data.counts"
      />
    </template>
  </div>
</template>
