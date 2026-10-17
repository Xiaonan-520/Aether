/**
 * OpenAI ChatCompletion request parsing: client JSON → canonical ChatRequest.
 * Validation errors are raised as OpenAIApiError so the HTTP layer can return
 * a proper 400 in OpenAI error format.
 */
import { z } from 'zod'
import type { ChatMessage, ChatRequest, Tool } from '../../core/types.js'

export class OpenAIApiError extends Error {
  readonly status: number
  readonly type: string
  readonly code?: string

  constructor(status: number, type: string, message: string, code?: string) {
    super(message)
    this.name = 'OpenAIApiError'
    this.status = status
    this.type = type
    this.code = code
  }
}

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function').default('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string().default(''),
  }),
})

/**
 * OpenAI "content part". Clients such as the Pi agent send the standard
 * multimodal array form (`content: [{ type: 'text', text: '...' }]`) instead of
 * a bare string, so the array shape must be accepted here rather than being
 * rejected by validation.
 */
const contentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  // Image parts are part of the OpenAI schema; the canonical model is
  // text-only, so these are rejected at conversion time with a clear error
  // instead of being silently dropped.
  z.object({ type: z.literal('image_url'), image_url: z.union([z.string(), z.object({ url: z.string() }).passthrough()]) }),
  // Any other part type must still be a well-formed object with a string
  // `type`. A part claiming `type: 'text'` is refused here so that a malformed
  // text part (e.g. `text: 42`) fails validation instead of being swallowed by
  // this catch-all and then silently dropped.
  z
    .object({ type: z.string() })
    .passthrough()
    .refine((p) => p.type !== 'text', {
      message: 'a "text" content part must have a string "text" field',
    }),
])

const messageSchema = z.object({
  // 'developer' is the OpenAI instruction role (GPT-5 family). The canonical
  // ChatMessage has no developer role: it is normalized to 'system' below,
  // preserving content, order and name — the client instruction semantics
  // survive as a system message.
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z
    .union([z.string(), z.array(contentPartSchema), z.null()])
    .optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
})

/**
 * Flatten an OpenAI `content` value into the canonical text form.
 *
 * - `string` / `null` → as-is (null becomes '').
 * - `ContentPart[]` → text parts are concatenated in order; `image_url` and any
 *   other unknown part type raise a 400 because the canonical model is
 *   text-only and silently dropping content would be worse than failing.
 */
function flattenContent(
  content: z.infer<typeof messageSchema>['content'],
  index: number,
  role: string,
): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  const texts: string[] = []
  for (const part of content) {
    if (part.type === 'text') {
      texts.push((part as { text: string }).text)
      continue
    }
    throw new OpenAIApiError(
      400,
      'invalid_request_error',
      `messages.${index}.content: unsupported content part type ${JSON.stringify(part.type)} for role ${role}; only "text" parts are supported`,
      'unsupported_content_part',
    )
  }
  return texts.join('')
}

const toolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  }),
})

const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  reasoning_effort: z.string().optional(),
  tools: z.array(toolSchema).optional(),
})

/** OpenAI message → canonical ChatMessage. */
function toCanonicalMessage(m: z.infer<typeof messageSchema>, index: number): ChatMessage {
  return {
    role: m.role === 'developer' ? 'system' : m.role,
    content: flattenContent(m.content, index, m.role),
    name: m.name,
    toolCalls: m.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
    toolCallId: m.tool_call_id,
  }
}

function toCanonicalTool(t: z.infer<typeof toolSchema>): Tool {
  return {
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters ?? {},
  }
}

export function parseChatCompletionsRequest(body: unknown): ChatRequest {
  const parsed = chatRequestSchema.safeParse(body)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new OpenAIApiError(400, 'invalid_request_error', detail)
  }
  const v = parsed.data
  return {
    model: v.model,
    messages: v.messages.map((m, i) => toCanonicalMessage(m, i)),
    stream: v.stream,
    maxTokens: v.max_tokens,
    temperature: v.temperature,
    reasoningEffort: v.reasoning_effort,
    tools: v.tools?.map(toCanonicalTool),
  }
}
