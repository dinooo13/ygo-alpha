// One chat turn on the AI SDK (docs/adr/0020-assistant-on-the-ai-sdk.md):
// `streamText` runs the tool loop, `createUIMessageStream` turns it into the
// UI message stream the client reads, and the turn persists the answer as one
// UIMessage. What stays ours on top of the SDK: the pre-stream checks and
// storage (user message, title, the assistant placeholder a proposal's FK
// needs), the history window, the fallback texts saved into the answer
// (cut off, no answer, too many steps, cancelled, timeout), the #54 guards
// against looping tool calls, a proposal ends the turn (ADR 0026), and the
// error codes the UI translates.

import { randomUUID } from 'node:crypto'
import {
  convertToModelMessages,
  createUIMessageStream,
  isStepCount,
  pruneMessages,
  streamText,
  ToolChoiceViolationError,
} from 'ai'
import type {
  FinishReason,
  InferUIMessageChunk,
  ModelMessage,
  PrepareStepFunction,
  StepResult,
  StopCondition,
  UIMessageStreamWriter,
} from 'ai'
import type { useDb } from '../db'
import { assistantConversation, assistantMessage } from '../db/schema'
import { eq } from 'drizzle-orm'
import { ASSISTANT_TOOL_NAMES } from '../../shared/assistant-chat'
import type { AssistantActionView } from '../../shared/assistant-chat'
import type { AssistantToolOutput, AssistantUIMessage, AssistantUIMessagePart } from '../../shared/assistant-ui'
import type { AppLocale } from '../../shared/locale'
import {
  conversationTitleFromText,
  hydrateActionViews,
  requireOwnConversation,
  resolveDeckNames,
} from './assistant-chat'
import { getAssistantLimits } from './assistant-limits'
import type { AssistantLimits } from './assistant-limits'
import { assistantErrorCode, assistantErrorText, assistantStreamErrorText, toolErrorText } from './assistant-model'
import type { AssistantLanguageModel } from './assistant-model'
import { buildSystemPrompt, TOOL_TEXT, TURN_TEXT } from './assistant-prompts'
import type { TurnText } from './assistant-prompts'
import { buildAssistantToolSet } from './assistant-tools'
import type { AssistantToolSet } from './assistant-tools'
import {
  chooseUserMessageId,
  deleteAssistantMessage,
  deleteRegeneratableTail,
  insertAssistantPlaceholder,
  isEmptyAssistantParts,
  loadUiHistory,
  persistUserMessage,
  touchConversation,
  updateAssistantMessage,
} from './assistant-ui-messages'
import type { AssistantTurnRequest } from './assistant-ui-messages'

type Db = ReturnType<typeof useDb>
type Chunk = InferUIMessageChunk<AssistantUIMessage>
type Steps = Array<StepResult<AssistantToolSet>>

/** A whole turn's deadline; a single model call has its own `limits.timeoutMs`. */
export const TURN_TIMEOUT_MS = 5 * 60 * 1000

// --- #54 guards ------------------------------------------------------------------

/** Identical failed tool calls (same tool, same input) after which the turn stops (#54). Tools are switched off one failure earlier. */
export const ASSISTANT_REPEATED_TOOL_FAILURE_LIMIT = 3

