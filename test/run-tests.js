#!/usr/bin/env node
/**
 * Integration tests for zotero-mcp.
 *
 *   node test/run-tests.js <mockPort>   - write + read paths against test/mock-zotero.js
 *   node test/run-tests.js real         - read-only paths against the real
 *                                         https://api.zotero.org (public library,
 *                                         no API key needed)
 */
'use strict';

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let checks = 0;

function check(name, cond, extra) {
  checks++;
  if (cond) {
    console.log('  ok - ' + name);
  } else {
    failures++;
    console.log('  FAIL - ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''));
  }
}

function withTimeout(promise, ms = 30000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after ' + ms + 'ms')), ms)),
  ]);
}

// Minimal MCP stdio client
function connect(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(d.toString()));
  return {
    call(method, params) {
      return withTimeout(new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      }));
    },
    async tool(name, args = {}) {
      const r = await this.call('tools/call', { name, arguments: args });
      return { raw: r, result: r.result };
    },
    async toolJson(name, args = {}) {
      const { result } = await this.tool(name, args);
      return { isError: result.isError, text: result.content?.[0]?.text, data: safeJson(result.content?.[0]?.text) };
    },
    stderr: () => stderr.join(''),
    close() { child.stdin.end(); child.kill(); },
  };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const isText = (t, needle) => typeof t === 'string' && t.includes(needle);

// ---------------------------------------------------------------------------
async function mockSuite(port) {
  console.log('mock suite (http://127.0.0.1:' + port + ')');
  const base = 'http://127.0.0.1:' + port;
  const mcp = connect({
    ZOTERO_API_BASE: base, ZOTERO_API_KEY: 'TESTKEY', ZOTERO_USER_ID: '42',
  });
  try {
    const init = await mcp.call('initialize', {});
    check('initialize -> protocolVersion', init.result?.protocolVersion === '2024-11-05');

    const list = await mcp.call('tools/list', {});
    const names = list.result?.tools?.map((t) => t.name);
    check('tools/list exposes 19 tools', names?.length === 19, names);
    check('key tools present',
      ['zotero_health', 'zotero_search_items', 'zotero_create_items',
       'zotero_update_item', 'zotero_delete_items', 'zotero_bibliography',
       'zotero_export_items'].every((n) => names?.includes(n)));
    check('tool schemas are JSON Schema objects',
      list.result?.tools?.every((t) => t.inputSchema?.type === 'object'));

    let r = await mcp.toolJson('zotero_health');
    check('health -> key info', r.data?.ok === true && r.data?.key?.userID === 42, r.data);

    r = await mcp.toolJson('zotero_search_items', { q: 'machine' });
    check('search_items -> 2 items, totalResults 2',
      r.data?.count === 2 && r.data?.totalResults === 2, r.data);

    r = await mcp.toolJson('zotero_list_items', {});
    check('list_items -> 2 items', r.data?.count === 2 && Array.isArray(r.data?.items));

    r = await mcp.toolJson('zotero_list_items', { format: 'versions' });
    check('list_items format=versions -> {ABCD2345: 3}',
      r.data?.items?.ABCD2345 === 3, r.data);

    r = await mcp.toolJson('zotero_list_items', { format: 'keys' });
    check('list_items format=keys -> text keys', isText(r.text, 'ABCD2345'), r.text);

    r = await mcp.toolJson('zotero_get_item', { key: 'ABCD2345' });
    check('get_item -> data.version 3', r.data?.data?.version === 3, r.data);

    r = await mcp.toolJson('zotero_get_item', { key: 'ZZZZZZZZ' });
    check('get_item 404 -> isError with message', r.isError === true && isText(r.text, '404'), r.text);

    r = await mcp.toolJson('zotero_list_item_children', { key: 'ABCD2345' });
    check('list_item_children -> []', Array.isArray(r.data) && r.data.length === 0);

    r = await mcp.toolJson('zotero_list_item_tags', { key: 'ABCD2345' });
    check('list_item_tags -> ["ai"]', Array.isArray(r.data) && r.data[0]?.tag === 'ai');

    r = await mcp.toolJson('zotero_list_collections', {});
    check('list_collections -> 1 collection "Readings"',
      Array.isArray(r.data) && r.data[0]?.data?.name === 'Readings');

    r = await mcp.toolJson('zotero_list_tags', {});
    check('list_tags -> 1 tag', Array.isArray(r.data) && r.data.length === 1);

    r = await mcp.toolJson('zotero_list_searches', {});
    check('list_searches -> []', Array.isArray(r.data) && r.data.length === 0);

    r = await mcp.toolJson('zotero_item_template', { itemType: 'book' });
    check('item_template -> itemType book', r.data?.itemType === 'book');

    r = await mcp.toolJson('zotero_bibliography', { style: 'apa' });
    check('bibliography -> csl-entry', isText(r.text, 'csl-entry'), r.text);

    r = await mcp.toolJson('zotero_export_items', { format: 'bibtex' });
    check('export_items bibtex -> @article', isText(r.text, '@article'), r.text);

    // --- writes
    r = await mcp.toolJson('zotero_create_items', {
      items: [{ itemType: 'book', title: 'Nouveau livre' }],
    });
    check('create_items -> NEWITEM00',
      r.data?.successful?.['0']?.key === 'NEWITEM00', r.data);

    r = await mcp.toolJson('zotero_update_item', {
      key: 'ABCD2345', fields: { title: 'Titre modifie' },
    });
    check('update_item (auto version) -> updated', r.data?.updated === true, r.data);

    r = await mcp.toolJson('zotero_update_item', {
      key: 'ABCD2345', fields: { title: 'x' }, version: 999,
    });
    check('update_item stale version -> 412 error', r.isError === true && isText(r.text, '412'), r.text);

    r = await mcp.toolJson('zotero_delete_items', { keys: ['ABCD2345', 'EFGH6789'] });
    check('delete_items -> deleted 2', r.data?.deleted?.length === 2, r.data);

    r = await mcp.toolJson('zotero_create_collections', { names: ['Ma collection'] });
    check('create_collections -> NEWCOLL00', r.data?.successful?.['0']?.key === 'NEWCOLL00', r.data);

    r = await mcp.toolJson('zotero_delete_collections', { keys: ['DM2F65CA'] });
    check('delete_collections -> deleted', r.data?.deleted?.[0] === 'DM2F65CA', r.data);

    r = await mcp.toolJson('zotero_delete_tags', { tags: ['obsolète'] });
    check('delete_tags -> deleted', r.data?.deleted?.[0] === 'obsolète', r.data);

    // --- pagination via Link header
    const paginated = await mcp.toolJson('zotero_list_items', {});
    // (mock /items has no Link; explicit check through a raw request on /paged)
    r = await mcp.call('tools/call', {
      name: 'zotero_list_collections', arguments: { all_pages: true },
    });
    check('all_pages follows Link (collections)', !r.result?.isError, r.result?.content?.[0]?.text?.slice(0, 120));

    // unknown tool
    r = await mcp.toolJson('zotero_nope', {});
    check('unknown tool -> isError', r.isError === true);
  } finally {
    mcp.close();
  }
}

