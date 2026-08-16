// Ramps concurrency up over a wide account pool to find the system's general concurrent-throughput
// ceiling without deliberately concentrating load on any one row (that's hot-account-contention.js).
import { check, sleep } from 'k6';
import {
  buildAccountPool,
  provisionCustomerKey,
  getMetrics,
  pickTwoDistinct,
  randomAmount,
  transfer,
} from './helpers.js';

const ACCOUNT_POOL_SIZE = Number(__ENV.ACCOUNT_POOL_SIZE || 300);
const PEAK_VUS = Number(__ENV.PEAK_VUS || 75);

export const options = {
  scenarios: {
    broad_concurrency: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: Math.round(PEAK_VUS / 2) },
        { duration: '10s', target: PEAK_VUS },
        { duration: '20s', target: PEAK_VUS },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
  },
};

export function setup() {
  const apiKey = provisionCustomerKey('broad-concurrency');
  const accounts = buildAccountPool(ACCOUNT_POOL_SIZE, 'INR', '10000000', apiKey);
  const before = getMetrics();
  return { accounts, apiKey, before };
}

export default function (data) {
  const [source, destination] = pickTwoDistinct(data.accounts);
  const idempotencyKey = `broad-concurrency-${__VU}-${__ITER}-${Date.now()}-${Math.random()}`;
  const res = transfer(source, destination, randomAmount(1, 50), idempotencyKey, data.apiKey);
  check(res, {
    'transfer succeeded or bounded-retry-exhausted': (r) => r.status === 201 || r.status === 503,
  });
  sleep(0.05);
}

export function teardown(data) {
  const after = getMetrics();
  console.log(
    `[broad-concurrency] completed: ${data.before.completed} -> ${after.completed} ` +
      `(retries: ${data.before.retries} -> ${after.retries}, ` +
      `exhausted: ${data.before.exhausted} -> ${after.exhausted})`,
  );
}
