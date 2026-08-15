import http from 'k6/http';
import { check } from 'k6';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
export const ADMIN_API_KEY = __ENV.ADMIN_API_KEY;

if (!ADMIN_API_KEY) {
  throw new Error('ADMIN_API_KEY environment variable is required to run any k6 scenario');
}

const jsonHeaders = { 'Content-Type': 'application/json' };
const adminHeaders = { 'Content-Type': 'application/json', 'x-admin-api-key': ADMIN_API_KEY };

export function createAccount(currency) {
  const res = http.post(`${BASE_URL}/v1/accounts`, JSON.stringify({ currency }), {
    headers: jsonHeaders,
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

export function transfer(sourceAccountId, destinationAccountId, amountMinor, idempotencyKey) {
  const headers = Object.assign({}, jsonHeaders);
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return http.post(
    `${BASE_URL}/v1/transfers`,
    JSON.stringify({ sourceAccountId, destinationAccountId, amountMinor }),
    { headers },
  );
}

export function getAccount(accountId) {
  return http.get(`${BASE_URL}/v1/accounts/${accountId}`);
}

export function getMetrics() {
  const res = http.get(`${BASE_URL}/v1/admin/metrics`, { headers: adminHeaders });
  check(res, { 'metrics ok (200)': (r) => r.status === 200 });
  return res.json('transfers');
}

export function buildAccountPool(size, currency, fundingAmountMinor) {
  const accounts = [];
  for (let i = 0; i < size; i += 1) {
    const id = createAccount(currency);
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
