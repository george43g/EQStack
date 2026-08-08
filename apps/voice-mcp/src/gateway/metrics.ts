/**
 * Zero-dependency metrics: counters + histograms rendered in Prometheus text
 * format on the localhost admin listener. Tracks the latency marks the
 * acceptance plan measures (end-of-turn → first model token → first token to
 * Twilio; interruption stop; callback latency).
 */

const HIST_BUCKETS_MS = [50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000];

class Counter {
  value = 0;
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(by = 1): void {
    this.value += by;
  }
}

class Histogram {
  buckets: number[];
  counts: number[];
  sum = 0;
  total = 0;
  constructor(
    readonly name: string,
    readonly help: string,
    buckets = HIST_BUCKETS_MS,
  ) {
    this.buckets = buckets;
    this.counts = new Array(buckets.length).fill(0);
  }
  observe(valueMs: number): void {
    this.sum += valueMs;
    this.total += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      const bound = this.buckets[i] ?? Number.POSITIVE_INFINITY;
      if (valueMs <= bound) {
        this.counts[i] = (this.counts[i] ?? 0) + 1;
      }
    }
  }
}

export class Metrics {
  private counters = new Map<string, Counter>();
  private histograms = new Map<string, Histogram>();

  counter(name: string, help = ""): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, help);
      this.counters.set(name, c);
    }
    return c;
  }

  histogram(name: string, help = ""): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name, help);
      this.histograms.set(name, h);
    }
    return h;
  }

  renderProm(): string {
    const lines: string[] = [];
    for (const c of this.counters.values()) {
      if (c.help) lines.push(`# HELP ${c.name} ${c.help}`);
      lines.push(`# TYPE ${c.name} counter`, `${c.name} ${c.value}`);
    }
    for (const h of this.histograms.values()) {
      if (h.help) lines.push(`# HELP ${h.name} ${h.help}`);
      lines.push(`# TYPE ${h.name} histogram`);
      for (let i = 0; i < h.buckets.length; i++) {
        lines.push(`${h.name}_bucket{le="${h.buckets[i]}"} ${h.counts[i]}`);
      }
      lines.push(
        `${h.name}_bucket{le="+Inf"} ${h.total}`,
        `${h.name}_sum ${h.sum}`,
        `${h.name}_count ${h.total}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
}
