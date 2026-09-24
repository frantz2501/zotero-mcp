#!/usr/bin/env node
/**
 * zotero-mcp - zero-dependency MCP server for the Zotero Web API v3
 * Docs: https://www.zotero.org/support/dev/web_api/v3/basics
 *
 * Transports / modes:
 *   stdio (default)   - for local MCP clients (Vibe CLI, Claude Desktop, ...)
 *                       automatic when stdin is piped (or --stdio)
 *   http  (--http)    - for a persistent remote deployment (systemd)
 *   local app (--local) - run directly in a terminal: serves HTTP on
 *                       http://127.0.0.1:3334 with a friendly banner.
 *                       Automatic when stdin is a TTY (a human ran it).
 *
 * Node >= 18. No dependencies.
 *
 * Config priority: environment variables > zotero-mcp.json > defaults.
 * The config file is searched next to server.js, then in the working
 * directory, then in %APPDATA%\zotero-mcp\config.json.
 *
 * Env (config key):
 *   ZOTERO_API_KEY                        (apiKey)   recommended - zotero.org > Settings > API keys
 *   ZOTERO_USER_ID                        (userId)   optional - numeric id, auto-detected from the key
 *   ZOTERO_API_BASE                       (apiBase)  default https://api.zotero.org
 *                                                    (local Zotero: http://localhost:23119/api)
 *   ZOTERO_MCP_PORT                       (port)     default 3334
 *   ZOTERO_MCP_BIND                       (bind)     default 127.0.0.1
 *   ZOTERO_MCP_HTTP_TOKEN                 (httpToken) recommended when not on localhost
 *
 * Without an API key, public libraries can still be read (pass user_id /
 * group_id in the tool calls).
 */
'use strict';

import readline from 'node:readline';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'zotero-mcp', version: '1.0.0' };

// --- Local app config file (env vars always win over file values)
function loadConfigFile() {
  const candidates = [];
  try { candidates.push(path.join(path.dirname(process.argv[1] || ''), 'zotero-mcp.json')); } catch {}
  candidates.push(path.join(process.cwd(), 'zotero-mcp.json'));
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'zotero-mcp', 'config.json'));
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return { path: p, cfg: JSON.parse(fs.readFileSync(p, 'utf8')) };
    } catch (e) {
      console.error('zotero-mcp: invalid config file ' + p + ': ' + (e.message || e));
    }
  }
  return { path: null, cfg: {} };
}
const { path: CONFIG_PATH, cfg: CONFIG } = loadConfigFile();

// env var if set, else config key, else undefined
function pick(envKey, cfgKeys) {
  const v = process.env[envKey];
  if (v !== undefined && v !== '') return v;
  for (const k of cfgKeys) {
    const cv = CONFIG[k];
    if (cv !== undefined && cv !== null && cv !== '') return String(cv);
  }
  return undefined;
}

const API_BASE = (pick('ZOTERO_API_BASE', ['apiBase', 'api_base']) || 'https://api.zotero.org').replace(/\/$/, '');
const API_KEY = pick('ZOTERO_API_KEY', ['apiKey', 'api_key', 'key']) || '';
const USER_ID = pick('ZOTERO_USER_ID', ['userId', 'user_id']);
const MAX_WRITE_OBJECTS = 50;
const MAX_PAGES = 50; // safety cap for all_pages (50 x 100 items)

// --- Zotero HTTP client -----------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
let backoffUntil = 0; // Zotero "Backoff" header honored across requests
let lastMeta = { url: null, totalResults: null, libraryVersion: null, link: null };

const STATUS_REASONS = {
  400: 'bad request',
  401: 'unauthorized (missing/invalid API key)',
  403: 'forbidden (key lacks access to this library)',
  404: 'not found',
  409: 'library locked (conflict)',
  412: 'precondition failed (outdated version or reused Zotero-Write-Token)',
  413: 'too many objects in one request',
  428: 'precondition required (If-Unmodified-Since-Version missing)',
  429: 'rate limited',
  500: 'Zotero server error',
  503: 'service unavailable',
};

class ZoteroApiError extends Error {
  constructor(status, method, where, text) {
    const reason = STATUS_REASONS[status] || '';
    const detail = text ? ' - ' + String(text).slice(0, 400) : '';
    super('Zotero API ' + status + ' on ' + method + ' ' + where + ': ' + reason + detail);
    this.status = status;
  }
}

