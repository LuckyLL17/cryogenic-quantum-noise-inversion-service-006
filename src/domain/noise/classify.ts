import type { NoiseClass, NoiseSummary, SpectrumBin } from '../types.ts';

const INSUFFICIENT: NoiseSummary = {
  class: 'insufficient-data',
  whiteLevel: 0,
  lowFrequencySlope: null,
  dominantFrequencyHz: null,
  integratedPower: 0,
  crossChannelCoherence: null,
  confidence: 0,
};

/** Log-log slope over the lowest decade of the resolved band (up to 10 % of Nyquist). */
function slopeAtLowFrequency(spectrum: SpectrumBin[]): number | null {
  const positive = spectrum.filter((bin) => bin.frequencyHz > 0 && bin.power > 0);
  if (positive.length < 2) return null;
  const nyquist = spectrum.at(-1)!.frequencyHz;
  const cutoff = Math.max(positive[1].frequencyHz, nyquist * 0.1);
  const points = positive.filter((bin) => bin.frequencyHz <= cutoff);
  if (points.length < 2) return null;
  const first = points[0];
  const last = points.at(-1)!;
  if (last.frequencyHz === first.frequencyHz) return null;
  return (Math.log(last.power) - Math.log(first.power)) / (Math.log(last.frequencyHz) - Math.log(first.frequencyHz));
}

export function summarizeNoise(spectrum: SpectrumBin[], coherence: number | null): NoiseSummary {
  // Degraded analyses (no complete window, single-channel runs) arrive here
  // without a usable spectrum; return an explicit class instead of throwing.
  if (!spectrum.length) return { ...INSUFFICIENT, crossChannelCoherence: coherence };
  const positive = spectrum.filter((bin) => bin.frequencyHz > 0 && bin.power > 0);
  if (!positive.length) return { ...INSUFFICIENT, crossChannelCoherence: coherence };

  const slope = slopeAtLowFrequency(spectrum);
  const dominant = positive.reduce((best, item) => (item.power > best.power ? item : best), positive[0]);
  const integratedPower = positive.reduce((sum, item) => sum + item.power, 0);
  const tailCount = Math.max(1, Math.floor(positive.length / 5));
  const whiteLevel = positive.slice(-tailCount).reduce((sum, item) => sum + item.power, 0) / tailCount;
  const nyquist = positive.at(-1)!.frequencyHz;
  // A dominant bin is a low-end drift only when it is genuinely close to DC,
  // not merely the first resolved bin of a sparse spectrum.
  const lowBandEdge = Math.max(positive[0].frequencyHz, nyquist * 0.02);

  let noiseClass: NoiseClass = 'white';
  if (coherence !== null && coherence >= 0.7) noiseClass = 'correlated';
  else if (dominant.frequencyHz <= lowBandEdge) noiseClass = 'drift';
  else if (dominant.power > whiteLevel * 8) noiseClass = 'periodic';
  else if (slope !== null && slope < -0.35) noiseClass = 'flicker';

  // Confidence grows with the amount of resolved spectral information and, for
  // the correlated decision, with how decisively coherence sits away from the
  // ambiguous mid-range. Single-channel analyses simply omit the coherence term.
  const resolutionTerm = Math.min(0.35, positive.length / 256);
  const coherenceTerm = coherence === null
    ? 0.1
    : coherence >= 0.7
      ? Math.min(0.25, (coherence - 0.7) * 0.83 + 0.1)
      : 0;
  const confidence = Math.min(1, 0.35 + resolutionTerm + coherenceTerm);

  return {
    class: noiseClass,
    whiteLevel,
    lowFrequencySlope: slope,
    dominantFrequencyHz: dominant.frequencyHz,
    integratedPower,
    crossChannelCoherence: coherence,
    confidence,
  };
}
