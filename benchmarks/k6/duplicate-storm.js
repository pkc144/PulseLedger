// Fires many concurrent requests sharing the exact same Idempotency-Key and body at one source
// account, proving under real network/load conditions -- not just vitest -- that exactly one
// transfer posts.
//
// By design (Week 4), only ONE concurrent caller wins the race and gets 201; every other caller
// racing the SAME still-in-progress key correctly gets 409 IDEMPOTENCY_IN_PROGRESS immediately
// (no blocking wait) -- a caller only gets a replayed 201 if it arrives *after* the winner
// commits. So "success" here is 201 or 409, never anything else, and the real invariant -- proven
// in teardown() -- is that the completed-transfer count increases by exactly 1 regardless of how
// many callers raced it.
import http from 'k6/http';
import { check } from 'k6';
import {
  createAccount,
  fundAccount,
  getMetrics,
  provisionCustomerKey,
  transfer,
} from './helpers.js';

const DUPLICATE_COUNT = Number(__ENV.DUPLICATE_COUNT || 50);

// Teach k6 that 200 (setup/teardown's metrics reads), 201 (won the race), and 409 (correctly
// rejected while in progress or on replay conflict) are all expected outcomes, not failures --
// only 5xx/network errors should count against http_req_failed here.
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    duplicate_storm: {
      executor: 'per-vu-iterations',
      vus: DUPLICATE_COUNT,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const apiKey = provisionCustomerKey('duplicate-storm');
  const source = createAccount('INR', apiKey);
  fundAccount(source, '1000000');
  const destination = createAccount('INR', apiKey);
  const idempotencyKey = `duplicate-storm-${Date.now()}`;
  const before = getMetrics();
  return { source, destination, idempotencyKey, apiKey, before };
}

export default function (data) {
  const res = transfer(data.source, data.destination, '777', data.idempotencyKey, data.apiKey);
  check(res, {
    'got 201 (won the race) or 409 (correctly rejected)': (r) =>
      r.status === 201 || r.status === 409,
  });
}

export function teardown(data) {
  const after = getMetrics();
  const delta = after.completed - data.before.completed;
  console.log(
    `[duplicate-storm] ${DUPLICATE_COUNT} concurrent identical requests -> ` +
      `completed delta = ${delta} (must be exactly 1)`,
  );
  if (delta !== 1) {
    throw new Error(
      `duplicate-storm invariant violated: expected exactly 1 completed transfer, observed ${delta}`,
    );
  }
}
