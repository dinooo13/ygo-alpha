<script setup lang="ts">
import { PARTICIPANT_NAME_MAX_LENGTH } from '~~/shared/tournaments'
import type { TournamentDetail, TournamentParticipantDto } from '~~/shared/tournaments'
import { apiErrorCode } from '~/utils/card-entry'

const props = defineProps<{
  tournament: TournamentDetail
}>()

const emit = defineEmits<{
  updated: [detail: TournamentDetail]
}>()

const { t, n, d } = useI18n()
const count = useCount()
const apiError = useApiError()
const validationText = useValidationText()

// The "Konto" badge is explained as its tooltip (`accountHint`) and in the
// legend under the table (`accountLegend`) (#28).

// --- Add participant --------------------------------------------------------

const addMode = ref<'email' | 'guest'>('email')
const emailInput = ref('')
const nameInput = ref('')
const isAdding = ref(false)
const addError = ref('')
/** `data.code` of the last failed add, for the "add as guest instead" offer. */
const addErrorCode = ref<string | undefined>()

const canAddParticipant = computed(() =>
  props.tournament.role === 'organizer' && props.tournament.status === 'registration')

async function addParticipant() {
  if (isAdding.value) {
    return
  }

  isAdding.value = true
  addError.value = ''
  addErrorCode.value = undefined

  try {
    const body = addMode.value === 'email' ? { email: emailInput.value } : { name: nameInput.value }
    const detail = await $fetch<TournamentDetail>(`/api/tournaments/${props.tournament.id}/participants`, {
      method: 'POST',
      body,
    })
    emailInput.value = ''
    nameInput.value = ''
    emit('updated', detail)
  }
  catch (error) {
    addError.value = apiError(error, 'tournaments.participants.errors.addFailed')
    addErrorCode.value = apiErrorCode(error)
  }
  finally {
    isAdding.value = false
  }
}

/**
 * "Zu dieser E-Mail-Adresse gibt es kein Konto." offers no way out — switch
 * to the guest form and keep whatever name-ish text the organizer already
 * typed (the e-mail's local part, if there was no name yet) so they don't
 * have to retype it (#37).
 */
const showAddAsGuestHint = computed(() => addError.value !== '' && addErrorCode.value === 'user_not_found')

function addAsGuestInstead() {
  if (!nameInput.value && emailInput.value) {
    nameInput.value = emailInput.value.split('@')[0] ?? ''
  }
  addMode.value = 'guest'
  addError.value = ''
  addErrorCode.value = undefined
}

// --- Rename -----------------------------------------------------------------

const renamingParticipant = ref<TournamentParticipantDto | null>(null)
const renameValue = ref('')
const isRenaming = ref(false)
const renameError = ref('')
const isRenameOpen = computed({
  get: () => renamingParticipant.value !== null,
  set: (value: boolean) => {
    if (!value) {
      renamingParticipant.value = null
    }
  },
})

function openRename(participant: TournamentParticipantDto) {
  renamingParticipant.value = participant
  renameValue.value = participant.name
  renameError.value = ''
}

async function saveRename() {
  if (!renamingParticipant.value || isRenaming.value) {
    return
  }

  isRenaming.value = true
  renameError.value = ''

  try {
    const detail = await $fetch<TournamentDetail>(
      `/api/tournaments/${props.tournament.id}/participants/${renamingParticipant.value.id}`,
      { method: 'PATCH', body: { name: renameValue.value } },
    )
    emit('updated', detail)
    renamingParticipant.value = null
  }
  catch (error) {
    renameError.value = apiError(error, 'tournaments.participants.errors.renameFailed')
  }
  finally {
    isRenaming.value = false
  }
}

// --- Drop / remove -----------------------------------------------------------

const busyParticipantId = ref<string | null>(null)
const rowError = ref('')

async function setDropped(participant: TournamentParticipantDto, dropped: boolean) {
  busyParticipantId.value = participant.id
  rowError.value = ''

  try {
    const detail = await $fetch<TournamentDetail>(
      `/api/tournaments/${props.tournament.id}/participants/${participant.id}`,
      { method: 'PATCH', body: { dropped } },
    )
    emit('updated', detail)
  }
  catch (error) {
    rowError.value = apiError(error, 'tournaments.participants.errors.dropFailed')
  }
  finally {
    busyParticipantId.value = null
  }
}

const { confirm } = useConfirm()

