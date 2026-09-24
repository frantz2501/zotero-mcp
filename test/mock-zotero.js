#!/usr/bin/env node
/**
 * Mock of the Zotero Web API v3 used by test/run-tests.js.
 * Emulates the endpoints used by the MCP tools, with version preconditions,
 * so write paths can be tested without a real API key.
 * Prints its listening port as JSON {"port": N} on stdout.
 */
'use strict';

import http from 'node:http';
import fs from 'node:fs';

let libVersion = 10;
const ITEM_VERSION = 3;

const item = (key) => ({
  key,
  version: ITEM_VERSION,
  library: { type: 'user', id: 42 },
  links: { self: { href: 'mock://' } },
  data: {
    key,
    version: ITEM_VERSION,
    itemType: 'journalArticle',
    title: 'Machine learning basics',
    creators: [{ creatorType: 'author', firstName: 'Jeanne', lastName: 'Dupont' }],
    tags: [{ tag: 'ai' }],
    collections: [],
    relations: {},
  },
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const p = url.pathname;
  const q = url.searchParams;
  const send = (status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(text);
  };
  const noContent = (headers = {}) => { res.writeHead(204, headers); res.end(); };

  const readBody = () => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null));
  });

  const checkLibVersion = () => {
    const v = req.headers['if-unmodified-since-version'];
    if (v === undefined) { send(428, { error: 'Precondition required' }); return false; }
    if (Number(v) !== libVersion) { send(412, { error: 'Precondition failed' }); return false; }
    return true;
  };

  // --- key info and templates (no library prefix)
  if (p === '/keys/current') {
    if (req.headers['zotero-api-key'] !== 'TESTKEY') return send(403, { error: 'Invalid key' });
    return send(200, {
      key: 'TESTKEY', userID: 42, username: 'tester',
      displayName: 'tester', access: {
        user: { library: true, files: true, notes: true, write: true },
        groups: { all: { library: true, write: true } },
      },
    });
  }
  if (p === '/items/new') {
    const type = q.get('itemType') || 'book';
    if (type === 'invalidType') return send(400, { error: 'Invalid item type' });
    return send(200, {
      itemType: type, title: '', creators: [], abstractNote: '',
      tags: [], collections: [], relations: {},
    });
  }

  // --- user 42 library
  if (p.startsWith('/users/42/') || p === '/users/42') {
    const sub = p.replace('/users/42', '');

    if (sub === '/items' && req.method === 'GET') {
      if (q.get('format') === 'keys') {
        return send(200, 'ABCD2345\n', {
          'Total-Results': '2', 'Last-Modified-Version': String(libVersion),
        });
      }
      if (q.get('format') === 'versions') {
        return send(200, { ABCD2345: ITEM_VERSION, EFGH6789: ITEM_VERSION }, {
          'Total-Results': '2', 'Last-Modified-Version': String(libVersion),
        });
      }
      if (q.get('format') === 'bib') {
        return send(200, '<div class="csl-bib-body"><div class="csl-entry">Dupont, J. (2020).</div></div>', {
          'Content-Type': 'text/html', 'Total-Results': '2',
          'Last-Modified-Version': String(libVersion),
        });
      }
      if (q.get('format') === 'bibtex') {
        return send(200, '@article{dupont2020,\n  title = {Machine learning basics},\n}\n', {
          'Content-Type': 'application/x-bibtex', 'Total-Results': '2',
        });
      }
      return send(200, [item('ABCD2345'), item('EFGH6789')], {
        'Total-Results': '2', 'Last-Modified-Version': String(libVersion),
      });
    }

    if (sub === '/items/ABCD2345' && req.method === 'GET') return send(200, item('ABCD2345'));
    if (sub === '/items/ABCD2345' && req.method === 'PATCH') {
      const iv = req.headers['if-unmodified-since-version'];
      if (iv === undefined) return send(428, { error: 'Precondition required' });
      if (Number(iv) !== ITEM_VERSION) return send(412, { error: 'Precondition failed' });
      return noContent({ 'Last-Modified-Version': String(++libVersion) });
    }
    if (/\/items\/[A-Z0-9]{8}$/.test(sub) && req.method === 'GET') {
      return send(404, { error: 'Item does not exist' });
    }

    if (sub === '/items' && req.method === 'POST') {
      return readBody().then((objects) => {
        if (!Array.isArray(objects) || objects.length === 0) return send(400, { error: 'Invalid body' });
        if (objects.length > 50) return send(413, { error: 'Too many items' });
        if (!req.headers['if-unmodified-since-version'] && !req.headers['zotero-write-token']) {
          return send(428, { error: 'Precondition required' });
        }
        if (req.headers['if-unmodified-since-version'] &&
            Number(req.headers['if-unmodified-since-version']) !== libVersion) {
          return send(412, { error: 'Precondition failed' });
        }
        libVersion++;
        const successful = {};
        objects.forEach((o, i) => {
          successful[i] = { key: 'NEWITEM0' + i, version: 1, data: o };
        });
        return send(200, { successful, unchanged: {}, failed: {} },
          { 'Last-Modified-Version': String(libVersion) });
      });
    }

    if (sub === '/items' && req.method === 'DELETE') {
      if (!checkLibVersion()) return;
      if (!q.get('itemKey')) return send(400, { error: 'itemKey required' });
      libVersion++;
      return noContent({ 'Last-Modified-Version': String(libVersion) });
    }

    if (sub === '/items/ABCD2345/children') {
      return send(200, [], { 'Total-Results': '0' });
    }
    if (sub === '/items/ABCD2345/tags') {
      return send(200, [{ tag: 'ai', meta: 1, type: 1 }]);
    }

    if (sub === '/collections' && req.method === 'GET') {
      return send(200, [{
        key: 'DM2F65CA', version: ITEM_VERSION,
        data: { key: 'DM2F65CA', version: ITEM_VERSION, name: 'Readings', parentCollection: false },
        meta: { numItems: 2 },
      }], { 'Total-Results': '1', 'Last-Modified-Version': String(libVersion) });
    }
    if (sub === '/collections' && req.method === 'POST') {
      return readBody().then((objects) => {
        if (!checkLibVersion()) return;
        libVersion++;
        const successful = {};
        objects.forEach((o, i) => { successful[i] = { key: 'NEWCOLL0' + i }; });
        return send(200, { successful, unchanged: {}, failed: {} },
          { 'Last-Modified-Version': String(libVersion) });
      });
    }
    if (sub === '/collections' && req.method === 'DELETE') {
      if (!checkLibVersion()) return;
      if (!q.get('collectionKey')) return send(400, { error: 'collectionKey required' });
      libVersion++;
      return noContent({ 'Last-Modified-Version': String(libVersion) });
    }

    if (sub === '/tags' && req.method === 'GET') {
      return send(200, [{ tag: 'ai', meta: 2, type: 1 }], { 'Total-Results': '1' });
    }
    if (sub === '/tags' && req.method === 'DELETE') {
      if (!checkLibVersion()) return;
      libVersion++;
      return noContent({ 'Last-Modified-Version': String(libVersion) });
    }

    if (sub === '/searches') {
      return send(200, [], { 'Total-Results': '0' });
    }

    // Pagination via Link header: emulate a second page of items.
    if (sub === '/paged') {
      return send(200, [item('PAGED0001')], {
        'Total-Results': '2',
        'Last-Modified-Version': String(libVersion),
        Link: '<http://127.0.0.1:' + (server.address()?.port ?? 0) + '/users/42/paged2>; rel="next"',
      });
    }
    if (sub === '/paged2') {
      return send(200, [item('PAGED0002')], { 'Total-Results': '2' });
    }

    return send(404, { error: 'Not found' });
  }

  return send(404, { error: 'Not found' });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  fs.writeFileSync('test/.mock-port', String(port));
  process.stdout.write(JSON.stringify({ port }) + '\n');
});
