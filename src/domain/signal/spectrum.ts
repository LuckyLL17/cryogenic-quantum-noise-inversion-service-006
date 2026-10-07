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

/** All windows must share one sample rate and length so averaged bins describe one frequency axis. */
function assertUniformWindows(windows: WindowedSeries[]): { rate: number; size: number } {
  const rate = windows[0].sampleRateHz;
  const size = windows[0].values.length;
  for (const window of windows) {
    invariant(window.sampleRateHz === rate, 'MIXED_WINDOW_RATE', 'Windows with different sample rates cannot share a frequency axis');
    invariant(window.values.length === size, 'MIXED_WINDOW_SIZE', 'Windows with different lengths cannot be averaged');
  }
  return { rate, size };
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
  const { rate, size } = assertUniformWindows(windows);
  const perWindow = windows.map((window) => {
    const transformed = dft(window.values);
    const normalization = rate * size;
    return transformed
      .map((value, index) => {
        const frequencyHz = (index * rate) / size;
        const power = (value.real ** 2 + value.imag ** 2) / Math.max(normalization, 1);
        return { frequencyHz, power, amplitude: Math.sqrt(power) };
      })
      .filter((bin) => bin.frequencyHz <= maxFrequencyHz);
  });
  return averageBins(perWindow);
}

/**
 * Welch cross-spectrum over paired windows. Coherence is estimated from
 * ensemble averages (|<sum A B*>|^2 / (<|A|^2><|B|^2>)); with a single segment
 * the ratio is identically 1 for any signals and would falsely report perfect
 * coherence, so it is returned as null. The two sides must describe the same
 * frequency axis: identical rate and window length.
 */
export function crossSpectrum(left: WindowedSeries[], right: WindowedSeries[], maxFrequencyHz = Number.POSITIVE_INFINITY): CrossSpectrumBin[] {
  invariant(maxFrequencyHz > 0 || maxFrequencyHz === Number.POSITIVE_INFINITY, 'INVALID_MAX_FREQUENCY', 'Maximum frequency must be positive');
  invariant(left.length === right.length && left.length > 0, 'CROSS_WINDOW_MISMATCH', 'Cross-spectrum requires paired windows');
  const leftShape = assertUniformWindows(left);
  const rightShape = assertUniformWindows(right);
  invariant(leftShape.rate === rightShape.rate, 'CROSS_RATE_MISMATCH', 'Cross-spectrum requires identical sample rates; frequency axes would otherwise disagree', { leftHz: leftShape.rate, rightHz: rightShape.rate });
  invariant(leftShape.size === rightShape.size, 'CROSS_LENGTH_MISMATCH', 'Cross-spectrum requires equal-length windows', { leftSize: leftShape.size, rightSize: rightShape.size });
  const { rate, size } = leftShape;
  const segments = left.length;
  const bins = Math.floor(size / 2) + 1;
  const sumCrossReal = new Array<number>(bins).fill(0);
  const sumCrossImag = new Array<number>(bins).fill(0);
  const sumLeftPower = new Array<number>(bins).fill(0);
  const sumRightPower = new Array<number>(bins).fill(0);
  const sumSin = new Array<number>(bins).fill(0);
  const sumCos = new Array<number>(bins).fill(0);

  for (let windowIndex = 0; windowIndex < segments; windowIndex += 1) {
    const a = dft(left[windowIndex].values);
    const b = dft(right[windowIndex].values);
    for (let index = 0; index < bins; index += 1) {
      // Cross-periodogram A * conj(B).
      const crossReal = a[index].real * b[index].real + a[index].imag * b[index].imag;
      const crossImag = a[index].imag * b[index].real - a[index].real * b[index].imag;
      sumCrossReal[index] += crossReal;
      sumCrossImag[index] += crossImag;
      sumLeftPower[index] += a[index].real ** 2 + a[index].imag ** 2;
      sumRightPower[index] += b[index].real ** 2 + b[index].imag ** 2;
      const phase = Math.atan2(crossImag, crossReal);
      sumSin[index] += Math.sin(phase);
      sumCos[index] += Math.cos(phase);
    }
  }

  const normalization = rate * size;
  const result: CrossSpectrumBin[] = [];
  for (let index = 0; index < bins; index += 1) {
    const frequencyHz = (index * rate) / size;
    if (frequencyHz > maxFrequencyHz) continue;
    const crossMagnitude = Math.hypot(sumCrossReal[index], sumCrossImag[index]) / segments;
    const leftPower = sumLeftPower[index] / segments;
    const rightPower = sumRightPower[index] / segments;
    const coherence = segments >= 2 && leftPower > 0 && rightPower > 0
      ? Math.min(1, crossMagnitude ** 2 / (leftPower * rightPower))
      : null;
    const phaseRad = Math.atan2(sumSin[index], sumCos[index]);
    const power = crossMagnitude / Math.max(normalization, 1);
    result.push({ frequencyHz, power, amplitude: Math.sqrt(power), coherence, phaseRad });
  }
  return result;
}