/**
 * "Aus der Wertung nehmen" (ADR 0031): unlike dropping, this voids every
 * match with the participant for everybody's standings — so taking someone
 * out asks first; putting them back is harmless and does not.
 */
async function setWithdrawn(participant: TournamentParticipantDto, withdrawn: boolean) {
  if (withdrawn) {
    const confirmed = await confirm({
      title: t('tournaments.participants.confirm.withdraw.title'),
      description: t('tournaments.participants.confirm.withdraw.description', { name: participant.name }),
    })
    if (!confirmed) {
      return
    }
  }

  busyParticipantId.value = participant.id
  rowError.value = ''

  try {
    const detail = await $fetch<TournamentDetail>(
      `/api/tournaments/${props.tournament.id}/participants/${participant.id}`,
      { method: 'PATCH', body: { withdrawn } },
    )
    emit('updated', detail)
  }
  catch (error) {
    rowError.value = apiError(error, 'tournaments.participants.errors.withdrawFailed')
  }
  finally {
    busyParticipantId.value = null
  }
}

async function removeParticipant(participant: TournamentParticipantDto) {
  // Destructive and irreversible — a registered deck is lost with the row —
  // so it gets the same confirm as every other destructive action in the
  // app (#28), now via the themed useConfirm() dialog instead of a native
  // `window.confirm` (#14).
  const confirmed = await confirm({
    title: t('tournaments.participants.confirm.remove.title'),
    description: t('tournaments.participants.confirm.remove.description', { name: participant.name }),
  })
  if (!confirmed) {
    return
  }

  busyParticipantId.value = participant.id
  rowError.value = ''

  try {
    const detail = await $fetch<TournamentDetail>(
      `/api/tournaments/${props.tournament.id}/participants/${participant.id}`,
      { method: 'DELETE' },
    )
    emit('updated', detail)
  }
  catch (error) {
    rowError.value = apiError(error, 'tournaments.participants.errors.removeFailed')
  }
  finally {
    busyParticipantId.value = null
  }
}

function menuItemsFor(participant: TournamentParticipantDto) {
  const items = []

  if (props.tournament.role === 'organizer' && props.tournament.status !== 'finished') {
    items.push({
      label: t('tournaments.participants.menu.rename'),
      icon: 'i-lucide-pencil',
      onSelect: () => openRename(participant),
    })
  }

  if (props.tournament.role === 'organizer' && props.tournament.status === 'running') {
    items.push({
      label: participant.dropped ? t('tournaments.participants.menu.reinstate') : t('tournaments.participants.menu.drop'),
      icon: participant.dropped ? 'i-lucide-undo-2' : 'i-lucide-user-x',
      onSelect: () => setDropped(participant, !participant.dropped),
    })
    items.push({
      label: participant.withdrawn ? t('tournaments.participants.menu.unwithdraw') : t('tournaments.participants.menu.withdraw'),
      icon: participant.withdrawn ? 'i-lucide-undo-2' : 'i-lucide-eye-off',
      onSelect: () => setWithdrawn(participant, !participant.withdrawn),
    })
  }

  if (props.tournament.role === 'organizer' && props.tournament.status === 'registration') {
    items.push({
      label: t('common.remove'),
      icon: 'i-lucide-trash-2',
      color: 'error' as const,
      onSelect: () => removeParticipant(participant),
    })
  }

  return items.length > 0 ? [items] : []
}

// --- Deck registration --------------------------------------------------------

const deckModalOpen = ref(false)
const deckModalParticipant = ref<TournamentParticipantDto | null>(null)

function canRegisterDeck(participant: TournamentParticipantDto): boolean {
  if (props.tournament.status !== 'registration') {
    return false
  }
  return participant.isSelf || (props.tournament.role === 'organizer' && !participant.linked)
}

function openDeckModal(participant: TournamentParticipantDto) {
  deckModalParticipant.value = participant
  deckModalOpen.value = true
}

function onDeckUpdated(detail: TournamentDetail) {
  emit('updated', detail)
}

// A linked participant who isn't the caller and isn't self-registerable by
// the organizer either (i.e. any other linked participant while the
// tournament is still open) manages their own deck — say so instead of just
// omitting the button silently (#34).
function managesOwnDeck(participant: TournamentParticipantDto): boolean {
  return props.tournament.status === 'registration'
    && participant.linked
    && !participant.isSelf
    && !canRegisterDeck(participant)
}

