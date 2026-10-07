import type { SynchronizedSample } from '../types.ts';

export type TimebaseStatus = 'uniform' | 'jittered' | 'irregular';

export type TimebaseAssessment = {
  status: TimebaseStatus;
  /** Sample period in ns estimated from the observed span (end-to-end / intervals). */
  observedPeriodNs: number;
  /** Sample rate derived from observed timestamps, Hz. */
  observedRateHz: number;
  /** Declared rate is trusted only when every sample agrees on it. */
  declaredRateHz: number | null;
  declaredRateMismatch: boolean;
  maxJitterNs: number;
  medianSkewNs: number;
};

/**
 * Clock jitter up to this fraction of one nominal sample period is treated as a
 * small timing wobble ("jittered"); larger deviations mean dropped samples or a
 * genuinely non-uniform time base ("irregular"), which must not be FFT-averaged
 * silently.
 */
export const DEFAULT_JITTER_RATIO = 0.05;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Assess the time base of one channel using timestamps as the source of truth.
 *
 * - uniform:   every spacing equals the nominal period within 1%
 * - jittered:  every spacing stays within jitterRatio of the nominal period,
 *              i.e. small clock wobble with no missing samples
 * - irregular: a gap (dropped sample / duplicate timestamp) or a rate change
 *              mid-capture. Callers must degrade explicitly instead of
 *              averaging contradictory rates.
 */
export function assessTimebase(
  samples: SynchronizedSample[],
  jitterRatio: number = DEFAULT_JITTER_RATIO,
): TimebaseAssessment {
  const ordered = [...samples].sort((a, b) => a.timestampNs - b.timestampNs || a.syncIndex - b.syncIndex);
  const spacings: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    spacings.push(ordered[index].timestampNs - ordered[index - 1].timestampNs);
  }
  const declaredValues = [...new Set(ordered.map((sample) => sample.sampleRateHz))];
  const declaredRateHz = declaredValues.length === 1 ? declaredValues[0] : null;

  if (spacings.length === 0) {
    return {
      status: 'uniform',
      observedPeriodNs: declaredRateHz ? 1e9 / declaredRateHz : NaN,
      observedRateHz: declaredRateHz ?? NaN,
      declaredRateHz,
      declaredRateMismatch: false,
      maxJitterNs: 0,
      medianSkewNs: 0,
    };
  }

  const invalidSpacing = spacings.some((value) => !Number.isFinite(value) || value <= 0);
  // Total span over interval count is an unbiased estimate of the true period
  // when no interval is missing (it absorbs alternating clock wobble). The
  // median flags gaps: a dropped sample makes one spacing ~2x its neighbours.
  const positive = spacings.filter((value) => value > 0);
  const spanPeriodNs = positive.length
    ? (ordered[ordered.length - 1].timestampNs - ordered[0].timestampNs) / (ordered.length - 1)
    : NaN;
  const medianSpacingNs = median(positive);
  const hasGap = positive.some((spacing) => spacing > medianSpacingNs * 1.5 + 1);

  let status: TimebaseStatus;
  let observedPeriodNs = NaN;
  let maxJitterNs = NaN;
  let medianSkewNs = NaN;

  if (invalidSpacing || !Number.isFinite(spanPeriodNs) || spanPeriodNs <= 0) {
    status = 'irregular';
  } else {
    observedPeriodNs = spanPeriodNs;
    const skews = positive.map((spacing) => Math.abs(spacing - spanPeriodNs));
    maxJitterNs = Math.max(...skews);
    medianSkewNs = median(skews);
    const within = (ratio: number) => (spacing: number) => Math.abs(spacing - spanPeriodNs) <= spanPeriodNs * ratio;
    if (hasGap) status = 'irregular';
    else if (positive.every(within(0.01))) status = 'uniform';
    else if (positive.every(within(jitterRatio))) status = 'jittered';
    else status = 'irregular';
  }

  const observedRateHz = Number.isFinite(observedPeriodNs) && observedPeriodNs > 0 ? 1e9 / observedPeriodNs : NaN;
  const declaredRateMismatch = declaredRateHz !== null
    && Number.isFinite(observedRateHz)
    && Math.abs(declaredRateHz - observedRateHz) / observedRateHz > 0.01;

  return { status, observedPeriodNs, observedRateHz, declaredRateHz, declaredRateMismatch, maxJitterNs, medianSkewNs };
}