async function httpSend(url, method, { headers = {}, body } = {}) {
  const wait = backoffUntil - Date.now();
  if (wait > 0) await sleep(wait);
  const h = { 'Zotero-API-Version': '3', Accept: 'application/json', ...headers };
  if (API_KEY) h['Zotero-API-Key'] = API_KEY;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  let res;
  let attempt = 0;
  for (;;) {
    res = await fetch(url, {
      method, headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 2 ** attempt * 1000);
      attempt++;
      continue;
    }
    break;
  }
  const resHeaders = {};
  res.headers.forEach((v, k) => { resHeaders[k] = v; });
  const text = await res.text();
  const bo = num(resHeaders['backoff']);
  if (bo !== null && bo > 0) backoffUntil = Date.now() + bo * 1000;
  lastMeta = {
    url: String(url),
    totalResults: num(resHeaders['total-results']),
    libraryVersion: num(resHeaders['last-modified-version']),
    link: resHeaders['link'] || null,
  };
  return { status: res.status, headers: resHeaders, text };
}

async function zapi(method, zpath, { query, headers, body } = {}) {
  const url = new URL(API_BASE + zpath);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (v === true) url.searchParams.set(k, '1');
    else if (v === false) url.searchParams.set(k, '0');
    else if (Array.isArray(v)) { for (const item of v) url.searchParams.append(k, String(item)); }
    else url.searchParams.set(k, String(v));
  }
  const res = await httpSend(url, method, { headers, body });
  if (res.status === 304) throw new ZoteroApiError(304, method, zpath, 'not modified');
  if (res.status >= 400) throw new ZoteroApiError(res.status, method, zpath, res.text);
  if (!res.text) return null;
  let data;
  try { data = JSON.parse(res.text); } catch { data = res.text; }
  return data;
}

function linkRel(link, rel) {
  if (!link) return null;
  const re = /<([^>]+)>\s*;\s*rel="?(next|prev|first|last|alternate)"?/g;
  let m;
  while ((m = re.exec(link))) if (m[2] === rel) return m[1];
  return null;
}

// Multi-page fetch: follows Link rel="next" up to MAX_PAGES pages.
async function zapiAll(zpath, { query, maxPages = MAX_PAGES } = {}) {
  const first = await zapi('GET', zpath, { query: { limit: 100, ...(query || {}) } });
  const firstMeta = { ...lastMeta };
  const items = Array.isArray(first) ? [...first] : [first];
  let next = linkRel(firstMeta.link, 'next');
  let pages = 1;
  while (next && pages < maxPages) {
    const res = await httpSend(new URL(next), 'GET');
    if (res.status >= 400) throw new ZoteroApiError(res.status, 'GET', next, res.text);
    let d;
    try { d = JSON.parse(res.text); } catch { d = res.text; }
    if (Array.isArray(d)) items.push(...d); else items.push(d);
    next = linkRel(lastMeta.link, 'next');
    pages++;
  }
  return { items, truncated: Boolean(next), totalResults: firstMeta.totalResults };
}

// --- Library prefix: user (default) or group ---------------------------------

let detectedUserId = null;

async function libPrefix(a = {}) {
  if (a.group_id) return '/groups/' + a.group_id;
  let uid = a.user_id ?? USER_ID ?? detectedUserId;
  if (uid === undefined || uid === null || uid === '') {
    if (!API_KEY) {
      throw new Error(
        'No API key configured: pass group_id (public groups), user_id, ' +
        'or set ZOTERO_API_KEY.',
      );
    }
    const info = await zapi('GET', '/keys/current');
    detectedUserId = info.userID;
    uid = detectedUserId;
  }
  return '/users/' + uid;
}

// --- Write helpers (version preconditions handled automatically) -------------

async function libraryVersion(prefix) {
  await zapi('GET', prefix + '/items', { query: { format: 'keys', limit: 1 } });
  if (!lastMeta.libraryVersion) throw new Error('Missing Last-Modified-Version header.');
  return lastMeta.libraryVersion;
}

