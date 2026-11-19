// A local stand-in for api.okdata.online for the Node tests: routes answer like the real API, every request is
// recorded, and nothing leaves this machine. No real key is ever used.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export const TEST_KEY = 'okd_test_0000000000000000';

export function ok(endpoint, { items, item, nextCursor = null, amount = '0.002' } = {}) {
  return {
    code: 'ok',
    request_id: randomUUID(),
    warnings: [],
    data: items === undefined ? { item } : { items },
    ...(items === undefined ? {} : { page: { next_cursor: nextCursor, has_more: nextCursor !== null } }),
    meta: {
      capability: endpoint,
      billing: { amount, currency: 'USD', balance_after: '1' },
      unavailable: {},
      cached: false,
      replayed: false,
      fetched_at: '2026-11-12T08:00:00Z',
    },
  };
}

export function error(code, { retry = 'no' } = {}) {
  return { code, message: 'scripted', request_id: randomUUID(), charged: false, retry, retry_after_seconds: 0 };
}

export async function startMock(routes, prices = {}) {
  const mock = { routes, prices, requests: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(url.searchParams);
    mock.requests.push({ path: url.pathname, query, headers: req.headers });
    let status = 200;
    let body;
    if (url.pathname === '/v1/catalog') {
      const endpoints = Object.entries(mock.prices).map(([id, maxCharge]) => ({ id, maxCharge }));
      body = { code: 'ok', request_id: 'c', warnings: [], data: { endpoints } };
    } else if (req.headers.authorization !== `Bearer ${TEST_KEY}`) {
      [status, body] = [401, error('unauthorized', { retry: 'after_fix' })];
    } else if (mock.routes[url.pathname]) {
      [status, body] = mock.routes[url.pathname](query);
    } else {
      [status, body] = [404, error('unknown_endpoint')];
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.url = `http://127.0.0.1:${server.address().port}`;
  mock.paid = () => mock.requests.filter((r) => r.path !== '/v1/catalog');
  mock.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  return mock;
}
