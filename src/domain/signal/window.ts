import { DomainError, invariant } from '../errors.ts';
import type { SynchronizedSample, WindowedSeries } from '../types.ts';

function hann(index: number, length: number): number {
  return length <= 1 ? 1 : 0.5 * (1 - Math.cos((2 * Math.PI * index) / (length - 1)));
}

export type SeriesBuildOptions = {
  startNs?: number;
  endNs?: number;
  /** Maximum allowed deviation of measured timestamps from the nominal sample grid (ns). */
  jitterToleranceNs?: number;
};

export type BuiltSeries = {
  series: WindowedSeries;
  warnings: string[];
};

/**
 * Builds a uniformly sampled series. The declared sample rate must be shared by
 * every sample; mixed rates are rejected instead of silently averaged. Small
 * timestamp jitter is allowed as long as every sample sits on the measured
 * median grid within `jitterToleranceNs`; missing observations (gaps) are
 * rejected because interpolating over them would fabricate samples. Window
 * boundaries are always taken from measured timestamps, never from the nominal
 * rate.
 */
export function buildSeries(
  samples: SynchronizedSample[],
  selector: (sample: SynchronizedSample) => number,
  options: SeriesBuildOptions = {},
): BuiltSeries {
  const { startNs, endNs } = options;
  const selected = samples
    .filter((sample) => (startNs === undefined || sample.timestampNs >= startNs) && (endNs === undefined || sample.timestampNs < endNs))
    .sort((a, b) => a.timestampNs - b.timestampNs || a.syncIndex - b.syncIndex);
  invariant(selected.length >= 2, 'INSUFFICIENT_SERIES', 'At least two samples are required for a series');

  const declaredRate = selected[0].sampleRateHz;
  invariant(declaredRate > 0 && Number.isFinite(declaredRate), 'INVALID_SERIES_RATE', 'Series sample rate must be positive');
  for (const sample of selected) {
    invariant(sample.sampleRateHz === declaredRate, 'NON_UNIFORM_SAMPLE_RATE', 'Cannot window a series with mixed sample rates; resample explicitly or split the analysis', { expectedHz: declaredRate, actualHz: sample.sampleRateHz, captureId: sample.captureId });
  }

  const nominalPeriodNs = 1e9 / declaredRate;
  const jitterToleranceNs = options.jitterToleranceNs ?? Math.min(2_000, nominalPeriodNs / 2);
  const timestampsNs = selected.map((sample) => sample.timestampNs);

  // Gaps (missing observations) are structurally different from jitter: an
  // interval much longer than the declared period means samples were dropped.
  const intervals = timestampsNs.slice(1).map((ts, index) => ts - timestampsNs[index]);
  if (intervals.some((interval) => interval <= 0)) {
    throw new DomainError('NON_MONOTONIC_TIME_BASE', 'Sample timestamps must be strictly increasing');
  }
  const largestGap = Math.max(...intervals);
  if (largestGap > nominalPeriodNs * 1.5) {
    throw new DomainError('SAMPLES_GAP', 'Sample stream contains a gap; refusing to interpolate missing observations', 422, { gapNs: largestGap, expectedPeriodNs: nominalPeriodNs });
  }

  // Fit the realized grid with a least-squares line t(i) = intercept + i*period
  // so symmetric jitter cancels out instead of skewing the time base.
  const count = timestampsNs.length;
  const meanIndex = (count - 1) / 2;
  const meanTs = timestampsNs.reduce((sum, ts) => sum + ts, 0) / count;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < count; index += 1) {
    numerator += (index - meanIndex) * (timestampsNs[index] - meanTs);
    denominator += (index - meanIndex) ** 2;
  }
  invariant(denominator > 0, 'NON_MONOTONIC_TIME_BASE', 'Sample timestamps must span a grid');
  const gridPeriodNs = numerator / denominator;
  invariant(gridPeriodNs > 0 && Number.isFinite(gridPeriodNs), 'NON_MONOTONIC_TIME_BASE', 'Sample timestamps must be strictly increasing');
  const measuredRate = 1e9 / gridPeriodNs;
  invariant(Math.abs(measuredRate - declaredRate) / declaredRate <= 0.05, 'SAMPLE_RATE_CONFLICT', 'Measured timestamp grid disagrees with the declared sample rate by more than 5%', { declaredHz: declaredRate, measuredHz: measuredRate });

  // Measure the worst residual against the fitted uniform grid.
  const intercept = meanTs - meanIndex * gridPeriodNs;
  let jitterNs = 0;
  for (let index = 0; index < count; index += 1) {
    const residual = Math.abs(timestampsNs[index] - (intercept + index * gridPeriodNs));
    if (residual > jitterNs) jitterNs = residual;
  }
  invariant(jitterNs <= jitterToleranceNs, 'CLOCK_JITTER_EXCEEDED', 'Timestamp jitter exceeds the synchronization tolerance; refusing to treat the stream as uniformly sampled', { jitterNs, toleranceNs: jitterToleranceNs });

  const warnings: string[] = [];
  if (jitterNs > 0) warnings.push(`Clock jitter of up to ${jitterNs} ns kept on the nominal ${declaredRate} Hz frequency grid`);

  const values = selected.map(selector);
  const weights = selected.map((sample) => (sample.quality === 'suspect' ? 0.5 : 1 / Math.max(sample.uncertainty, 1e-9)));
  const weighted = weights.reduce((sum, weight, index) => sum + values[index] * weight, 0) / weights.reduce((a, b) => a + b, 0);

  const series: WindowedSeries = {
    startNs: timestampsNs[0],
    endNs: timestampsNs.at(-1)!,
    sampleRateHz: declaredRate,
    timestampsNs,
    jitterNs,
    nominalPeriodNs,
    values: values.map((value) => value - weighted),
    weights,
  };
  return { series, warnings };
}

export function splitWindows(series: WindowedSeries, size: number, overlap = 0.5): WindowedSeries[] {
  invariant(Number.isInteger(size) && size >= 8, 'INVALID_WINDOW_SIZE', 'Window size must be an integer of at least 8');
  invariant(overlap >= 0 && overlap < 1, 'INVALID_OVERLAP', 'Window overlap must be in [0, 1)');
  const step = Math.max(1, Math.floor(size * (1 - overlap)));
  const result: WindowedSeries[] = [];
  for (let start = 0; start + size <= series.values.length; start += step) {
    const values = series.values.slice(start, start + size).map((value, index) => value * hann(index, size));
    const timestampsNs = series.timestampsNs.slice(start, start + size);
    result.push({
      startNs: timestampsNs[0],
      endNs: timestampsNs.at(-1)!,
      sampleRateHz: series.sampleRateHz,
      timestampsNs,
      jitterNs: series.jitterNs,
      nominalPeriodNs: series.nominalPeriodNs,
      values,
      weights: series.weights.slice(start, start + size),
    });
  }
  invariant(result.length > 0, 'WINDOW_NOT_FIT', 'Series does not contain a complete analysis window');
  return result;
}