// POST a batch of objects (create or multi-update). Prefers the versioned
// flow; falls back to a Zotero-Write-Token when the key cannot read the
// library (write-only key).
async function writePost(zpath, objects) {
  if (!Array.isArray(objects) || objects.length === 0) {
    throw new Error('Provide a non-empty array of objects.');
  }
  if (objects.length > MAX_WRITE_OBJECTS) {
    throw new Error('Zotero accepts at most ' + MAX_WRITE_OBJECTS + ' objects per request.');
  }
  const headers = {};
  try {
    const version = await libraryVersion(zpath.prefix);
    headers['If-Unmodified-Since-Version'] = String(version);
  } catch (e) {
    if (e.status !== 403) throw e;
    headers['Zotero-Write-Token'] = crypto.randomBytes(16).toString('hex');
  }
  const body = await zapi('POST', zpath.prefix + zpath.suffix, { headers, body: objects });
  return writeResult(body);
}

function writeResult(body) {
  return {
    successful: body?.successful || body?.success || {},
    unchanged: body?.unchanged || {},
    failed: body?.failed || {},
    library_version: lastMeta.libraryVersion,
  };
}

// --- Schemas -----------------------------------------------------------------

const s = (type, description, extra = {}) => ({ type, description, ...extra });

const libProps = {
  group_id: s('integer', 'Zotero group library id. Omit to use your user library.'),
  user_id: s('integer', 'User id override (default: the API key owner). Public reads work without a key.'),
};

const itemQueryProps = {
  q: s('string', 'Quick search: matches title/creator/year, or full text with qmode=everything'),
  qmode: s('string', 'Search mode', { enum: ['titleCreatorYear', 'everything'] }),
  tag: s('string', 'Tag filter, boolean syntax allowed: "foo || bar", "-foo"'),
  itemType: s('string', 'Item type filter, e.g. "journalArticle", "book || thesis", "-attachment"'),
  includeTrashed: s('boolean', 'Include trashed items'),
  since: s('integer', 'Only objects modified after this library version (incremental sync)'),
  sort: s('string', 'Sort field: dateAdded, dateModified, title, creator, itemType, date, publisher, ...'),
  direction: s('string', 'Sort direction', { enum: ['asc', 'desc'] }),
  limit: s('integer', 'Page size, 1-100 (default 25)'),
  start: s('integer', 'Index of the first result (offset)'),
};

const allPagesProp = s(
  'boolean',
  'Follow pagination and return everything (pages of 100, capped at ' + MAX_PAGES + ' pages)',
);

// Query params forwarded to the Zotero API (tool-only args are stripped).
const QUERY_KEYS = [
  'q', 'qmode', 'tag', 'itemType', 'itemKey', 'includeTrashed', 'since',
  'sort', 'direction', 'limit', 'start', 'include', 'style', 'locale',
  'linkwrap', 'format',
];
function pickQuery(a, extras = {}) {
  const q = {};
  for (const k of QUERY_KEYS) if (a[k] !== undefined) q[k] = a[k];
  Object.assign(q, extras);
  return q;
}

const EXPORT_FORMATS = [
  'bibtex', 'biblatex', 'csljson', 'ris', 'csv', 'mods', 'refer', 'tei',
  'wikipedia', 'bookmarks', 'coins', 'rdf_zotero', 'rdf_dc', 'rdf_bibliontology',
];

// --- Tools -------------------------------------------------------------------

