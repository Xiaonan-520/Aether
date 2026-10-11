/**
 * Model discovery. Live discovery is preferred (`/console/enterprises/personal/
 * models` then `/v3/config`); the short-lived result cache is used only when the
 * upstream is unavailable. A static fallback catalog is returned labelled as
 * such, never passed off as live data.
 */
import type { ProtocolModelInfo } from '../../protocol/types.js'
import type { Store, Credential } from '../../storage/store.js'
import type { UpstreamClient } from './client.js'
import {
  CONFIG_PATH,
  SCOPED_MODELS_PATH,
} from './paths.js'
import {
  mergeRemoteModels,
  parseModelsFromConfig,
  toModelDescriptor,
  fallbackModels,
  type RemoteModel,
} from './parsing.js'

/** How long a live discover result is trusted before a fresh fetch is attempted. */
export const MODEL_CACHE_TTL_MS = 10 * 60 * 1000

export interface DiscoveredModels {
  models: ProtocolModelInfo[]
  source: 'live' | 'cached' | 'fallback'
  fetchError?: string
}

/**
 * Discover models for a given account. Returns a list with a provenance tag.
 */
export async function discoverModels(
  client: UpstreamClient,
  store: Store,
  accountId: string,
): Promise<DiscoveredModels> {
  const credential = store.getCredential(accountId)
  if (!credential) {
    // Not authenticated yet — offer the static catalog clearly labelled as fallback.
    return { models: fallbackModels(), source: 'fallback' }
  }

  try {
    const remote = await fetchRemoteModels(client, credential)
    const descriptors = remote.map(toModelDescriptor)
    if (descriptors.length === 0) {
      // Live response had no usable chat models — do not fabricate.
      return { models: fallbackModels(), source: 'fallback', fetchError: 'live discovery returned no chat models' }
    }
    store.putModelCache(JSON.stringify(descriptors))
    return { models: descriptors, source: 'live' }
  } catch (error) {
    // Short-term cache fallback, clearly distinguished from live data.
    const cache = store.getModelCache()
    if (cache && Date.now() - cache.fetchedAt < MODEL_CACHE_TTL_MS) {
      try {
        const parsed = JSON.parse(cache.payload) as ProtocolModelInfo[]
        if (Array.isArray(parsed) && parsed.length > 0) {
          return { models: parsed, source: 'cached' }
        }
      } catch {
        // fall through to fallback catalog
      }
    }
    return {
      models: fallbackModels(),
      source: 'fallback',
      fetchError: error instanceof Error ? error.message : String(error),
    }
  }
}

async function fetchRemoteModels(
  client: UpstreamClient,
  credential: Credential,
): Promise<RemoteModel[]> {
  // Scoped catalog first (richest), then /v3/config; merge union.
  let primary: RemoteModel[] = []
  let extra: RemoteModel[] = []
  let primaryOk = false
  try {
    const scoped = await client.fetchConfig(credential, SCOPED_MODELS_PATH)
    if (scoped.status === 200) {
      const parsed = parseModelsFromConfig(scoped.body)
      if (parsed.length > 0) {
        primary = parsed
        primaryOk = true
      }
    }
  } catch {
    primary = []
  }

  try {
    const config = await client.fetchConfig(credential, CONFIG_PATH)
    if (config.status === 200) {
      extra = parseModelsFromConfig(config.body)
    }
  } catch {
    extra = []
  }

  if (primaryOk) return mergeRemoteModels(primary, extra)
  return extra
}