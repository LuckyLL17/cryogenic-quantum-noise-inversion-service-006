import { invariant } from '../errors.ts';
import type { NoiseClass, NoiseSummary, SpectrumBin } from '../types.ts';

export function insufficientNoise(coherence: number | null): NoiseSummary {
  return { class: 'insufficient-data', whiteLevel: 0, lowFrequencySlope: null, dominantFrequencyHz: null, integratedPower: 0, crossChannelCoherence: coherence, confidence: 0 };
}

function slopeAtLowFrequency(spectrum: SpectrumBin[]): number | null {
  const cutoff = spectrum[Math.floor(spectrum.length / 10)]?.frequencyHz ?? 1;
  const points = spectrum.filter((bin) => bin.frequencyHz > 0 && bin.frequencyHz <= Math.max(1, cutoff) && bin.power > 0);
  if (points.length < 2) return null;
  const first = points[0];
  const last = points.at(-1)!;
  return (Math.log(last.power) - Math.log(first.power)) / (Math.log(last.frequencyHz) - Math.log(first.frequencyHz));
}

export function summarizeNoise(spectrum: SpectrumBin[], coherence: number | null): NoiseSummary {
  invariant(spectrum.length > 0, 'EMPTY_SPECTRUM', 'Cannot classify noise without a spectrum');
  const positive = spectrum.filter((bin) => bin.frequencyHz > 0);
  if (!positive.length) return insufficientNoise(coherence);
  const slope = slopeAtLowFrequency(spectrum);
  const dominant = positive.reduce((best, item) => item.power > best.power ? item : best, positive[0]);
  const integratedPower = positive.reduce((sum, item) => sum + item.power, 0);
  const tailCount = Math.max(1, Math.floor(positive.length / 5));
  const whiteLevel = positive.slice(-tailCount).reduce((sum, item) => sum + item.power, 0) / tailCount;
  let noiseClass: NoiseClass = 'white';
  if (coherence !== null && coherence >= 0.7) noiseClass = 'correlated';
  else if (Math.abs(dominant.frequencyHz - positive[0].frequencyHz) <= positive[0].frequencyHz * 1.5) noiseClass = 'drift';
  else if (dominant.power > whiteLevel * 8) noiseClass = 'periodic';
  else if (slope !== null && slope < -0.35) noiseClass = 'flicker';
  const confidence = Math.min(1, 0.45 + Math.min(0.3, positive.length / 512) + (coherence !== null ? Math.abs(coherence - 0.5) * 0.3 : 0));
  return { class: noiseClass, whiteLevel, lowFrequencySlope: slope, dominantFrequencyHz: dominant.frequencyHz, integratedPower, crossChannelCoherence: coherence, confidence };
}