const tools = {
  zotero_health: {
    description:
      'Check API connectivity and report the API key privileges (userID, username, ' +
      'read/write access per library). Call this first when debugging authentication.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      if (!API_KEY) {
        await zapi('GET', '/items/new', { query: { itemType: 'book' } });
        return { ok: true, mode: 'public (no API key configured)', apiBase: API_BASE };
      }
      const info = await zapi('GET', '/keys/current');
      return {
        ok: true,
        apiBase: API_BASE,
        key: {
          key: info.key, userID: info.userID, username: info.username,
          version: info.version, access: info.access,
        },
      };
    },
  },

  zotero_search_items: {
    description:
      'Search items in a library (q + filters). Best way to find item keys ' +
      '(8-character uppercase, e.g. "X42A7DEE") for get/update/delete/export tools.',
    inputSchema: {
      type: 'object',
      properties: {
        ...libProps,
        ...itemQueryProps,
        collection: s('string', 'Restrict the search to this collection key'),
      },
      required: ['q'],
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      const zpath = a.collection
        ? prefix + '/collections/' + a.collection + '/items'
        : prefix + '/items';
      const items = await zapi('GET', zpath, { query: pickQuery(a) });
      return {
        totalResults: lastMeta.totalResults,
        count: Array.isArray(items) ? items.length : 1,
        items,
      };
    },
  },

  zotero_list_items: {
    description:
      'List items of a library (all, top-level, trash or My Publications) or of a ' +
      'collection, with sorting, pagination and incremental sync (since). ' +
      'format=json by default; use keys/versions for light weight.',
    inputSchema: {
      type: 'object',
      properties: {
        ...libProps,
        top: s('boolean', 'Only top-level items (exclude child notes/attachments)'),
        trash: s('boolean', 'Items in the trash'),
        publications: s('boolean', 'Items in "My Publications"'),
        collection: s('string', 'List items of this collection key instead of the whole library'),
        ...itemQueryProps,
        format: s('string', 'json (default) / keys / versions', { enum: ['json', 'keys', 'versions'] }),
        all_pages: allPagesProp,
      },
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      let zpath;
      if (a.collection) zpath = prefix + '/collections/' + a.collection + '/items' + (a.top ? '/top' : '');
      else if (a.publications) zpath = prefix + '/publications/items';
      else if (a.trash) zpath = prefix + '/items/trash';
      else zpath = prefix + '/items' + (a.top ? '/top' : '');
      if (a.all_pages) {
        const { items, truncated, totalResults } = await zapiAll(zpath, { query: pickQuery(a) });
        return { count: items.length, truncated, totalResults, items };
      }
      const data = await zapi('GET', zpath, { query: pickQuery(a) });
      return {
        totalResults: lastMeta.totalResults,
        count: Array.isArray(data) ? data.length : 1,
        items: data,
      };
    },
  },

  zotero_get_item: {
    description:
      'Get one item by key, with its editable JSON in "data". Add include="bib" or ' +
      'include="citation" for a formatted reference.',
    inputSchema: {
      type: 'object',
      properties: {
        ...libProps,
        key: s('string', 'Item key (8 chars, e.g. X42A7DEE)'),
        include: s('string', 'Extra blocks: "bib", "citation", "data" or an export format (comma-separated)'),
      },
      required: ['key'],
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      return zapi('GET', prefix + '/items/' + a.key, { query: { include: a.include } });
    },
  },

  zotero_list_item_children: {
    description: 'List the child items (notes, attachments) of an item.',
    inputSchema: {
      type: 'object',
      properties: { ...libProps, key: s('string', 'Parent item key') },
      required: ['key'],
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      return zapi('GET', prefix + '/items/' + a.key + '/children', { query: { limit: 100 } });
    },
  },

  zotero_list_item_tags: {
    description: 'List the tags of an item.',
    inputSchema: {
      type: 'object',
      properties: { ...libProps, key: s('string', 'Item key') },
      required: ['key'],
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      return zapi('GET', prefix + '/items/' + a.key + '/tags');
    },
  },

  zotero_list_collections: {
    description:
      'List the collections of a library (or only top-level ones). Returns name + key; ' +
      'use the key in collection tools.',
    inputSchema: {
      type: 'object',
      properties: { ...libProps, top: s('boolean', 'Only top-level collections'), all_pages: allPagesProp },
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      const zpath = prefix + '/collections' + (a.top ? '/top' : '');
      if (a.all_pages) {
        const { items, truncated, totalResults } = await zapiAll(zpath, { query: pickQuery(a) });
        return { count: items.length, truncated, totalResults, items };
      }
      return zapi('GET', zpath, { query: pickQuery(a) });
    },
  },

  zotero_get_collection: {
    description: 'Get one collection by key (name, parent, number of items).',
    inputSchema: {
      type: 'object',
      properties: { ...libProps, key: s('string', 'Collection key') },
      required: ['key'],
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      return zapi('GET', prefix + '/collections/' + a.key);
    },
  },

  zotero_list_tags: {
    description: 'List the tags of a library (optionally filtered by q / qmode / tag).',
    inputSchema: {
      type: 'object',
      properties: {
        ...libProps,
        q: s('string', 'Filter tags by keyword'),
        qmode: s('string', 'Filter mode', { enum: ['contains', 'startsWith'] }),
        tag: s('string', 'Tag filter'),
        limit: s('integer', 'Page size, 1-100'),
        all_pages: allPagesProp,
      },
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      const zpath = prefix + '/tags';
      if (a.all_pages) {
        const { items, truncated, totalResults } = await zapiAll(zpath, { query: pickQuery(a) });
        return { count: items.length, truncated, totalResults, items };
      }
      return zapi('GET', zpath, { query: pickQuery(a) });
    },
  },

  zotero_list_searches: {
    description: 'List the saved searches of a library (search metadata only).',
    inputSchema: { type: 'object', properties: { ...libProps } },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      return zapi('GET', prefix + '/searches', { query: { limit: 100 } });
    },
  },

  zotero_item_template: {
    description:
      'Get an empty editable-JSON template for an item type (journalArticle, book, ' +
      'report, webpage, note, ...). Fill it and pass it to zotero_create_items.',
    inputSchema: {
      type: 'object',
      properties: { itemType: s('string', 'Zotero item type, e.g. journalArticle, book, webpage') },
      required: ['itemType'],
    },
    handler: (a) => zapi('GET', '/items/new', { query: { itemType: a.itemType } }),
  },

  zotero_bibliography: {
    description:
      'Formatted bibliography (XHTML) for a collection or a set of item keys, in any ' +
      'CSL style. Zotero caps format=bib at 150 items - prefer collections. ' +
      'For raw export formats (bibtex, ris, ...) use zotero_export_items instead.',
    inputSchema: {
      type: 'object',
      properties: {
        ...libProps,
        collection: s('string', 'Collection key (recommended)'),
        item_keys: s('array', 'Item keys (up to 50) as an alternative to collection', { items: { type: 'string' } }),
        style: s('string', 'CSL style name (apa, chicago-note-bibliography, ...) or a CSL file URL'),
        locale: s('string', 'CSL locale, e.g. fr-FR, en-US'),
        linkwrap: s('boolean', 'Wrap URLs and DOIs in links'),
      },
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      const query = { format: 'bib', style: a.style, locale: a.locale, linkwrap: a.linkwrap };
      let zpath = prefix + '/items';
      if (a.collection) zpath = prefix + '/collections/' + a.collection + '/items';
      else if (a.item_keys) query.itemKey = a.item_keys.join(',');
      return zapi('GET', zpath, { query });
    },
  },

  zotero_export_items: {
    description:
      'Export items to a bibliographic format (bibtex, csljson, ris, ...). Source: a ' +
      'collection, item keys, or the whole library. Output is plain text.',
    inputSchema: {
      type: 'object',
      properties: {
        ...libProps,
        format: s('string', 'Export format', { enum: EXPORT_FORMATS }),
        collection: s('string', 'Collection key'),
        item_keys: s('array', 'Item keys (up to 50)', { items: { type: 'string' } }),
        q: s('string', 'Quick search filter'),
        tag: s('string', 'Tag filter'),
        limit: s('integer', 'Max items per page (required by Zotero for exports, default 100)'),
        all_pages: allPagesProp,
      },
      required: ['format'],
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      const query = { format: a.format, limit: a.limit || 100 };
      let zpath = prefix + '/items';
      if (a.collection) zpath = prefix + '/collections/' + a.collection + '/items';
      if (a.item_keys) query.itemKey = a.item_keys.join(',');
      if (a.q) query.q = a.q;
      if (a.tag) query.tag = a.tag;
      if (a.all_pages) {
        const { items, truncated } = await zapiAll(zpath, { query });
        return { truncated, count: items.length, text: items.join('\n\n') };
      }
      return zapi('GET', zpath, { query });
    },
  },

  zotero_create_items: {
    description:
      'Create items (up to 50) from editable-JSON objects - build them with ' +
      'zotero_item_template. Returns the new keys. Version preconditions are ' +
      'handled automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        ...libProps,
        items: s('array', 'Array of item objects, each with at least {"itemType": "..."}',
          { items: { type: 'object' }, minItems: 1, maxItems: MAX_WRITE_OBJECTS }),
      },
      required: ['items'],
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      return writePost({ prefix, suffix: '/items' }, a.items);
    },
  },

  zotero_update_item: {
    description:
      'Update (PATCH) one item with only the changed fields (title, tags, collections, ' +
      'creators, ...). The item version precondition is fetched automatically; pass ' +
      '"version" only if you already have it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...libProps,
        key: s('string', 'Item key'),
        fields: s('object', 'Changed fields only, e.g. {"title": "...", "tags": [{"tag": "lu"}]}'),
        version: s('integer', 'Current item version (optional - fetched automatically)'),
      },
      required: ['key', 'fields'],
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      let version = a.version;
      if (version === undefined) {
        const item = await zapi('GET', prefix + '/items/' + a.key);
        version = item?.data?.version ?? item?.version;
        if (version === undefined) throw new Error('Cannot determine item version; pass "version".');
      }
      await zapi('PATCH', prefix + '/items/' + a.key, {
        headers: { 'If-Unmodified-Since-Version': String(version) },
        body: a.fields,
      });
      return { updated: true, key: a.key, version: lastMeta.libraryVersion };
    },
  },

  zotero_delete_items: {
    description:
      'Delete items by keys (1 to 50, trash them). Destructive. The library version ' +
      'precondition is handled automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        ...libProps,
        keys: s('array', 'Item keys to delete', { items: { type: 'string' }, minItems: 1, maxItems: MAX_WRITE_OBJECTS }),
      },
      required: ['keys'],
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      const version = await libraryVersion(prefix);
      await zapi('DELETE', prefix + '/items', {
        query: { itemKey: a.keys.join(',') },
        headers: { 'If-Unmodified-Since-Version': String(version) },
      });
      return { deleted: a.keys, library_version: lastMeta.libraryVersion };
    },
  },

  zotero_create_collections: {
    description:
      'Create one or several collections. Pass "collections": [{"name": "...", ' +
      '"parentCollection": "<parentKey>" | false}] (parentCollection defaults to false ' +
      '= top-level). Returns the new keys.',
    inputSchema: {
      type: 'object',
      properties: {
        ...libProps,
        collections: s('array', 'Collection objects',
          { items: { type: 'object' }, minItems: 1, maxItems: MAX_WRITE_OBJECTS }),
        names: s('array', 'Shortcut: list of names for top-level collections',
          { items: { type: 'string' } }),
      },
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      const objects = a.collections ||
        (a.names || []).map((name) => ({ name, parentCollection: false }));
      return writePost({ prefix, suffix: '/collections' }, objects);
    },
  },

  zotero_delete_collections: {
    description:
      'Delete collections by keys (1 to 50). Destructive. Library version handled automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        ...libProps,
        keys: s('array', 'Collection keys to delete', { items: { type: 'string' }, minItems: 1, maxItems: MAX_WRITE_OBJECTS }),
      },
      required: ['keys'],
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      const version = await libraryVersion(prefix);
      await zapi('DELETE', prefix + '/collections', {
        query: { collectionKey: a.keys.join(',') },
        headers: { 'If-Unmodified-Since-Version': String(version) },
      });
      return { deleted: a.keys, library_version: lastMeta.libraryVersion };
    },
  },

  zotero_delete_tags: {
    description:
      'Delete tags (1 to 50) from the whole library (removes them from every item). ' +
      'Destructive. Library version handled automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        ...libProps,
        tags: s('array', 'Tag names to delete', { items: { type: 'string' }, minItems: 1, maxItems: MAX_WRITE_OBJECTS }),
      },
      required: ['tags'],
    },
    handler: async (a) => {
      const prefix = await libPrefix(a);
      const version = await libraryVersion(prefix);
      await zapi('DELETE', prefix + '/tags', {
        query: { tag: a.tags.join('||') },
        headers: { 'If-Unmodified-Since-Version': String(version) },
      });
      return { deleted: a.tags, library_version: lastMeta.libraryVersion };
    },
  },
};

