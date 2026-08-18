import { describe, expect, it } from 'vitest';
import {
  prometheusContentType,
  renderPrometheusMetrics,
} from '../../src/infrastructure/http/metrics.js';

describe('Prometheus exposition', () => {
  it('renders counters with HELP and TYPE lines and a trailing newline', () => {
    const output = renderPrometheusMetrics({
      transfers: { completed: 12, exhausted: 3, retries: 45 },
    });

    expect(output).toContain('# HELP pulseledger_transfers_completed_total');
    expect(output).toContain('# TYPE pulseledger_transfers_completed_total counter');
    expect(output).toContain('pulseledger_transfers_completed_total 12');
    expect(output).toContain('pulseledger_transfer_retries_total 45');
    expect(output).toContain('pulseledger_transfer_retry_exhausted_total 3');
    // Scrapers reject a body whose last line is not terminated.
    expect(output.endsWith('\n')).toBe(true);
  });

  it('renders outbox depth as a labelled gauge when the worker is wired', () => {
    const output = renderPrometheusMetrics({
      outbox: { failed: 2, pending: 7, processing: 1 },
      transfers: { completed: 0, exhausted: 0, retries: 0 },
    });

    expect(output).toContain('# TYPE pulseledger_outbox_events gauge');
    expect(output).toContain('pulseledger_outbox_events{status="pending"} 7');
    expect(output).toContain('pulseledger_outbox_events{status="processing"} 1');
    expect(output).toContain('pulseledger_outbox_events{status="failed"} 2');
  });

  it('omits the outbox family entirely when no worker is wired', () => {
    const output = renderPrometheusMetrics({
      transfers: { completed: 1, exhausted: 0, retries: 0 },
    });
    // A gauge that is silently zero would read as "the outbox is empty" rather than
    // "there is no outbox here".
    expect(output).not.toContain('pulseledger_outbox_events');
  });

  it('declares the exposition format version scrapers expect', () => {
    expect(prometheusContentType).toBe('text/plain; version=0.0.4; charset=utf-8');
  });
});