// ---------------------------------------------------------------------------
async function realSuite() {
  console.log('real API suite (api.zotero.org, public library of docs user 475425)');
  const mcp = connect({ ZOTERO_USER_ID: '475425' }); // no key: public reads only
  const uid = { user_id: 475425 };
  try {
    let r = await mcp.toolJson('zotero_health');
    check('health -> public mode', r.data?.ok === true && isText(r.data?.mode, 'public'), r.data);

    r = await mcp.toolJson('zotero_search_items', { ...uid, q: 'zotero', limit: 5 });
    check('search_items "zotero" -> results', (r.data?.count ?? 0) > 0, r.data?.count);

    r = await mcp.toolJson('zotero_list_collections', uid);
    check('list_collections -> 15', Array.isArray(r.data) && r.data.length === 15, r.data?.length);

    r = await mcp.toolJson('zotero_list_items', { ...uid, limit: 3 });
    check('list_items limit=3 -> 3 items', r.data?.count === 3, r.data?.count);

    const firstKey = r.data?.items?.[0]?.key;
    r = await mcp.toolJson('zotero_get_item', { ...uid, key: firstKey });
    check('get_item -> same key', r.data?.key === firstKey, firstKey);

    r = await mcp.toolJson('zotero_list_tags', { ...uid, limit: 5 });
    check('list_tags -> 5 tags', Array.isArray(r.data) && r.data.length === 5, r.data?.length);

    r = await mcp.toolJson('zotero_bibliography', { ...uid, collection: 'N7W92H48', style: 'apa' });
    check('bibliography collection -> csl-entry', isText(r.text, 'csl-entry'), r.text?.slice(0, 80));

    r = await mcp.toolJson('zotero_export_items', { ...uid, format: 'bibtex', collection: 'N7W92H48' });
    check('export_items bibtex -> "@"', isText(r.text, '@'), r.text?.slice(0, 80));

    r = await mcp.toolJson('zotero_item_template', { itemType: 'journalArticle' });
    check('item_template journalArticle', r.data?.itemType === 'journalArticle');

    // format=keys/versions ignore `limit` entirely (Zotero doc), so test the
    // clamp with tags (192 total, small objects).
    r = await mcp.toolJson('zotero_list_tags', { ...uid, limit: 200 });
    check('limit>100 clamped to 100 by the API', Array.isArray(r.data) && r.data.length === 100, r.data?.length);
  } finally {
    mcp.close();
  }
}

// ---------------------------------------------------------------------------
const arg = process.argv[2];
if (arg === 'real') {
  realSuite().then(finish, (e) => { console.error(e); process.exit(1); });
} else {
  const port = Number(arg);
  if (!Number.isInteger(port) || port <= 0) {
    console.error('Usage: node test/run-tests.js <mockPort> | real');
    process.exit(2);
  }
  mockSuite(port).then(finish, (e) => { console.error(e); process.exit(1); });
}

function finish() {
  console.log(checks + ' checks, ' + failures + ' failures');
  process.exit(failures ? 1 : 0);
}
