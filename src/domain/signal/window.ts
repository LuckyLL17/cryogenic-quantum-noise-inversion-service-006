import { invariant } from '../errors.ts';
import { assessTimebase, DEFAULT_JITTER_RATIO, type TimebaseAssessment } from '../clock/timebase.ts';
import type { SynchronizedSample, WindowedSeries } from '../types.ts';

export type SeriesBuild = {
  series: WindowedSeries | null;
  timebase: TimebaseAssessment | null;
  /** Set when no spectrum may be derived from these samples on a common grid. */
  reason: 'too-few-samples' | 'irregular-timebase' | null;
  selectedSamples: number;
};

function hann(index: number, length: number): number {
  return length <= 1 ? 1 : 0.5 * (1 - Math.cos((2 * Math.PI * index) / (length - 1)));
}

/**
 * Build a time-ordered, de-meaned series for one channel.
 *
 * The frequency axis comes from the *observed* sample spacing, never from an
 * arithmetic mean of declared sample rates (a rate change mid-capture must not
 * be averaged away). Irregular time bases are rejected with an explicit reason
 * so callers degrade loudly; uniform and lightly jittered grids are accepted.
 */
export function buildSeries(
  samples: SynchronizedSample[],
  selector: (sample: SynchronizedSample) => number,
  startNs?: number,
  endNs?: number,
  sampleRateOverrideHz?: number,
): SeriesBuild {
  const selected = samples
    .filter((sample) => (startNs === undefined || sample.timestampNs >= startNs) && (endNs === undefined || sample.timestampNs < endNs))
    .sort((a, b) => a.timestampNs - b.timestampNs || a.syncIndex - b.syncIndex);
  if (selected.length < 2) return { series: null, timebase: null, reason: 'too-few-samples', selectedSamples: selected.length };

  const timebase = assessTimebase(selected, DEFAULT_JITTER_RATIO);
  if (timebase.status === 'irregular' || !Number.isFinite(timebase.observedRateHz) || timebase.observedRateHz <= 0) {
    return { series: null, timebase, reason: 'irregular-timebase', selectedSamples: selected.length };
  }

  // Paired channels must share one frequency axis; the caller supplies the
  // common rate after validating the grids agree.
  const sampleRateHz = sampleRateOverrideHz ?? timebase.observedRateHz;
  invariant(sampleRateHz > 0 && Number.isFinite(sampleRateHz), 'INVALID_SERIES_RATE', 'Series sample rate must be positive');
  const values = selected.map(selector);
  const weights = selected.map((sample) => sample.quality === 'suspect' ? 0.5 : 1 / Math.max(sample.uncertainty, 1e-9));
  const mean = values.reduce((sum, value, index) => sum + value * weights[index], 0) / weights.reduce((a, b) => a + b, 0);
  const series: WindowedSeries = {
    startNs: selected[0].timestampNs,
    endNs: selected[selected.length - 1].timestampNs,
    sampleRateHz,
    values: values.map((value) => value - mean),
    weights,
  };
  return { series, timebase, reason: null, selectedSamples: selected.length };
}

/** Build a series from already one-to-one paired samples; both grids must agree. */
export function buildPairedSeries(
  paired: Array<{ primary: SynchronizedSample; reference: SynchronizedSample }>,
  side: 'primary' | 'reference',
  selector: (sample: SynchronizedSample) => number,
  sampleRateOverrideHz?: number,
): SeriesBuild {
  const samples = paired.map((pair) => pair[side]).sort((a, b) => a.timestampNs - b.timestampNs || a.syncIndex - b.syncIndex);
  return buildSeries(samples, selector, undefined, undefined, sampleRateOverrideHz);
}

export function splitWindows(series: WindowedSeries, size: number, overlap = 0.5): WindowedSeries[] {
  invariant(Number.isInteger(size) && size >= 8, 'INVALID_WINDOW_SIZE', 'Window size must be an integer of at least 8');
  invariant(overlap >= 0 && overlap < 1, 'INVALID_OVERLAP', 'Window overlap must be in [0, 1)');
  const step = Math.max(1, Math.floor(size * (1 - overlap)));
  const result: WindowedSeries[] = [];
  for (let start = 0; start + size <= series.values.length; start += step) {
    const values = series.values.slice(start, start + size).map((value, index) => value * hann(index, size));
    result.push({ startNs: series.startNs + (start * 1e9) / series.sampleRateHz, endNs: series.startNs + ((start + size) * 1e9) / series.sampleRateHz, sampleRateHz: series.sampleRateHz, values, weights: series.weights.slice(start, start + size) });
  }
  invariant(result.length > 0, 'WINDOW_NOT_FIT', 'Series does not contain a complete analysis window');
  return result;
}