// --- JSON-RPC dispatch (transport-agnostic): returns a response object or null
function dispatch(msg) {
  if (!msg || typeof msg !== 'object') return Promise.resolve(null);
  const { id, method, params } = msg;
  if (method === 'notifications/initialized') return Promise.resolve(null);

  if (method === 'initialize') {
    return Promise.resolve({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
  }
  if (method === 'ping') return Promise.resolve({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') {
    return Promise.resolve({
      jsonrpc: '2.0', id,
      result: {
        tools: Object.entries(tools).map(([name, t]) => ({
          name, description: t.description, inputSchema: t.inputSchema,
        })),
      },
    });
  }
  if (method === 'tools/call') {
    const tool = tools[params?.name];
    if (!tool) {
      return Promise.resolve({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: 'Unknown tool: ' + params?.name }], isError: true },
      });
    }
    return tool.handler(params.arguments || {}).then(
      (data) => {
        let text = JSON.stringify(data, null, 2) ?? 'null';
        if (text.length > 100000) text = text.slice(0, 100000) + '\n... (truncated)';
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
      },
      (err) => ({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: String(err?.message || err) }], isError: true },
      }),
    );
  }
  return Promise.resolve({
    jsonrpc: '2.0', id,
    error: { code: -32601, message: 'Method not found: ' + method },
  });
}

