import { invariant } from '../errors.ts';
import type { CrossSpectrumBin, SpectrumBin, WindowedSeries } from '../types.ts';

function dft(values: number[]): { real: number; imag: number }[] {
  const n = values.length;
  return Array.from({ length: Math.floor(n / 2) + 1 }, (_, k) => {
    let real = 0;
    let imag = 0;
    for (let index = 0; index < n; index += 1) {
      const angle = (2 * Math.PI * k * index) / n;
      real += values[index] * Math.cos(angle);
      imag -= values[index] * Math.sin(angle);
    }
    return { real, imag };
  });
}

function consistentGrid(windows: WindowedSeries[], label: string): void {
  const rate = windows[0].sampleRateHz;
  const length = windows[0].values.length;
  invariant(
    windows.every((window) => window.sampleRateHz === rate && window.values.length === length),
    'INCONSISTENT_SPECTRUM_GRID',
    `${label} windows must share one sample rate and length; frequency axes would otherwise be contradictory`,
  );
}

function averageBins(bins: SpectrumBin[][]): SpectrumBin[] {
  if (!bins.length) return [];
  return bins[0].map((_, index) => ({
    frequencyHz: bins[0][index].frequencyHz,
    power: bins.reduce((sum, bin) => sum + bin[index].power, 0) / bins.length,
    amplitude: bins.reduce((sum, bin) => sum + bin[index].amplitude, 0) / bins.length,
  }));
}

export function periodogram(windows: WindowedSeries[], maxFrequencyHz = Number.POSITIVE_INFINITY): SpectrumBin[] {
  invariant(maxFrequencyHz > 0 || maxFrequencyHz === Number.POSITIVE_INFINITY, 'INVALID_MAX_FREQUENCY', 'Maximum frequency must be positive');
  invariant(windows.length > 0, 'EMPTY_WINDOWS', 'At least one analysis window is required');
  consistentGrid(windows, 'Periodogram');
  const sampleRateHz = windows[0].sampleRateHz;
  const size = windows[0].values.length;
  const perWindow = windows.map((window) => {
    const transformed = dft(window.values);
    const normalization = sampleRateHz * size;
    return transformed.map((value, index) => {
      const frequencyHz = (index * sampleRateHz) / size;
      const power = (value.real ** 2 + value.imag ** 2) / Math.max(normalization, 1);
      return { frequencyHz, power, amplitude: Math.sqrt(power) };
    }).filter((bin) => bin.frequencyHz <= maxFrequencyHz);
  });
  return averageBins(perWindow);
}

/**
 * Welch-style cross-spectrum.
 *
 * Coherence is estimated from *averaged* cross- and auto-powers over all
 * windows: gamma^2 = |mean(AB*)|^2 / (mean(|A|^2) * mean(|B|^2)). A single
 * window makes this ratio identically one by Cauchy-Schwarz, which is not a
 * measurement of coherence - those bins return null coherence (power and phase
 * remain available). At least two windows are required for any non-null bin.
 */
export function crossSpectrum(left: WindowedSeries[], right: WindowedSeries[], maxFrequencyHz = Number.POSITIVE_INFINITY): CrossSpectrumBin[] {
  invariant(maxFrequencyHz > 0 || maxFrequencyHz === Number.POSITIVE_INFINITY, 'INVALID_MAX_FREQUENCY', 'Maximum frequency must be positive');
  invariant(left.length === right.length && left.length > 0, 'CROSS_WINDOW_MISMATCH', 'Cross-spectrum requires paired windows');
  consistentGrid(left, 'Cross-spectrum primary');
  consistentGrid(right, 'Cross-spectrum reference');
  invariant(
    left[0].sampleRateHz === right[0].sampleRateHz && left[0].values.length === right[0].values.length,
    'CROSS_GRID_MISMATCH',
    'Primary and reference windows must share sample rate and length for a common frequency axis',
  );

  const sampleRateHz = left[0].sampleRateHz;
  const size = left[0].values.length;
  const bins = Math.floor(size / 2) + 1;
  const segments = left.length;
  const sumCrossReal = new Array<number>(bins).fill(0);
  const sumCrossImag = new Array<number>(bins).fill(0);
  const sumLeftPower = new Array<number>(bins).fill(0);
  const sumRightPower = new Array<number>(bins).fill(0);
  const sumCrossMag = new Array<number>(bins).fill(0);
  const sumSin = new Array<number>(bins).fill(0);
  const sumCos = new Array<number>(bins).fill(0);

  for (let windowIndex = 0; windowIndex < segments; windowIndex += 1) {
    const a = dft(left[windowIndex].values);
    const b = dft(right[windowIndex].values);
    for (let k = 0; k < bins; k += 1) {
      // Cross-power A * conj(B).
      const crossReal = a[k].real * b[k].real + a[k].imag * b[k].imag;
      const crossImag = a[k].imag * b[k].real - a[k].real * b[k].imag;
      sumCrossReal[k] += crossReal;
      sumCrossImag[k] += crossImag;
      sumLeftPower[k] += a[k].real ** 2 + a[k].imag ** 2;
      sumRightPower[k] += b[k].real ** 2 + b[k].imag ** 2;
      const mag = Math.hypot(crossReal, crossImag);
      sumCrossMag[k] += mag;
      sumSin[k] += mag > 0 ? crossImag / mag : 0;
      sumCos[k] += mag > 0 ? crossReal / mag : 0;
    }
  }

  const normalization = sampleRateHz * size;
  const result: CrossSpectrumBin[] = [];
  for (let k = 0; k < bins; k += 1) {
    const frequencyHz = (k * sampleRateHz) / size;
    if (frequencyHz > maxFrequencyHz) continue;
    const meanCrossReal = sumCrossReal[k] / segments;
    const meanCrossImag = sumCrossImag[k] / segments;
    const meanLeftPower = sumLeftPower[k] / segments;
    const meanRightPower = sumRightPower[k] / segments;
    const denominator = meanLeftPower * meanRightPower;
    // One window (or zero-energy bins) cannot identify coherence.
    const rawCoherence = denominator > 0 && segments >= 2
      ? (meanCrossReal ** 2 + meanCrossImag ** 2) / denominator
      : null;
    const coherence = rawCoherence === null ? null : Math.min(1, Math.max(0, rawCoherence));
    result.push({
      frequencyHz,
      power: Math.hypot(meanCrossReal, meanCrossImag) / Math.max(normalization, 1),
      amplitude: Math.sqrt(sumCrossMag[k] / segments / Math.max(normalization, 1)),
      coherence,
      phaseRad: Math.atan2(sumSin[k], sumCos[k]),
    });
  }
  return result;
}
