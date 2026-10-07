import { createHash, randomUUID } from 'node:crypto';
import { DomainError, invariant } from '../domain/errors.ts';
import { applyCalibration } from '../domain/calibration/apply.ts';
import { synchronizeSamples } from '../domain/clock/synchronize.ts';
import { pairChannels } from '../domain/clock/pair.ts';
import { fitExponential } from '../domain/fit/decay.ts';
import { summarizeNoise } from '../domain/noise/classify.ts';
import { buildSeries, splitWindows } from '../domain/signal/window.ts';
import { crossSpectrum, periodogram } from '../domain/signal/spectrum.ts';
import type { AnalysisRequest, AnalysisResult, CrossSpectrumBin, NoiseSummary, SpectrumBin, SynchronizedSample, WindowedSeries } from '../domain/types.ts';

const MIN_WINDOW_SIZE = 8;

function digest(input: AnalysisRequest): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function mean(values: number[]): number { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function stddev(values: number[], average: number): number { return values.length ? Math.sqrt(mean(values.map((value) => (value - average) ** 2))) : 0; }

function chooseChannel(samples: SynchronizedSample[], channelId?: string): SynchronizedSample[] {
  const channels = [...new Set(samples.map((sample) => sample.channelId))];
  invariant(channels.length > 0, 'NO_CALIBRATED_CHANNELS', 'No calibrated channels are available');
  const selected = channelId ?? channels[0];
  const result = samples.filter((sample) => sample.channelId === selected);
  invariant(result.length >= 2, 'PRIMARY_CHANNEL_TOO_SHORT', 'Primary channel needs at least two calibrated samples', { channelId: selected });
  return result;
}

type SpectrumStage = {
  series: WindowedSeries;
  windows: WindowedSeries[];
  spectrum: SpectrumBin[];
  warnings: string[];
};

/** Builds a uniform series and windows; degrades to an empty spectrum when the data is too short for any window. */
function prepareSpectrum(
  samples: SynchronizedSample[],
  request: AnalysisRequest,
  startNs: number | undefined,
  endNs: number | undefined,
  explicitSize: boolean,
): SpectrumStage {
  const warnings: string[] = [];
  const { series, warnings: seriesWarnings } = buildSeries(samples, (sample) => sample.amplitude, {
    startNs,
    endNs,
    jitterToleranceNs: request.analysis?.syncToleranceNs ?? 2_000,
  });
  warnings.push(...seriesWarnings);
  const requestedSize = request.analysis?.windowSize ?? Math.min(128, series.values.length);
  if (!explicitSize && series.values.length < MIN_WINDOW_SIZE) {
    warnings.push(`Only ${series.values.length} samples available; spectrum analysis needs at least ${MIN_WINDOW_SIZE}, reporting insufficient-data`);
    return { series, windows: [], spectrum: [], warnings };
  }
  if (series.values.length < requestedSize && explicitSize) {
    throw new DomainError('WINDOW_NOT_FIT', `Configured window size ${requestedSize} exceeds the ${series.values.length} available samples`, 422);
  }
  const effectiveSize = Math.min(requestedSize, series.values.length);
  const windows = splitWindows(series, effectiveSize, request.analysis?.overlap ?? 0.5);
  const maxFrequencyHz = request.analysis?.maxFrequencyHz ?? Number.POSITIVE_INFINITY;
  const nyquistHz = series.sampleRateHz / 2;
  if (maxFrequencyHz !== Number.POSITIVE_INFINITY && maxFrequencyHz > nyquistHz) {
    warnings.push(`Requested max frequency ${maxFrequencyHz} Hz exceeds Nyquist ${nyquistHz} Hz; bins above Nyquist cannot be resolved`);
  }
  return { series, windows, spectrum: periodogram(windows, maxFrequencyHz), warnings };
}

const INSUFFICIENT_NOISE: NoiseSummary = {
  class: 'insufficient-data', whiteLevel: 0, lowFrequencySlope: null, dominantFrequencyHz: null,
  integratedPower: 0, crossChannelCoherence: null, confidence: 0,
};

export function analyzeExperiment(request: AnalysisRequest): AnalysisResult {
  invariant(request.experimentId.length > 0, 'INVALID_EXPERIMENT_ID', 'Experiment id is required');
  const warnings: string[] = [];
  const syncToleranceNs = request.analysis?.syncToleranceNs ?? 2_000;

  const sync = synchronizeSamples(request.samples, syncToleranceNs);
  const calibrated = applyCalibration(sync.samples, request.calibrations);
  const primary = chooseChannel(calibrated, request.primaryChannelId);

  const stage = prepareSpectrum(primary, request, undefined, undefined, request.analysis?.windowSize !== undefined);
  warnings.push(...stage.warnings);
  const primarySpectrum = stage.spectrum;
  const primarySeries = stage.series;
  const primaryWindows = stage.windows;

  // ---- Reference channel: only a complete one-to-one pairing produces a cross-spectrum ----
  let cross: CrossSpectrumBin[] = [];
  let coherent: number | null = null;
  if (request.referenceChannelId) {
    if (request.referenceChannelId === primary[0].channelId) {
      warnings.push('Reference channel is the same as the primary channel; running single-channel analysis without a cross-spectrum');
      warnings.push(...sync.warnings);
    } else {
      const referencePool = calibrated.filter((sample) => sample.channelId === request.referenceChannelId);
      invariant(referencePool.length > 0, 'REFERENCE_CHANNEL_NOT_FOUND', 'Configured reference channel has no calibrated samples', { channelId: request.referenceChannelId });
      const nominalPeriodNs = 1e9 / primary[0].sampleRateHz;
      const pairing = pairChannels(primary, referencePool, { toleranceNs: syncToleranceNs, effectiveToleranceNs: Math.min(syncToleranceNs, nominalPeriodNs / 2) });
      // Skew warnings only add noise when pairing already explains the deficit.
      for (const message of sync.warnings) {
        if (pairing.complete || !message.includes('synchronization tolerance')) warnings.push(message);
      }
      warnings.push(...pairing.warnings);
      if (pairing.complete) {
        const referenceSamples = pairing.pairs.map((pair) => pair.reference);
        const referenceRate = referenceSamples[0].sampleRateHz;
        const rateConsistent = referenceSamples.every((sample) => sample.sampleRateHz === referenceRate);
        if (!rateConsistent || referenceRate !== primarySeries.sampleRateHz) {
          warnings.push(`Cross-spectrum degraded: reference sample rate ${rateConsistent ? referenceRate : 'mixed'} Hz does not match primary ${primarySeries.sampleRateHz} Hz; frequency axes are incompatible`);
        } else if (primaryWindows.length === 0) {
          warnings.push('Cross-spectrum skipped: primary channel is too short for a complete window');
        } else {
          try {
            const referenceStage = prepareSpectrum(referenceSamples, request, undefined, undefined, request.analysis?.windowSize !== undefined);
            // Paired series have identical length; window counts must agree as a defensive check.
            if (referenceStage.windows.length !== primaryWindows.length) {
              warnings.push('Cross-spectrum degraded: paired channels produced different window counts');
            } else {
              warnings.push(...referenceStage.warnings.filter((message) => !message.startsWith('Only ')));
              cross = crossSpectrum(primaryWindows, referenceStage.windows, request.analysis?.maxFrequencyHz ?? Number.POSITIVE_INFINITY);
              const binCoherence = cross.map((bin) => bin.coherence).filter((value): value is number => value !== null);
              if (binCoherence.length < cross.length || primaryWindows.length < 2) {
                warnings.push(`Cross-spectrum built from ${primaryWindows.length} window(s); coherence is not estimable with fewer than two windows and is reported as null`);
              }
              coherent = binCoherence.length ? mean(binCoherence) : null;
            }
          } catch (error) {
            if (error instanceof DomainError) warnings.push(`Cross-spectrum degraded: reference time base is unusable (${error.code})`);
            else throw error;
          }
        }
      }
      // Pairing incomplete: no cross-spectrum, pairing.warnings already explain the deficit.
    }
  } else {
    warnings.push(...sync.warnings);
  }

  const noise = summarizeNoise(primarySpectrum, coherent);
  const decay = request.kind === 'noise-only' ? null : fitExponential(primary, request.analysis?.fitStartNs, request.analysis?.fitEndNs);
  const amplitudes = primary.map((sample) => sample.amplitude);
  const phases = primary.map((sample) => sample.phaseRad);

  const scanResults = (request.analysis?.scan ?? []).map((scan, index) => {
    const label = request.analysis!.scan![index].label;
    try {
      const scanSamples = calibrated.filter((sample) => !scan.channelId || sample.channelId === scan.channelId);
      if (scanSamples.length < 2) throw new DomainError('SCAN_CHANNEL_TOO_SHORT', `Scan "${label}" needs at least two samples`);
      const scanStage = prepareSpectrum(scanSamples, request, scan.startNs, scan.endNs, request.analysis?.windowSize !== undefined);
      for (const message of scanStage.warnings) warnings.push(`Scan "${label}": ${message}`);
      return { label, noise: summarizeNoise(scanStage.spectrum, null), decay: fitExponential(scanSamples, scan.startNs, scan.endNs) };
    } catch (error) {
      const reason = error instanceof DomainError ? error.message : 'unknown error';
      warnings.push(`Scan "${label}" skipped: ${reason}`);
      return { label, noise: { ...INSUFFICIENT_NOISE }, decay: null };
    }
  });

  const calibrationVersions = [...new Set(calibrated.map((sample) => sample.calibrationProfileId))].sort();
  const rawPhaseDrift = phases.at(-1)! - phases[0];
  const phaseDriftRad = Math.atan2(Math.sin(rawPhaseDrift), Math.cos(rawPhaseDrift));
  return {
    analysisId: randomUUID(), experimentId: request.experimentId, kind: request.kind, inputDigest: digest(request), calibrationVersions,
    metrics: { sampleCount: calibrated.length, channelCount: new Set(calibrated.map((sample) => sample.channelId)).size, durationNs: sync.samples.at(-1)!.timestampNs - sync.samples[0].timestampNs, triggerCount: sync.triggerCount, droppedSamples: sync.droppedSamples, medianSkewNs: sync.medianSkewNs, amplitudeMean: mean(amplitudes), amplitudeStdDev: stddev(amplitudes, mean(amplitudes)), phaseDriftRad, decay },
    primarySpectrum, crossSpectrum: cross, noise, scanResults, warnings,
  };
}
