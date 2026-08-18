/**
 * Prometheus text exposition (version 0.0.4).
 *
 * A pure function over plain numbers: this file is shared infrastructure and must not know that
 * transfers or outbox events exist as features. The composition root passes it the values.
 */

export interface MetricsSnapshot {
  outbox?: {
    failed: number;
    pending: number;
    processing: number;
  };
  transfers: {
    completed: number;
    exhausted: number;
    retries: number;
  };
}

export const prometheusContentType = 'text/plain; version=0.0.4; charset=utf-8';

interface MetricFamily {
  help: string;
  name: string;
  samples: { labels?: Record<string, string>; value: number }[];
  type: 'counter' | 'gauge';
}

function renderLabels(labels: Record<string, string> | undefined): string {
  if (!labels) return '';
  const rendered = Object.entries(labels)
    // Escapes per the exposition format: backslash, double quote, newline.
    .map(
      ([key, value]) =>
        `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
    )
    .join(',');
  return `{${rendered}}`;
}

function renderFamily(family: MetricFamily): string {
  const lines = [`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} ${family.type}`];
  for (const sample of family.samples) {
    lines.push(`${family.name}${renderLabels(sample.labels)} ${sample.value}`);
  }
  return lines.join('\n');
}

export function renderPrometheusMetrics(snapshot: MetricsSnapshot): string {
  const families: MetricFamily[] = [
    {
      help: 'Transfers committed since process start.',
      name: 'pulseledger_transfers_completed_total',
      samples: [{ value: snapshot.transfers.completed }],
      type: 'counter',
    },
    {
      help: 'Transfer attempts retried after a serialization failure or deadlock.',
      name: 'pulseledger_transfer_retries_total',
      samples: [{ value: snapshot.transfers.retries }],
      type: 'counter',
    },
    {
      help: 'Transfers that exhausted their bounded retry budget and returned 503.',
      name: 'pulseledger_transfer_retry_exhausted_total',
      samples: [{ value: snapshot.transfers.exhausted }],
      type: 'counter',
    },
  ];

  if (snapshot.outbox) {
    families.push({
      help: 'Outbox events by delivery status. A rising pending or failed count means the worker is behind or stuck.',
      name: 'pulseledger_outbox_events',
      samples: [
        { labels: { status: 'pending' }, value: snapshot.outbox.pending },
        { labels: { status: 'processing' }, value: snapshot.outbox.processing },
        { labels: { status: 'failed' }, value: snapshot.outbox.failed },
      ],
      type: 'gauge',
    });
  }

  // Trailing newline is required by the exposition format.
  return `${families.map(renderFamily).join('\n\n')}\n`;
}
