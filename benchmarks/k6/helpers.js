import http from 'k6/http';
import { check } from 'k6';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
export const ADMIN_API_KEY = __ENV.ADMIN_API_KEY;

if (!ADMIN_API_KEY) {
  throw new Error('ADMIN_API_KEY environment variable is required to run any k6 scenario');
}

const adminHeaders = { 'Content-Type': 'application/json', 'x-admin-api-key': ADMIN_API_KEY };

/** Customer routes need a customer credential; the admin key cannot stand in for one. */
function customerHeaders(apiKey) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
}

/**
 * Mints a throwaway principal and API key for one scenario run. Call this in `setup()` and pass
 * the returned secret to every VU through the setup data -- module state does not cross into VUs.
 */
export function provisionCustomerKey(label) {
  const principal = http.post(
    `${BASE_URL}/v1/admin/principals`,
    JSON.stringify({ name: `k6-${label}-${Date.now()}` }),
    { headers: adminHeaders },
  );
  check(principal, { 'principal created (201)': (r) => r.status === 201 });

  // No body, and therefore no Content-Type: Fastify rejects an empty body that claims to be JSON.
  const issued = http.post(
    `${BASE_URL}/v1/admin/principals/${principal.json('id')}/api-keys`,
    null,
    {
      headers: { 'x-admin-api-key': ADMIN_API_KEY },
    },
  );
  check(issued, { 'api key issued (201)': (r) => r.status === 201 });
  return issued.json('key');
}

export function createAccount(currency, apiKey) {
  const res = http.post(`${BASE_URL}/v1/accounts`, JSON.stringify({ currency }), {
    headers: customerHeaders(apiKey),
  });
  check(res, { 'account created (201)': (r) => r.status === 201 });
  return res.json('id');
}

export function fundAccount(accountId, amountMinor) {
  const res = http.post(`${BASE_URL}/v1/admin/fund`, JSON.stringify({ accountId, amountMinor }), {
    headers: adminHeaders,
  });
  check(res, { 'funded (201)': (r) => r.status === 201 });
  return res;
}

export function transfer(
  sourceAccountId,
  destinationAccountId,
  amountMinor,
  idempotencyKey,
  apiKey,
) {
  const headers = customerHeaders(apiKey);
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return http.post(
    `${BASE_URL}/v1/transfers`,
    JSON.stringify({ sourceAccountId, destinationAccountId, amountMinor }),
    { headers },
  );
}

export function getAccount(accountId, apiKey) {
  return http.get(`${BASE_URL}/v1/accounts/${accountId}`, { headers: customerHeaders(apiKey) });
}

export function getMetrics() {
  const res = http.get(`${BASE_URL}/v1/admin/metrics`, { headers: adminHeaders });
  check(res, { 'metrics ok (200)': (r) => r.status === 200 });
  return res.json('transfers');
}

export function buildAccountPool(size, currency, fundingAmountMinor, apiKey) {
  const accounts = [];
  for (let i = 0; i < size; i += 1) {
    const id = createAccount(currency, apiKey);
    fundAccount(id, fundingAmountMinor);
    accounts.push(id);
  }
  return accounts;
}

export function randomAmount(min, max) {
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
}

export function pickTwoDistinct(items) {
  const a = items[Math.floor(Math.random() * items.length)];
  let b = items[Math.floor(Math.random() * items.length)];
  while (items.length > 1 && b === a) {
    b = items[Math.floor(Math.random() * items.length)];
  }
  return [a, b];
}
