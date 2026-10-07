import type { SynchronizedSample } from '../types.ts';

export type ChannelPair = {
  /** Sample from the primary analysis channel. */
  primary: SynchronizedSample;
  /** Sample from the reference channel matched to the same observation. */
  reference: SynchronizedSample;
  /** Measured timestamp difference between the two observations (ns). */
  offsetNs: number;
};

export type ChannelPairing = {
  pairs: ChannelPair[];
  /** Number of primary samples without a usable one-to-one reference match. */
  unmatchedPrimary: number;
  /** Number of reference samples never consumed by a pair. */
  unmatchedReference: number;
  /** True only when every observation on both sides participates in exactly one pair. */
  complete: boolean;
  warnings: string[];
};

type Side = { index: number; triggerId: string; timestampNs: number };

function nearestWithin(trigger: Side[], anchorTs: number, toleranceNs: number, used: Set<number>): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const item of trigger) {
    if (used.has(item.index)) continue;
    const distance = Math.abs(item.timestampNs - anchorTs);
    if (distance <= toleranceNs && distance < bestDistance) {
      best = item.index;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Pairs primary and reference observations one-to-one.
 *
 * Pairing is attempted per trigger first (observations from different triggers
 * are never mixed); only when trigger domains do not overlap do we fall back to
 * a strictly monotone nearest-timestamp match. Each reference is consumed at
 * most once, so a short reference channel can never inflate a cross-spectrum by
 * being re-used against several primary samples. The result reports exactly how
 * many observations could not be paired; callers must not synthesize a
 * cross-spectrum unless `complete` is true.
 */
export function pairChannels(
  primary: SynchronizedSample[],
  reference: SynchronizedSample[],
  options: { toleranceNs?: number; effectiveToleranceNs?: number } = {},
): ChannelPairing {
  const toleranceNs = options.toleranceNs ?? 2_000;
  const effectiveToleranceNs = Math.min(toleranceNs, options.effectiveToleranceNs ?? toleranceNs);
  const warnings: string[] = [];
  if (effectiveToleranceNs < toleranceNs) {
    warnings.push(`Reference pairing tolerance tightened from ${toleranceNs} ns to ${effectiveToleranceNs} ns (half the primary sample interval)`);
  }

  const left: Side[] = primary.map((sample, index) => ({ index, triggerId: sample.triggerId, timestampNs: sample.timestampNs }));
  const right: Side[] = reference.map((sample, index) => ({ index, triggerId: sample.triggerId, timestampNs: sample.timestampNs }));
  const leftByTrigger = new Map<string, Side[]>();
  for (const item of left) {
    const list = leftByTrigger.get(item.triggerId) ?? [];
    list.push(item);
    leftByTrigger.set(item.triggerId, list);
  }
  const rightByTrigger = new Map<string, Side[]>();
  for (const item of right) {
    const list = rightByTrigger.get(item.triggerId) ?? [];
    list.push(item);
    rightByTrigger.set(item.triggerId, list);
  }
  for (const list of leftByTrigger.values()) list.sort((a, b) => a.timestampNs - b.timestampNs);
  for (const list of rightByTrigger.values()) list.sort((a, b) => a.timestampNs - b.timestampNs);

  const sharedTriggers = [...leftByTrigger.keys()].filter((triggerId) => rightByTrigger.has(triggerId));
  const pairIndex: Array<[number, number]> = [];
  if (sharedTriggers.length > 0) {
    // Never match across different triggers; triggers present on only one side stay unpaired.
    const usedRight = new Set<number>();
    const usedLeft = new Set<number>();
    for (const triggerId of sharedTriggers) {
      const leftTrigger = leftByTrigger.get(triggerId)!;
      const rightTrigger = rightByTrigger.get(triggerId)!;
      for (const item of leftTrigger) {
        const match = nearestWithin(rightTrigger, item.timestampNs, effectiveToleranceNs, usedRight);
        if (match !== null) {
          pairIndex.push([item.index, match]);
          usedLeft.add(item.index);
          usedRight.add(match);
        }
      }
    }
    const orphanTriggers = new Set<string>();
    for (const item of left) if (!usedLeft.has(item.index)) orphanTriggers.add(item.triggerId);
    if (orphanTriggers.size > 0) warnings.push(`${orphanTriggers.size} trigger group(s) on the primary channel have no reference observation`);
  } else {
    warnings.push('Primary and reference share no trigger ids; paired on nearest timestamps with strictly monotone one-to-one matching');
    const usedRight = new Set<number>();
    let cursor = 0;
    const sortedRight = [...right].sort((a, b) => a.timestampNs - b.timestampNs);
    for (const item of [...left].sort((a, b) => a.timestampNs - b.timestampNs)) {
      let best: number | null = null;
      let bestDistance = Infinity;
      for (let i = cursor; i < sortedRight.length; i += 1) {
        const candidate = sortedRight[i];
        const distance = Math.abs(candidate.timestampNs - item.timestampNs);
        if (candidate.timestampNs < item.timestampNs && distance > effectiveToleranceNs) {
          cursor = i + 1;
          continue;
        }
        if (distance > effectiveToleranceNs) break;
        if (!usedRight.has(candidate.index) && distance < bestDistance) {
          best = candidate.index;
          bestDistance = distance;
        }
      }
      if (best !== null) {
        usedRight.add(best);
        pairIndex.push([item.index, best]);
      }
    }
  }

  pairIndex.sort((a, b) => primary[a[0]].timestampNs - primary[b[0]].timestampNs || a[0] - b[0]);
  const matchedLeft = new Set(pairIndex.map(([i]) => i));
  const matchedRight = new Set(pairIndex.map(([, j]) => j));
  const pairs: ChannelPair[] = pairIndex.map(([i, j]) => ({
    primary: primary[i],
    reference: reference[j],
    offsetNs: reference[j].timestampNs - primary[i].timestampNs,
  }));
  const unmatchedPrimary = primary.length - matchedLeft.size;
  const unmatchedReference = reference.length - matchedRight.size;
  const complete = unmatchedPrimary === 0 && unmatchedReference === 0;
  if (!complete) {
    warnings.push(`Cross-spectrum degraded: ${matchedLeft.size} of ${primary.length} primary and ${matchedRight.size} of ${reference.length} reference observations paired one-to-one`);
  }
  return { pairs, unmatchedPrimary, unmatchedReference, complete, warnings };
}