// --- CLI args
const argv = process.argv.slice(2);
const argVal = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
// Local app mode: --local, or run directly in a terminal (stdin is a TTY).
// MCP clients (Claude Desktop, Vibe CLI, ...) pipe stdin -> stdio transport.
const STDIO_MODE = argv.includes('--stdio');
const LOCAL_MODE = argv.includes('--local');
const HTTP_MODE =
  argv.includes('--http') || LOCAL_MODE || (!STDIO_MODE && process.stdin.isTTY);
const HTTP_PORT = Number(argVal('--port', pick('ZOTERO_MCP_PORT', ['port']) || '3334'));
const HTTP_BIND = argVal('--bind', pick('ZOTERO_MCP_BIND', ['bind']) || '127.0.0.1');
const HTTP_TOKEN = pick('ZOTERO_MCP_HTTP_TOKEN', ['httpToken', 'http_token']) || '';

// --- stdio transport
function runStdio() {
  if (!API_KEY) {
    console.error(
      'zotero-mcp: no API key - public libraries only (pass user_id/group_id in ' +
      'tool calls). Set ZOTERO_API_KEY for private libraries and writes.',
    );
    console.error('Create one at https://www.zotero.org/settings/keys.');
  }
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    dispatch(msg).then((res) => {
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    });
  });
  rl.on('close', () => process.exit(0));
  console.error('zotero-mcp v' + SERVER_INFO.version + ' ready (stdio, base: ' + API_BASE + ')');
}

