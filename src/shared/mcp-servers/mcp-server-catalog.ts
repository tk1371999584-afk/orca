// The servers "Add an MCP server" lists on desktop and phone: the vendors' MCP apps bots use, plus
// the two that bots reach through Orca's own connectors instead (GitHub, Linear).
import { BOT_MCP_APPS, type BotMcpApp } from '../bots/bot-mcp-apps'

export type McpServerCatalogCategory = 'coding' | 'chat' | 'monitoring' | 'docs' | 'more'

export const MCP_SERVER_CATALOG_CATEGORIES: readonly McpServerCatalogCategory[] = [
  'coding',
  'chat',
  'monitoring',
  'docs',
  'more'
]

/** With `headers`, the server takes a token: Add opens Custom server prefilled instead of adding it. */
export type McpServerCatalogEntry = Omit<BotMcpApp, 'category' | 'composio'> & {
  category: McpServerCatalogCategory
  headers?: readonly { key: string; value: string }[]
}

const GITHUB: McpServerCatalogEntry = {
  id: 'github',
  name: 'GitHub',
  line: 'Issues, pull requests and code search',
  url: 'https://api.githubcopilot.com/mcp/',
  signIn: 'none',
  headers: [{ key: 'Authorization', value: 'Bearer ' }],
  category: 'coding'
}

const LINEAR: McpServerCatalogEntry = {
  id: 'linear',
  name: 'Linear',
  line: 'Read and update issues and projects',
  url: 'https://mcp.linear.app/mcp',
  signIn: 'browser',
  category: 'docs'
}

function catalogEntry({ category, composio: _composio, ...app }: BotMcpApp): McpServerCatalogEntry {
  const named = MCP_SERVER_CATALOG_CATEGORIES as readonly string[]
  return { ...app, category: named.includes(category) ? (category as McpServerCatalogCategory) : 'more' }
}

export const MCP_SERVER_CATALOG: readonly McpServerCatalogEntry[] = [
  GITHUB,
  ...BOT_MCP_APPS.map(catalogEntry).flatMap((entry) =>
    entry.id === 'atlassian' ? [LINEAR, entry] : [entry]
  )
]
