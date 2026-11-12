import fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { parse } from 'smol-toml'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const TIMEOUT_MS = 850
const COOLDOWN_MS = 30_000
const inside = (root, path) => {
  const child = relative(resolve(root), resolve(path))
  return !child.startsWith('..') && !isAbsolute(child)
}

/** Credentials stay in the main process; reuse only the selected vault's local integrations. */
export async function loadHarnessSearchConfig({ obsidianVaultPath = '', harnessPath = '' } = {}) {
  const selected = obsidianVaultPath || harnessPath
  if (!selected) return null
  let servers = {}
  try {
    const config = await fs.readFile(
      join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
      'utf8'
    )
    servers = parse(config).mcp_servers || {}
  } catch {
    /* Optional: the application also works without Codex installed. */
  }
  const configuredVault = servers['obsidian-fs']?.args?.find((arg) => isAbsolute(arg))
  // Global MCP/Omnisearch instances serve one vault. Do not mix in an unselected vault.
  const sameVault = configuredVault && inside(configuredVault, selected)
  const vault = sameVault ? configuredVault : resolve(selected)
  let plugin = {}
  try {
    plugin = JSON.parse(
      await fs.readFile(join(vault, '.obsidian/plugins/obsidian-local-rest-api/data.json'), 'utf8')
    )
  } catch {
    /* No REST plugin in this vault. */
  }
  const mcp = sameVault ? servers.obsidian : null
  const omni = sameVault ? servers['obsidian-omnisearch'] : null
  const restUrl =
    process.env.HARNESS_REST_URL ||
    (plugin.enableInsecureServer ? `http://127.0.0.1:${plugin.insecurePort || 27123}` : '')
  return {
    vault,
    selected: resolve(selected),
    mcp: process.env.HARNESS_MCP_URL
      ? {
          url: process.env.HARNESS_MCP_URL,
          http_headers: process.env.HARNESS_API_KEY
            ? { Authorization: `Bearer ${process.env.HARNESS_API_KEY}` }
            : {}
        }
      : mcp,
    omni,
    restUrl,
    apiKey: process.env.HARNESS_API_KEY || plugin.apiKey,
    cooldown: new Map()
  }
}

function unpack(result) {
  if (result.isError) throw new Error('MCP search failed')
  if (result.structuredContent) return result.structuredContent
  return JSON.parse(
    result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
  )
}

async function mcpSearch(config, query, signal, omnisearch = false) {
  const settings = omnisearch ? config.omni : config.mcp
  if (!settings) throw new Error('Not configured')
  const client = new Client({ name: 'meeting-copilot-search', version: '1.0.0' })
  const transport = settings.url
    ? new StreamableHTTPClientTransport(new URL(settings.url), {
        requestInit: { headers: settings.http_headers || {} },
        fetch: (url, init) => fetch(url, { ...init, signal }),
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 0,
          maxReconnectionDelay: 0,
          reconnectionDelayGrowFactor: 1
        }
      })
    : new StdioClientTransport({
        command: settings.command === 'node' ? process.execPath : settings.command,
        args: settings.args || [],
        env: { ...process.env, ...settings.env, ELECTRON_RUN_AS_NODE: '1' },
        stderr: 'ignore'
      })
  const close = () => {
    client.close().catch(() => {})
  }
  signal.addEventListener('abort', close, { once: true })
  try {
    signal.throwIfAborted()
    await client.connect(transport)
    signal.throwIfAborted()
    return unpack(
      await client.callTool(
        {
          name: omnisearch ? 'omnisearch' : 'search_simple',
          arguments: omnisearch
            ? { query, maxResults: 6, includeExcerpt: true }
            : { query, contextLength: 650 }
        },
        undefined,
        { signal, timeout: TIMEOUT_MS }
      )
    )
  } finally {
    signal.removeEventListener('abort', close)
    await client.close()
  }
}

async function restSearch(config, query, signal) {
  if (!config.restUrl || !config.apiKey) throw new Error('Not configured')
  const url = new URL('search/simple/', `${config.restUrl.replace(/\/$/, '')}/`)
  url.searchParams.set('query', query)
  url.searchParams.set('contextLength', '650')
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal
  })
  if (!response.ok) throw new Error('REST search failed')
  return response.json()
}

function excerptsFrom(data, config, limit) {
  const rows = Array.isArray(data) ? data : data?.results
  if (!Array.isArray(rows)) return []
  return rows
    .flatMap((row) => {
      const file = row.path || row.filename
      if (typeof file !== 'string') return []
      const path = resolve(config.vault, file)
      if (!inside(config.selected, path)) return []
      const content =
        row.excerpt ||
        row.matches
          ?.map((match) => match.context)
          .filter(Boolean)
          .join('\n')
      return typeof content === 'string' && content.trim()
        ? [{ path, source: config.vault, content: content.slice(0, 1700) }]
        : []
    })
    .slice(0, limit)
}

/** Race the available integrations under one deadline, then keep the local index as fallback. */
export async function searchHarness(query, { config, signal, limit = 4 } = {}) {
  if (!config || signal?.aborted) return []
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, TIMEOUT_MS)
  const providers = [
    ['mcp', config.mcp, () => mcpSearch(config, query, controller.signal)],
    ['omnisearch', config.omni, () => mcpSearch(config, query, controller.signal, true)],
    ['rest', config.restUrl && config.apiKey, () => restSearch(config, query, controller.signal)]
  ].filter(([name, enabled]) => enabled && (config.cooldown.get(name) || 0) <= Date.now())
  try {
    if (!providers.length) return []
    const deadline = new Promise((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(new Error('Search cancelled')), {
        once: true
      })
    )
    return await Promise.race([
      deadline,
      Promise.any(
        providers.map(async ([name, , run]) => {
          try {
            const results = excerptsFrom(await run(), config, limit)
            if (!results.length) throw new Error('No matches')
            return results
          } catch (error) {
            if (!controller.signal.aborted && error.message !== 'No matches')
              config.cooldown.set(name, Date.now() + COOLDOWN_MS)
            throw error
          }
        })
      )
    ])
  } catch {
    // Slow providers are skipped briefly too, so every question does not pay for an outage.
    if (controller.signal.aborted && !signal?.aborted) {
      for (const [name] of providers) config.cooldown.set(name, Date.now() + COOLDOWN_MS)
    }
    return []
  } finally {
    clearTimeout(timer)
    controller.abort()
    signal?.removeEventListener('abort', abort)
  }
}
