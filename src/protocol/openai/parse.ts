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

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
})

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
function toCanonicalMessage(m: z.infer<typeof messageSchema>): ChatMessage {
  return {
    role: m.role,
    content: m.content ?? '',
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
    messages: v.messages.map(toCanonicalMessage),
    stream: v.stream,
    maxTokens: v.max_tokens,
    temperature: v.temperature,
    reasoningEffort: v.reasoning_effort,
    tools: v.tools?.map(toCanonicalTool),
  }
}