// Whether a row has anything to act on. On phones the actions cell is a
// full-width strip under the card, so a row with nothing in it hides that
// cell instead of leaving an empty bordered strip (#28).
function rowHasActions(participant: TournamentParticipantDto): boolean {
  return canRegisterDeck(participant)
    || managesOwnDeck(participant)
    || menuItemsFor(participant).length > 0
}

// No row has anything to act on (e.g. a finished tournament, or a
// participant viewing a running one) — drop the empty "Aktionen" column.
const hasRowActions = computed(() => props.tournament.participants.some(rowHasActions))

// The caller's own row, when they play in the tournament — used for the
// "register before it starts" banner below (#31).
const selfParticipant = computed(() =>
  props.tournament.participants.find(participant => participant.id === props.tournament.selfParticipantId) ?? null)

const showDeckReminder = computed(() =>
  props.tournament.role === 'participant'
  && props.tournament.status === 'registration'
  && selfParticipant.value !== null
  && !selfParticipant.value.deckName)

function openOwnDeckModal() {
  if (selfParticipant.value) {
    openDeckModal(selfParticipant.value)
  }
}

function deckBadge(participant: TournamentParticipantDto): { label: string, color: 'success' | 'error' | 'neutral' } | null {
  // deckName is snapshot-derived and survives the underlying deck being
  // deleted (deckId is ON DELETE SET NULL); gate on it, not on deckId, so a
  // deleted deck keeps showing the registered snapshot's legality badge.
  if (!participant.deckName) {
    return null
  }
  if (participant.deckLegal === null) {
    return { label: t('tournaments.noFormat'), color: 'neutral' }
  }
  return participant.deckLegal
    ? { label: t('validation.badge.legal'), color: 'success' }
    : { label: t('validation.badge.notLegal'), color: 'error' }
}

function issueCountLabel(participant: TournamentParticipantDto): string | null {
  if (!participant.deckIssueCount) {
    return null
  }
  return count('tournaments.participants.issueCount', participant.deckIssueCount)
}

/**
 * The snapshot's issues in the interface language: `issueDetails` (code +
 * params, since #34 F2c) through the validation catalogue; older snapshots
 * only have the stored message strings, shown as they are.
 */
function issueMessages(participant: TournamentParticipantDto): string[] {
  const validation = participant.deckSnapshot?.validation
  if (!validation) {
    return []
  }
  return validation.issueDetails
    ? validation.issueDetails.map(issue => validationText(issue))
    : validation.issues.map(issue => validationText(issue))
}

// "Stand: 12.9.2026, 13:13:52" was overly precise and ambiguous about what
// it meant; "Angemeldet am 12.09.2026, 13:13" (no seconds) reads clearly (#30).
function capturedAtLabel(participant: TournamentParticipantDto): string | null {
  const capturedAt = participant.deckSnapshot?.capturedAt
  if (!capturedAt) {
    return null
  }
  return t('tournaments.participants.registeredAt', { date: d(new Date(capturedAt), 'dateTime') })
}
</script>

