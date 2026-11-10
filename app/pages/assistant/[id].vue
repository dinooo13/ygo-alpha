<script setup lang="ts">
import type { AssistantConversationSummary } from '~~/shared/assistant-chat'

usePageTitle('assistant.title')

const { t } = useI18n()

const route = useRoute()
const router = useRouter()
const conversationId = computed(() => route.params.id as string)

const { data: status } = await useAssistantStatus()

const { data: conversationsData, refresh: refreshConversations } = await useAssistantConversations()
const conversations = computed(() => conversationsData.value?.items ?? [])

// The open conversation's summary (its title), from the thread once it has
// loaded it. The title follows the list, which is refreshed after every turn
// (the first message names a new conversation) and when the model names the
// conversation (#129).
const loadedConversation = ref<AssistantConversationSummary | null>(null)
const conversation = computed<AssistantConversationSummary | null>(() => {
  const current = loadedConversation.value
  if (!current || current.id !== conversationId.value) {
    return null
  }
  const listed = conversations.value.find(item => item.id === current.id)
  return listed ? { ...current, title: listed.title } : current
})

// Below `lg` there's no room for the conversation list aside — it lives in
// this slideover instead, opened from the "Unterhaltungen" button in the
// thread header (mirrors app/layouts/default.vue's mobile nav drawer).
const isConversationsOpen = ref(false)

// Coming from the /assistant empty state's example prompts: the thread sends
// the chosen prompt once it has loaded the conversation (see `onMounted`,
// which drops it from the URL so a reload doesn't resend it).
const initialPrompt = ref(typeof route.query.prompt === 'string' ? route.query.prompt : '')

watch(conversationId, () => {
  isConversationsOpen.value = false
  initialPrompt.value = ''
})

onMounted(async () => {
  // The conversation list on this page is fetched independently from the
  // one on /assistant — refresh so a conversation just created there (or by
  // this page's own "Neue Unterhaltung") shows up right away.
  await refreshConversations()

  // An example prompt is being sent — drop `?prompt=` so a reload doesn't
  // resend it.
  if (route.query.prompt !== undefined) {
    await router.replace({ query: {} })
  }
})

async function onCreated(id: string) {
  await refreshConversations()
  await navigateTo(`/assistant/${id}`)
}

async function onDeleted(id: string) {
  await refreshConversations()
  if (id === conversationId.value) {
    const next = conversations.value[0]
    await navigateTo(next ? `/assistant/${next.id}` : '/assistant')
  }
}
</script>

<template>
  <div class="flex h-[calc(100dvh-5.5rem)] min-h-0 flex-col gap-4 lg:h-[calc(100dvh-4rem)] lg:gap-6">
    <!-- Exactly the height below the mobile header (56px) and the main
         padding (2 × 16px; 2 × 32px from lg), so the page itself never scrolls:
         the thread scrolls inside and the composer stays in view. -->
    <LayoutPageHeader
      :eyebrow="t('assistant.title')"
      truncate
      class="shrink-0 max-sm:flex-row max-sm:items-start max-sm:gap-3"
    >
      <template #title>
        {{ conversation?.title ?? t('assistant.title') }}
      </template>
      <template
        v-if="status?.chat"
        #actions
      >
        <!-- Icon-only on phones, so the title keeps its row. -->
        <UButton
          icon="i-lucide-messages-square"
          :label="t('assistant.conversations.title')"
          :aria-label="t('assistant.conversations.title')"
          :ui="{ label: 'max-sm:sr-only' }"
          color="neutral"
          variant="outline"
          class="tap-target lg:hidden"
          @click="() => { isConversationsOpen = true }"
        />
      </template>
    </LayoutPageHeader>

    <AssistantUnavailableNotice v-if="!status?.chat" />

    <div
      v-else
      class="flex min-h-0 flex-1 gap-4"
    >
      <aside class="panel hidden w-64 shrink-0 overflow-hidden lg:block">
        <AssistantConversationList
          :items="conversations"
          :active-id="conversationId"
          @created="onCreated"
          @deleted="onDeleted"
        />
      </aside>

      <USlideover
        v-model:open="isConversationsOpen"
        side="left"
        :title="t('assistant.conversations.title')"
        class="lg:hidden"
        :ui="{ body: 'p-0 sm:p-0' }"
      >
        <template #body>
          <AssistantConversationList
            :items="conversations"
            :active-id="conversationId"
            @created="onCreated"
            @deleted="onDeleted"
          />
        </template>
      </USlideover>

      <section class="panel flex min-w-0 flex-1 flex-col overflow-hidden">
        <AssistantChatThread
          :key="conversationId"
          :conversation-id="conversationId"
          :initial-prompt="initialPrompt"
          :models="status?.models ?? []"
          :default-model="status?.defaultModel ?? null"
          @loaded="(summary) => { loadedConversation = summary }"
          @turn-end="refreshConversations"
          @title-change="refreshConversations"
        />
      </section>
    </div>
  </div>
</template>