// --- http transport (JSON responses, stateless)
function runHttp() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        server: SERVER_INFO.name,
        version: SERVER_INFO.version,
        transport: 'http',
        status: 'ok',
      }));
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'method not allowed' }));
    }
    if (HTTP_TOKEN && req.headers.authorization !== 'Bearer ' + HTTP_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
      const messages = Array.isArray(msg) ? msg : [msg];
      Promise.all(messages.map(dispatch)).then((responses) => {
        const body = Array.isArray(msg)
          ? responses.filter(Boolean)
          : (responses[0] || { jsonrpc: '2.0', id: null, result: {} });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
  });
  if (HTTP_BIND !== '127.0.0.1' && HTTP_BIND !== 'localhost' && !HTTP_TOKEN) {
    console.error(
      'zotero-mcp: WARNING - listening on ' + HTTP_BIND + ' without ZOTERO_MCP_HTTP_TOKEN: ' +
      'anyone who can reach this port can use your Zotero key.',
    );
  }
  server.listen(HTTP_PORT, HTTP_BIND, () => {
    if (LOCAL_MODE || process.stdin.isTTY) {
      // Friendly banner for a human running the local app.
      console.log('zotero-mcp v' + SERVER_INFO.version + ' - local app');
      console.log('  URL      : http://' + HTTP_BIND + ':' + HTTP_PORT + '/');
      console.log('  API base : ' + API_BASE);
      console.log('  Config   : ' + (CONFIG_PATH || 'none (environment variables only)'));
      console.log('  Key      : ' + (API_KEY ? 'configured' : 'none - public libraries only'));
      if (USER_ID) console.log('  User id  : ' + USER_ID);
      console.log('  Auth     : ' + (HTTP_TOKEN ? 'bearer token required' : 'none (localhost only)'));
      console.log('Press Ctrl+C to stop.');
    }
    console.error(
      'zotero-mcp v' + SERVER_INFO.version + ' ready (http://' + HTTP_BIND + ':' + HTTP_PORT +
      ', base: ' + API_BASE + (HTTP_TOKEN ? ', auth: bearer' : ', auth: none') + ')',
    );
  });
}

if (HTTP_MODE) runHttp();
else runStdio();
