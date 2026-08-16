// Deliberately concentrates load on a tiny pool of "hot" accounts to force SERIALIZABLE
// conflicts and exercise the bounded retry policy (ADR-002) under real concurrency. Some
// TRANSFER_RETRY_EXHAUSTED (503) responses are an expected, correctly-bounded outcome here, not
// a failure of the system -- the threshold below only requires latency to stay bounded, and
// teardown independently re-checks every hot account's balance is still non-negative over HTTP.
import { check, sleep } from 'k6';
import {
  buildAccountPool,
  getAccount,
  getMetrics,
  pickTwoDistinct,
  provisionCustomerKey,
  transfer,
} from './helpers.js';

const HOT_ACCOUNT_COUNT = Number(__ENV.HOT_ACCOUNT_COUNT || 3);
const VUS = Number(__ENV.VUS || 30);
const DURATION = __ENV.DURATION || '20s';

export const options = {
  scenarios: {
    hot_account_contention: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
  },
};

export function setup() {
  const apiKey = provisionCustomerKey('hot-account-contention');
  const accounts = buildAccountPool(HOT_ACCOUNT_COUNT, 'INR', '100000000', apiKey);
  const before = getMetrics();
  return { accounts, apiKey, before };
}

export default function (data) {
  const [source, destination] = pickTwoDistinct(data.accounts);
  const idempotencyKey = `hot-account-${__VU}-${__ITER}-${Date.now()}-${Math.random()}`;
  const res = transfer(source, destination, '10', idempotencyKey, data.apiKey);
  check(res, {
    'transfer succeeded or bounded-retry-exhausted': (r) => r.status === 201 || r.status === 503,
  });
  sleep(0.02);
}

export function teardown(data) {
  const after = getMetrics();
  console.log(
    `[hot-account-contention] completed: ${data.before.completed} -> ${after.completed} ` +
      `(retries: ${data.before.retries} -> ${after.retries}, ` +
      `exhausted: ${data.before.exhausted} -> ${after.exhausted})`,
  );

  for (const accountId of data.accounts) {
    const res = getAccount(accountId, data.apiKey);
    const balance = res.json('balanceMinor');
    console.log(`[hot-account-contention] final balance ${accountId} = ${balance}`);
    if (BigInt(balance) < 0n) {
      throw new Error(`hot account ${accountId} went negative: ${balance}`);
    }
  }
}