/** JSON with sorted keys, so the same input always gives the same key. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

type StepContent = { content: ReadonlyArray<{ type: string, toolCallId?: string, toolName?: string, input?: unknown, output?: unknown, error?: unknown }> }

/** How often each identical tool call (tool name + input) failed across `steps`. */
export function toolFailureCounts(steps: ReadonlyArray<StepContent>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const step of steps) {
    for (const part of step.content) {
      if (part.type === 'tool-error') {
        const key = `${part.toolName ?? ''}:${stableStringify(part.input)}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  return counts
}

export function maxToolFailureCount(steps: ReadonlyArray<StepContent>): number {
  return Math.max(0, ...toolFailureCounts(steps).values())
}

/**
 * The SDK's answer to a model that still calls a tool after
 * `assistantPrepareStep` switched tools off (`toolChoice: 'none'`, #54).
 */
function isToolsOffViolation(error: unknown): boolean {
  return ToolChoiceViolationError.isInstance(error) && error.toolChoice.type === 'none'
}

/** Stops the loop once one identical tool call failed `limit` times — the backstop behind `assistantPrepareStep`. */
export function repeatedToolFailure(limit: number): StopCondition<AssistantToolSet> {
  return ({ steps }) => maxToolFailureCount(steps) >= limit
}

// --- A proposal ends the turn (ADR 0026) ---------------------------------------------

interface StepProposal { toolName: string, output: AssistantToolOutput }

/**
 * The successful write calls of one step that created a pending proposal:
 * their output (the tool's raw `execute` return, not what the model reads)
 * carries `actionId`. A failed write call is a `tool-error` part, never one
 * of these.
 */
export function stepProposals(step: StepContent): StepProposal[] {
  return step.content.flatMap((part) => {
    const output = part.output as Partial<AssistantToolOutput> | null | undefined
    return part.type === 'tool-result' && typeof part.toolName === 'string' && typeof output?.actionId === 'string'
      ? [{ toolName: part.toolName, output: output as AssistantToolOutput }]
      : []
  })
}

/** A set_deck_format proposal whose preview isn't legal: the model still has to propose the card changes (update_deck_cards). */
function isIllegalFormatChange(proposal: StepProposal): boolean {
  const result = proposal.output.result as { preview?: { validation?: { legal?: unknown } | null } } | null | undefined
  return proposal.toolName === 'set_deck_format' && result?.preview?.validation?.legal === false
}

/**
 * Whether the turn ends after the last step: it made at least one proposal,
 * and not (this is the turn's first proposal step AND every proposal in it
 * is an illegal format change) — that one exemption lets the model add the
 * update_deck_cards the system prompt asks for after set_deck_format.
 */
export function shouldStopAfterProposal(steps: ReadonlyArray<StepContent>): boolean {
  const last = steps.at(-1)
  const proposals = last ? stepProposals(last) : []
  if (proposals.length === 0) {
    return false
  }
  const isFirstProposalStep = steps.slice(0, -1).every(step => stepProposals(step).length === 0)
  return !(isFirstProposalStep && proposals.every(isIllegalFormatChange))
}

/**
 * Ends the loop after a step that created a proposal, so the action card is
 * the answer's last element. Not the SDK's `hasToolCall`: that fires on a
 * failed write call too, which the model must still be able to fix.
 */
export function proposalEndsTurn(): StopCondition<AssistantToolSet> {
  return ({ steps }) => shouldStopAfterProposal(steps)
}

/**
 * The model reads a failed tool call as the SDK's rendering of the error
 * object (for an invalid input: the SDK error's message with ours nested in
 * it). Replaces each such result with the plain error text of that call —
 * the same text the stored tool part carries (`errorText`), which is what
 * the model reads in later turns. Returns `messages` itself when nothing
 * changed.
 */
export function cleanToolErrorOutputs(messages: ModelMessage[], steps: ReadonlyArray<StepContent>): ModelMessage[] {
  const texts = new Map<string, string>()
  for (const stepResult of steps) {
    for (const part of stepResult.content) {
      if (part.type === 'tool-error' && typeof part.toolCallId === 'string') {
        texts.set(part.toolCallId, toolErrorText(part.error))
      }
    }
  }
  if (texts.size === 0) {
    return messages
  }
  let changed = false
  const cleaned = messages.map((message) => {
    if (message.role !== 'tool') {
      return message
    }
    let messageChanged = false
    const content = message.content.map((part) => {
      const text = part.type === 'tool-result' ? texts.get(part.toolCallId) : undefined
      if (part.type === 'tool-result' && text !== undefined
        && (part.output.type === 'error-text' || part.output.type === 'error-json')
        && part.output.value !== text) {
        messageChanged = true
        return { ...part, output: { type: 'error-text' as const, value: text } }
      }
      return part
    })
    if (!messageChanged) {
      return message
    }
    changed = true
    return { ...message, content }
  })
  return changed ? cleaned : messages
}

/**
 * Per step (#54): once an identical tool call failed twice, tools are
 * switched off (`toolChoice: 'none'`) so the model has to answer in text;
 * failed calls reach the model as their plain error text.
 */
export const assistantPrepareStep: PrepareStepFunction<AssistantToolSet> = ({ steps, messages }) => {
  const cleaned = cleanToolErrorOutputs(messages, steps)
  const toolsOff = maxToolFailureCount(steps) >= ASSISTANT_REPEATED_TOOL_FAILURE_LIMIT - 1
  if (!toolsOff && cleaned === messages) {
    return undefined
  }
  return {
    ...(toolsOff ? { toolChoice: 'none' as const } : {}),
    ...(cleaned !== messages ? { messages: cleaned } : {}),
  }
}

/**
 * Whether an answer contains a tool call written as text instead of made
 * through the tool-calling interface (#54): a known tool name followed by
 * `(` or `{`, a `{"name":"<tool>"` object, or `<tool_call>` tags.
 */
export function detectTextWrittenToolCall(text: string, toolNames: readonly string[] = ASSISTANT_TOOL_NAMES): boolean {
  if (/<\/?tool_call\b/i.test(text)) {
    return true
  }
  return toolNames.some(name =>
    new RegExp(`\\b${name}\\s*[({]`).test(text)
    || new RegExp(`"name"\\s*:\\s*"${name}"`).test(text))
}

function stepHadToolCalls(step: Steps[number]): boolean {
  return step.toolCalls.length > 0 || step.content.some(part => part.type === 'tool-error')
}

/**
 * The text saved (and streamed) after the model's last step, when the turn
 * didn't end in a proper answer: cut off by a length limit, stopped on a
 * repeated tool failure or the step cap while still calling tools, or no
 * text at all (also a content filter). null = the answer stands as is —
 * also a turn that ended on a proposal (ADR 0026), even without any text:
 * the action card is the answer.
 */
export function fallbackText(steps: Steps, turnText: TurnText): string | null {
  const last = steps.at(-1)
  if (!last) {
    return turnText.noAnswer
  }
  if (last.finishReason === 'length') {
    return last.text.trim() === '' ? `${turnText.cutOffFallback} ${turnText.cutOffSuffix}` : turnText.cutOffSuffix
  }
  if (stepProposals(last).length > 0) {
    return null
  }
  if (stepHadToolCalls(last)) {
    return maxToolFailureCount(steps) >= ASSISTANT_REPEATED_TOOL_FAILURE_LIMIT ? turnText.repeatedToolFailure : turnText.tooManySteps
  }
  if (last.finishReason === 'content-filter' || last.text.trim() === '') {
    return turnText.noAnswer
  }
  return null
}

// --- Parts at the end of a turn ----------------------------------------------------

/**
 * Makes stored parts final: text/reasoning still `streaming` is `done`, and a
 * tool call that never got its result (cancelled, timed out, failed turn)
 * becomes an `output-error` — so a reloaded thread never shows a chip that
 * loads forever, and the call and its error stay a valid pair for the model.
 */
export function finalizeParts(parts: AssistantUIMessagePart[]): AssistantUIMessagePart[] {
  return parts.map((part) => {
    if ((part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming') {
      return { ...part, state: 'done' }
    }
    if (part.type.startsWith('tool-') && 'state' in part
      && (part.state === 'input-streaming' || part.state === 'input-available')) {
      const { output: _output, ...rest } = part as Record<string, unknown>
      return { ...rest, state: 'output-error', input: part.input ?? {}, errorText: TOOL_TEXT.cancelled } as AssistantUIMessagePart
    }
    return part
  })
}

/** Appends `suffix` to the last text part (`"<text> <suffix>"`), or as a text part of its own when the message doesn't end in text. */
export function appendToLastText(parts: AssistantUIMessagePart[], suffix: string): AssistantUIMessagePart[] {
  const last = parts.at(-1)
  if (last?.type === 'text' && last.text.trim() !== '') {
    return [...parts.slice(0, -1), { ...last, text: `${last.text.trimEnd()} ${suffix}`, state: 'done' }]
  }
  return [...parts, { type: 'text', text: suffix, state: 'done' }]
}

// --- The turn ---------------------------------------------------------------------

export interface AssistantTurnOptions {
  db: Db
  userId: string
  conversationId: string
  request: AssistantTurnRequest
  model: AssistantLanguageModel
  /** The interface language (reply language, saved fallback texts — ADR 0014). */
  locale: AppLocale
  /** The card language (card names, tool results — ADR 0015). */
  cardLocale: AppLocale
  /** Defaults to `getAssistantLimits()`. */
  limits?: AssistantLimits
  /** The client going away (a disconnect or "Abbrechen"): the turn stops and saves what it has, marked as cancelled. */
  signal?: AbortSignal
  /** The whole turn's deadline; defaults to 5 minutes. */
  turnTimeoutMs?: number
  /** Called once, after the answer is persisted (the endpoint releases the turn lock). */
  onSettled?: () => void
}

export interface AssistantTurn {
  /** The UI message stream (`createUIMessageStreamResponse`). */
  stream: ReadableStream<Chunk>
  /** Settles when the model work is over (not necessarily persisted yet). */
  done: Promise<void>
  /** The ids of the turn's user message (submit only) and assistant message. */
  userMessageId: string
  assistantMessageId: string
}

/**
 * Starts one turn. Everything that can fail with an HTTP error runs before
 * the stream exists and throws: 404 for a foreign conversation, 400 for a
 * regenerate without a user message, 409 `regenerate_not_allowed`. Then:
 * the user message is stored (submit; the title comes from the first
 * message, also when the turn fails later) or the answer to regenerate is
 * deleted, the empty assistant message is inserted, and the returned stream
 * runs the model. The answer's parts are persisted after every step and at
 * the end, with the fallback texts appended where needed; an answer with no
 * parts at all (a turn that failed right away) is deleted again.
 */
export function startAssistantTurn(options: AssistantTurnOptions): AssistantTurn {
  const { db, userId, conversationId, request, model, locale, cardLocale } = options
  const limits = options.limits ?? getAssistantLimits()
  const turnText = TURN_TEXT[locale]
  requireOwnConversation(db, userId, conversationId)

  let userRow: typeof assistantMessage.$inferSelect
  if (request.trigger === 'submit-message') {
    const isFirstMessage = !db.select({ id: assistantMessage.id }).from(assistantMessage)
      .where(eq(assistantMessage.conversationId, conversationId)).limit(1).get()
    userRow = persistUserMessage(db, {
      conversationId,
      id: chooseUserMessageId(db, request.clientMessageId),
      text: request.text,
      imageCount: request.images.length,
    })
    // Derived the moment the first message is stored, not after a successful
    // turn: a turn that fails right after this must not leave the
    // conversation titled "Neue Unterhaltung" forever.
    if (isFirstMessage && request.text !== '') {
      db.update(assistantConversation)
        .set({ title: conversationTitleFromText(request.text) })
        .where(eq(assistantConversation.id, conversationId))
        .run()
    }
  }
  else {
    userRow = deleteRegeneratableTail(db, conversationId)
  }

  // The model's history: the stored messages (the current one included),
  // with this turn's photos as real files in the current message only.
  const hasImages = request.images.length > 0
  const history = loadUiHistory(db, conversationId, limits)
    .map(message => message.id === userRow.id && hasImages
      ? {
          ...message,
          parts: [
            ...(request.text !== '' ? [{ type: 'text' as const, text: request.text }] : []),
            ...request.images.map(image => ({ type: 'file' as const, mediaType: image.mediaType, url: image.url })),
          ],
        }
      : message)

  const assistantId = randomUUID()
  const modelId = model.modelIdFor?.(hasImages) ?? model.id
  const placeholder = insertAssistantPlaceholder(db, { conversationId, id: assistantId, after: userRow.createdAt, model: modelId })
  const createdAt = placeholder.createdAt.toISOString()

  const instructions = buildSystemPrompt({ hasImages, locale, cardLocale })

  // A proposal's `data-action` part is written right after its tool call's
  // result chunk (the tool runs before that chunk is read), so the thread
  // always shows the chip first, then its proposal.
  const pendingActions = new Map<string, AssistantActionView[]>()
  const tools = buildAssistantToolSet({
    db,
    userId,
    cardLocale,
    conversationId,
    messageId: assistantId,
    limits,
    actionView: row => hydrateActionViews(db, userId, [row])[0]!,
    deckName: deckId => resolveDeckNames(db, userId, [deckId]).get(deckId),
    onAction: (toolCallId, view) => pendingActions.set(toolCallId, [...(pendingActions.get(toolCallId) ?? []), view]),
    // An earlier proposal's new preview (#148): replaces its view if that
    // isn't written yet, else goes out after this call's result, where the
    // `data-action` part with the same id replaces the earlier one.
    onActionUpdated: (toolCallId, view) => {
      for (const views of pendingActions.values()) {
        const index = views.findIndex(queued => queued.id === view.id)
        if (index >= 0) {
          views[index] = view
          return
        }
      }
      pendingActions.set(toolCallId, [...(pendingActions.get(toolCallId) ?? []), view])
    },
  })

  const clientSignal = options.signal ?? new AbortController().signal
  const deadline = new AbortController()
  const deadlineTimer = setTimeout(() => deadline.abort(new DOMException('Turn timeout', 'TimeoutError')), options.turnTimeoutMs ?? TURN_TIMEOUT_MS)
  const abortSignal = AbortSignal.any([clientSignal, deadline.signal])

  let settled = false
  const settle = () => {
    if (!settled) {
      settled = true
      clearTimeout(deadlineTimer)
      options.onSettled?.()
    }
  }

  let resolveDone: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  // 'tools-ignored': the model called a tool on a step where tools were
  // switched off (#54); the SDK ends the run with a ToolChoiceViolationError.
  type RunStatus = 'done' | 'error' | 'cancelled' | 'timeout' | 'tools-ignored'

  async function runModel(writer: UIMessageStreamWriter<AssistantUIMessage>, fields: {
    instructions: string
    messages: ModelMessage[]
    maxSteps: number
    sendStart: boolean
  }): Promise<{ status: RunStatus, steps: Steps, responseMessages: ModelMessage[] }> {
    const result = streamText({
      model: model.modelFor(hasImages),
      instructions: fields.instructions,
      messages: fields.messages,
      tools,
      toolChoice: 'auto',
      stopWhen: [isStepCount(fields.maxSteps), repeatedToolFailure(ASSISTANT_REPEATED_TOOL_FAILURE_LIMIT), proposalEndsTurn()],
      prepareStep: assistantPrepareStep,
      timeout: { stepMs: limits.timeoutMs },
      abortSignal,
      maxRetries: 2,
      ...(model.providerOptions ? { providerOptions: model.providerOptions } : {}),
      headers: { 'x-opencode-session': conversationId },
      // The client gets the error as a code, with the provider's hint for a model setup problem (`assistantStreamErrorText`, #124); the log keeps the cause.
      onError: ({ error }) => {
        if (isToolsOffViolation(error)) return
        console.warn(`[assistant] model call failed (${assistantErrorCode(error)}):`, error instanceof Error ? error.message : error)
      },
    })

    let status: RunStatus = 'done'
    let toolsIgnored = false
    const uiStream = result.toUIMessageStream<AssistantUIMessage>({
      sendReasoning: true,
      sendStart: fields.sendStart,
      sendFinish: false,
      generateMessageId: () => assistantId,
      messageMetadata: ({ part }) => part.type === 'start' ? { createdAt, model: modelId } : undefined,
      onError: (error) => {
        if (isToolsOffViolation(error)) toolsIgnored = true
        return assistantStreamErrorText(error)
      },
    })
    for await (const chunk of uiStream) {
      if (chunk.type === 'abort') {
        if (clientSignal.aborted) {
          status = 'cancelled'
          writer.write(chunk)
        }
        else if (deadline.signal.aborted) {
          status = 'timeout'
        }
        else {
          // A single model call ran into `limits.timeoutMs` (the SDK's step timeout).
          status = 'error'
          writer.write({ type: 'error', errorText: 'assistant_unreachable' })
        }
        continue
      }
      if (chunk.type === 'error') {
        if (toolsIgnored) {
          // Not a model failure: the turn ends with the repeated-failure text.
          status = 'tools-ignored'
          continue
        }
        status = 'error'
      }
      if (chunk.type === 'tool-input-error') {
        // An invalid call (unparseable or empty input). The SDK would store
        // its input on the part as the deprecated `rawInput` (and warn about
        // it on every read); as an available input followed by the
        // `tool-output-error` chunk the SDK sends for the same call, the part
        // ends up the same, with the input in `input`.
        const { errorText: _errorText, dynamic: _dynamic, ...call } = chunk
        writer.write({ ...call, type: 'tool-input-available' })
        continue
      }
      writer.write(chunk)
      if (chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error') {
        for (const view of pendingActions.get(chunk.toolCallId) ?? []) {
          writer.write({ type: 'data-action', id: view.id, data: view })
        }
        pendingActions.delete(chunk.toolCallId)
      }
    }

    if (status !== 'done') {
      return { status, steps: [], responseMessages: [] }
    }
    try {
      return { status, steps: await result.steps, responseMessages: await result.responseMessages }
    }
    catch (error) {
      writer.write({ type: 'error', errorText: assistantErrorText(error) })
      return { status: 'error', steps: [], responseMessages: [] }
    }
  }

  function writeText(writer: UIMessageStreamWriter<AssistantUIMessage>, text: string) {
    const id = `note-${randomUUID()}`
    writer.write({ type: 'text-start', id })
    writer.write({ type: 'text-delta', id, delta: text })
    writer.write({ type: 'text-end', id })
  }

  function persist(parts: AssistantUIMessagePart[]) {
    if (isEmptyAssistantParts(parts)) {
      deleteAssistantMessage(db, assistantId)
    }
    else {
      updateAssistantMessage(db, assistantId, parts)
    }
  }

  const stream = createUIMessageStream<AssistantUIMessage>({
    generateId: () => assistantId,
    originalMessages: history,
    onError: assistantErrorText,
    execute: async ({ writer }) => {
      try {
        const modelMessages = pruneMessages({
          messages: await convertToModelMessages<AssistantUIMessage>(history, { tools, ignoreIncompleteToolCalls: true }),
          reasoning: 'all',
          emptyMessages: 'remove',
        })

        let run = await runModel(writer, { instructions, messages: modelMessages, maxSteps: limits.maxToolRounds, sendStart: true })

        // One corrective continuation when the answer wrote a tool call as
        // text instead of making it (#54) — never a second one.
        const last = run.steps.at(-1)
        if (run.status === 'done' && last && !stepHadToolCalls(last) && last.finishReason !== 'length'
          && detectTextWrittenToolCall(last.text)) {
          run = await runModel(writer, {
            instructions: `${instructions}\n\n${TOOL_TEXT.textWrittenToolCallHint}`,
            messages: [...modelMessages, ...run.responseMessages],
            maxSteps: Math.max(1, limits.maxToolRounds - run.steps.length),
            sendStart: false,
          })
        }

        if (run.status === 'timeout') {
          writeText(writer, turnText.timeout)
          writer.write({ type: 'finish', finishReason: 'other' })
          return
        }
        if (run.status === 'tools-ignored') {
          writeText(writer, turnText.repeatedToolFailure)
          writer.write({ type: 'finish', finishReason: 'stop' })
          return
        }
        if (run.status !== 'done') {
          return
        }
        const fallback = fallbackText(run.steps, turnText)
        if (fallback !== null) {
          writeText(writer, fallback)
        }
        const finishReason: FinishReason = run.steps.at(-1)?.finishReason ?? 'other'
        writer.write({ type: 'finish', finishReason })
      }
      finally {
        resolveDone()
      }
    },
    onStepEnd: ({ responseMessage }) => {
      updateAssistantMessage(db, assistantId, responseMessage.parts)
    },
    onEnd: ({ responseMessage, isAborted, isCancelled }) => {
      try {
        let parts: AssistantUIMessagePart[] = [...responseMessage.parts]
        // Proposals whose tool result never reached the stream (the turn
        // ended in between) still belong to this answer; a newer view of a
        // proposal already in the parts replaces it.
        for (const views of pendingActions.values()) {
          for (const view of views) {
            const index = parts.findIndex(part => part.type === 'data-action' && part.id === view.id)
            const part = { type: 'data-action' as const, id: view.id, data: view }
            if (index >= 0) {
              parts[index] = part
            }
            else {
              parts.push(part)
            }
          }
        }
        pendingActions.clear()
        parts = finalizeParts(parts)
        if (isAborted || isCancelled) {
          parts = appendToLastText(parts, turnText.cancelledSuffix)
        }
        persist(parts)
        touchConversation(db, conversationId)
      }
      finally {
        settle()
      }
    },
  })

  return { stream, done, userMessageId: userRow.id, assistantMessageId: assistantId }
}