<template>
  <section class="panel p-4">
    <h2 class="text-base font-semibold text-highlighted">
      {{ t('tournaments.participants.title', { count: n(tournament.participants.length, 'integer') }) }}
    </h2>

    <UAlert
      v-if="showDeckReminder"
      class="mt-4"
      color="warning"
      variant="subtle"
      icon="i-lucide-alert-triangle"
      :title="t('tournaments.participants.deckReminder')"
    >
      <template #actions>
        <UButton
          size="xs"
          :label="t('tournaments.participants.registerDeck')"
          class="tap-target"
          @click="openOwnDeckModal"
        />
      </template>
    </UAlert>

    <form
      v-if="canAddParticipant"
      class="mt-4 flex flex-wrap items-end gap-2"
      @submit.prevent="addParticipant"
    >
      <div class="flex gap-2">
        <UButton
          type="button"
          size="sm"
          :color="addMode === 'email' ? 'primary' : 'neutral'"
          :variant="addMode === 'email' ? 'subtle' : 'outline'"
          :aria-pressed="addMode === 'email'"
          :label="t('tournaments.participants.add.byEmail')"
          @click="() => { addMode = 'email' }"
        />
        <UButton
          type="button"
          size="sm"
          :color="addMode === 'guest' ? 'primary' : 'neutral'"
          :variant="addMode === 'guest' ? 'subtle' : 'outline'"
          :aria-pressed="addMode === 'guest'"
          :label="t('tournaments.participants.add.asGuest')"
          @click="() => { addMode = 'guest' }"
        />
      </div>

      <UInput
        v-if="addMode === 'email'"
        v-model="emailInput"
        type="email"
        :placeholder="t('tournaments.participants.add.emailPlaceholder')"
        :aria-label="t('tournaments.participants.add.emailAriaLabel')"
      />
      <UInput
        v-else
        v-model="nameInput"
        :placeholder="t('tournaments.participants.add.guestNamePlaceholder')"
        :maxlength="PARTICIPANT_NAME_MAX_LENGTH"
        :aria-label="t('tournaments.participants.add.guestNameAriaLabel')"
      />

      <UButton
        type="submit"
        icon="i-lucide-user-plus"
        :label="t('tournaments.participants.add.submit')"
        :loading="isAdding"
      />
    </form>
    <div
      v-if="addError"
      class="mt-2 flex flex-wrap items-center gap-2"
    >
      <p class="text-sm text-error">
        {{ addError }}
      </p>
      <UButton
        v-if="showAddAsGuestHint"
        size="xs"
        color="neutral"
        variant="outline"
        :label="t('tournaments.participants.add.asGuestInstead')"
        @click="addAsGuestInstead"
      />
    </div>

    <p
      v-if="rowError"
      class="mt-2 text-sm text-error"
    >
      {{ rowError }}
    </p>

    <!-- One <table> for both layouts (#28): below `sm` the rows are restyled
         as stacked cards via CSS instead of rendering a second, duplicated
         card list. Changing `display` on table elements can drop their
         implicit semantics (notably in Safari), so the ARIA roles are
         spelled out explicitly. -->
    <div class="mt-4 overflow-x-auto">
      <table
        role="table"
        class="block w-full text-left text-sm sm:table"
      >
        <thead
          role="rowgroup"
          class="hidden sm:table-header-group"
        >
          <tr
            role="row"
            class="border-b border-default bg-elevated/50 text-[0.6875rem] tracking-wider text-muted uppercase"
          >
            <th
              role="columnheader"
              class="py-2 pr-2 pl-3"
            >
              #
            </th>
            <th
              role="columnheader"
              class="px-2 py-2"
            >
              {{ t('tournaments.participants.columns.name') }}
            </th>
            <th
              role="columnheader"
              class="px-2 py-2"
            >
              {{ t('tournaments.participants.columns.deck') }}
            </th>
            <th
              v-if="hasRowActions"
              role="columnheader"
              class="px-2 py-2 text-right"
            >
              {{ t('tournaments.participants.columns.actions') }}
            </th>
          </tr>
        </thead>
        <tbody
          role="rowgroup"
          class="block space-y-2 sm:table-row-group sm:space-y-0 sm:divide-y sm:divide-default"
        >
          <tr
            v-for="participant in tournament.participants"
            :key="participant.id"
            role="row"
            class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg border border-default p-3 transition-colors sm:table-row sm:rounded-none sm:border-0 sm:p-0 sm:hover:bg-elevated/40"
          >
            <td
              role="cell"
              class="font-numeric tracking-[0.04em] text-muted tabular-nums sm:py-2 sm:pr-2 sm:pl-3"
            >
              <span class="sm:hidden">#</span>{{ participant.seed }}
            </td>
            <td
              role="cell"
              class="font-medium text-highlighted sm:px-2 sm:py-2"
            >
              <div class="flex flex-wrap items-center gap-1.5">
                <span>{{ participant.name }}</span>
                <UBadge
                  v-if="participant.linked"
                  size="sm"
                  color="neutral"
                  variant="subtle"
                  icon="i-lucide-user-check"
                  :label="t('tournaments.participants.accountBadge')"
                  :title="t('tournaments.participants.accountHint')"
                />
                <UBadge
                  v-if="participant.dropped"
                  size="sm"
                  color="neutral"
                  variant="subtle"
                  :label="t('tournaments.dropped')"
                />
                <UBadge
                  v-if="participant.withdrawn"
                  size="sm"
                  color="neutral"
                  variant="subtle"
                  :label="t('tournaments.withdrawn')"
                />
              </div>
            </td>
            <td
              role="cell"
              class="col-start-2 sm:px-2 sm:py-2"
            >
              <template v-if="participant.deckName">
                <div class="text-highlighted">
                  {{ participant.deckName }}
                </div>
                <div class="mt-0.5 flex flex-wrap items-center gap-1">
                  <UPopover v-if="deckBadge(participant) && participant.deckIssueCount">
                    <button
                      type="button"
                      class="tap-target inline-flex items-center gap-1 rounded hover:bg-elevated/50"
                      :aria-label="t('tournaments.participants.showIssues', { name: participant.name })"
                    >
                      <UBadge
                        size="sm"
                        variant="subtle"
                        :color="deckBadge(participant)!.color"
                        :label="deckBadge(participant)!.label"
                      />
                      <span class="text-xs text-muted">{{ issueCountLabel(participant) }}</span>
                    </button>

                    <template #content>
                      <div class="max-w-xs space-y-1 p-3">
                        <p class="text-xs font-semibold text-highlighted">
                          {{ t('tournaments.participants.issuesTitle') }}
                        </p>
                        <ul class="list-inside list-disc space-y-0.5 text-xs text-toned">
                          <li
                            v-for="(issue, index) in issueMessages(participant)"
                            :key="index"
                          >
                            {{ issue }}
                          </li>
                        </ul>
                      </div>
                    </template>
                  </UPopover>
                  <UBadge
                    v-else-if="deckBadge(participant)"
                    size="sm"
                    variant="subtle"
                    :color="deckBadge(participant)!.color"
                    :label="deckBadge(participant)!.label"
                  />
                </div>
                <div
                  v-if="capturedAtLabel(participant)"
                  class="mt-0.5 text-xs text-muted"
                >
                  {{ capturedAtLabel(participant) }}
                </div>
              </template>
              <span
                v-else
                class="text-muted"
              >{{ t('tournaments.noDeck') }}</span>
            </td>
            <td
              v-if="hasRowActions"
              role="cell"
              class="col-span-full border-t border-muted pt-2 sm:border-0 sm:px-2 sm:py-2"
              :class="rowHasActions(participant) ? undefined : 'max-sm:hidden'"
            >
              <div class="flex items-center justify-start gap-2 sm:justify-end">
                <UButton
                  v-if="canRegisterDeck(participant)"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  class="tap-target"
                  :label="participant.deckName ? t('tournaments.participants.changeDeck') : t('tournaments.participants.registerDeck')"
                  @click="openDeckModal(participant)"
                />
                <span
                  v-else-if="managesOwnDeck(participant)"
                  class="text-xs text-muted"
                >{{ t('tournaments.participants.managesOwnDeck') }}</span>
                <UDropdownMenu
                  v-if="menuItemsFor(participant).length > 0"
                  :items="menuItemsFor(participant)"
                >
                  <UButton
                    icon="i-lucide-more-horizontal"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    :aria-label="t('tournaments.participants.optionsFor', { name: participant.name })"
                    :loading="busyParticipantId === participant.id"
                    class="tap-target"
                  />
                </UDropdownMenu>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p
      v-if="tournament.participants.some(participant => participant.linked)"
      class="mt-3 flex items-start gap-1.5 text-xs text-muted"
    >
      <UIcon
        name="i-lucide-user-check"
        class="mt-px size-3.5 shrink-0"
      />
      <span>{{ t('tournaments.participants.accountLegend') }}</span>
    </p>

    <UModal
      v-model:open="isRenameOpen"
      :title="t('tournaments.participants.rename.title')"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField :label="t('tournaments.participants.rename.name')">
            <UInput
              v-model="renameValue"
              :maxlength="PARTICIPANT_NAME_MAX_LENGTH"
              :aria-label="t('tournaments.participants.rename.nameAriaLabel')"
            />
          </UFormField>
          <p
            v-if="renameError"
            class="text-sm text-error"
          >
            {{ renameError }}
          </p>
          <div class="flex justify-end gap-2">
            <UButton
              type="button"
              color="neutral"
              variant="ghost"
              :label="t('common.cancel')"
              @click="() => { renamingParticipant = null }"
            />
            <UButton
              :label="t('common.save')"
              :loading="isRenaming"
              @click="saveRename"
            />
          </div>
        </div>
      </template>
    </UModal>

    <TournamentsDeckRegistrationModal
      v-model:open="deckModalOpen"
      :tournament-id="tournament.id"
      :participant-id="deckModalParticipant?.id ?? null"
      :current-deck-id="deckModalParticipant?.deckId ?? null"
      :format="tournament.format"
      @updated="onDeckUpdated"
    />
  </section>
</template>
