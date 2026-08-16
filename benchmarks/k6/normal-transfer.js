// Baseline scenario: moderate concurrent load, transfers between random pairs drawn from a wide
// account pool so contention on any single account is rare. This is the "typical traffic" number
// everything else is compared against.
import { check, sleep } from 'k6';
import {
  buildAccountPool,
  provisionCustomerKey,
  getMetrics,
  pickTwoDistinct,
  randomAmount,
  transfer,
} from './helpers.js';

const ACCOUNT_POOL_SIZE = Number(__ENV.ACCOUNT_POOL_SIZE || 100);
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || '30s';

export const options = {
  scenarios: {
    normal_transfer: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

export function setup() {
  const apiKey = provisionCustomerKey('normal-transfer');
  const accounts = buildAccountPool(ACCOUNT_POOL_SIZE, 'INR', '10000000', apiKey);
  const before = getMetrics();
  return { accounts, apiKey, before };
}

export default function (data) {
  const [source, destination] = pickTwoDistinct(data.accounts);
  const idempotencyKey = `normal-transfer-${__VU}-${__ITER}-${Date.now()}-${Math.random()}`;
  const res = transfer(source, destination, randomAmount(1, 100), idempotencyKey, data.apiKey);
  check(res, { 'transfer succeeded (201)': (r) => r.status === 201 });
  sleep(0.1);
}

export function teardown(data) {
  const after = getMetrics();
  console.log(
    `[normal-transfer] completed: ${data.before.completed} -> ${after.completed} ` +
      `(retries: ${data.before.retries} -> ${after.retries}, ` +
      `exhausted: ${data.before.exhausted} -> ${after.exhausted})`,
  );
}
