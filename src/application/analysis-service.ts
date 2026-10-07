import { createHash, randomUUID } from 'node:crypto';
import { invariant } from '../domain/errors.ts';
import { applyCalibration } from '../domain/calibration/apply.ts';
import { pairChannels, synchronizeSamples, type ChannelPair } from '../domain/clock/synchronize.ts';
import { fitExponential } from '../domain/fit/decay.ts';
import { insufficientNoise, summarizeNoise } from '../domain/noise/classify.ts';
import { buildPairedSeries, buildSeries, splitWindows, type SeriesBuild } from '../domain/signal/window.ts';
import { crossSpectrum, periodogram } from '../domain/signal/spectrum.ts';
import type { AnalysisRequest, AnalysisResult, CrossSpectrumBin, NoiseSummary, SpectrumBin, SynchronizedSample, WindowedSeries } from '../domain/types.ts';

function digest(input: AnalysisRequest): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function mean(values: number[]): number { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function stddev(values: number[], average: number): number { return values.length ? Math.sqrt(mean(values.map((value) => (value - average) ** 2))) : 0; }

function chooseChannel(samples: SynchronizedSample[], channelId: string | undefined, role: 'primary' | 'reference'): SynchronizedSample[] {
  const channels = [...new Set(samples.map((sample) => sample.channelId))].sort();
  invariant(channels.length > 0, 'NO_CALIBRATED_CHANNELS', 'No calibrated channels are available');
  if (channelId) {
    const result = samples.filter((sample) => sample.channelId === channelId);
    invariant(result.length > 0, role === 'primary' ? 'PRIMARY_CHANNEL_NOT_FOUND' : 'REFERENCE_CHANNEL_NOT_FOUND',
      role === 'primary' ? 'Requested primary channel has no samples' : 'Requested reference channel has no samples', { channelId });
    return result;
  }
  return samples.filter((sample) => sample.channelId === channels[0]);
}

function validateWindowSize(request: AnalysisRequest): void {
  const size = request.analysis?.windowSize;
  if (size !== undefined) {
    invariant(Number.isInteger(size) && size >= 8, 'INVALID_WINDOW_SIZE', 'Window size must be an integer of at least 8', { windowSize: size });
  }
  const overlap = request.analysis?.overlap;
  if (overlap !== undefined) {
    invariant(overlap >= 0 && overlap < 1, 'INVALID_OVERLAP', 'Window overlap must be in [0, 1)', { overlap });
  }
  const maxFrequencyHz = request.analysis?.maxFrequencyHz;
  if (maxFrequencyHz !== undefined) {
    invariant(maxFrequencyHz > 0, 'INVALID_MAX_FREQUENCY', 'Maximum frequency must be positive', { maxFrequencyHz });
  }
}

function resolveWindowSize(series: WindowedSeries, requested: number | undefined): number {
  // Auto-sizing adapts to the series; an explicitly requested size is passed
  // through verbatim so callers learn when their data cannot fill it.
  return requested ?? Math.min(128, series.values.length);
}

function makeWindows(series: WindowedSeries, request: AnalysisRequest): WindowedSeries[] | null {
  const size = resolveWindowSize(series, request.analysis?.windowSize);
  if (size < 8) return null;
  try {
    const windows = splitWindows(series, size, request.analysis?.overlap ?? 0.5);
    return windows.length ? windows : null;
  } catch (error) {
    if ((error as { code?: string }).code === 'WINDOW_NOT_FIT') return null;
    throw error;
  }
}

/** Coherence is averaged over positive-frequency bins Welch could estimate. */
function meanCoherence(cross: CrossSpectrumBin[]): number | null {
  const values = cross.filter((bin) => bin.frequencyHz > 0 && bin.coherence !== null).map((bin) => bin.coherence as number);
  return values.length ? mean(values) : null;
}

function spectrumFromBuild(build: SeriesBuild, request: AnalysisRequest, context: string, warnings: string[]): SpectrumBin[] {
  if (!build.series || build.reason) {
    if (build.reason === 'irregular-timebase') {
      warnings.push(`${context}: non-uniform time base (missing/duplicate samples or rate change); spectrum suppressed instead of averaging inconsistent sample rates`);
    } else {
      warnings.push(`${context}: fewer than two samples on a usable time grid; spectrum suppressed`);
    }
    return [];
  }
  if (build.timebase?.status === 'jittered') {
    warnings.push(`${context}: clock jitter up to ${build.timebase.maxJitterNs.toFixed(0)} ns; frequency axis uses observed sample rate ${build.timebase.observedRateHz.toFixed(3)} Hz`);
  }
  if (build.timebase?.declaredRateMismatch && build.timebase.declaredRateHz !== null) {
    warnings.push(`${context}: declared sample rate ${build.timebase.declaredRateHz} Hz disagrees with timestamps (${build.timebase.observedRateHz.toFixed(3)} Hz); using observed rate`);
  }
  const windows = makeWindows(build.series, request);
  if (!windows) {
    warnings.push(`${context}: series too short for an analysis window of ${request.analysis?.windowSize ?? 'auto'} samples; spectrum suppressed`);
    return [];
  }
  return periodogram(windows, request.analysis?.maxFrequencyHz ?? Number.POSITIVE_INFINITY);
}

function analyzeScan(request: AnalysisRequest, samples: SynchronizedSample[], label: string, channelId: string, warnings: string[]): { noise: NoiseSummary; decay: ReturnType<typeof fitExponential> } {
  const scoped = samples.filter((sample) => sample.channelId === channelId);
  if (!scoped.length) {
    warnings.push(`SCAN ${label}: channel ${channelId} has no samples; skipped`);
    return { noise: insufficientNoise(null), decay: fitExponential(scoped) };
  }
  const build = buildSeries(scoped, (sample) => sample.amplitude, request.analysis?.scan?.find((item) => item.label === label)?.startNs, request.analysis?.scan?.find((item) => item.label === label)?.endNs);
  let noise: NoiseSummary;
  if (!build.series || build.reason) {
    warnings.push(`SCAN ${label}: ${build.reason === 'irregular-timebase' ? 'non-uniform time base; spectrum suppressed' : 'not enough samples for a spectrum'}`);
    noise = insufficientNoise(null);
  } else {
    const windows = makeWindows(build.series, request);
    if (!windows) {
      warnings.push(`SCAN ${label}: series too short for an analysis window; spectrum suppressed`);
      noise = insufficientNoise(null);
    } else {
      noise = summarizeNoise(periodogram(windows, request.analysis?.maxFrequencyHz ?? Number.POSITIVE_INFINITY), null);
    }
  }
  const scanWindow = request.analysis?.scan?.find((item) => item.label === label);
  return { noise, decay: fitExponential(scoped, scanWindow?.startNs, scanWindow?.endNs) };
}

export function analyzeExperiment(request: AnalysisRequest): AnalysisResult {
  invariant(request.experimentId.length > 0, 'INVALID_EXPERIMENT_ID', 'Experiment id is required');
  validateWindowSize(request);
  const syncToleranceNs = request.analysis?.syncToleranceNs ?? 2_000;

  const sync = synchronizeSamples(request.samples, syncToleranceNs);
  const calibrated = applyCalibration(sync.samples, request.calibrations);
  const warnings: string[] = [];
  if (sync.droppedSamples > 0) warnings.push(`DUPLICATE_CAPTURE: dropped ${sync.droppedSamples} repeated (capture, channel) sample(s) with identical payload`);

  const primary = chooseChannel(calibrated, request.primaryChannelId, 'primary');
  invariant(primary.length >= 2, 'PRIMARY_CHANNEL_TOO_SHORT', 'Primary channel needs at least two calibrated samples', { channelId: primary[0]?.channelId });

  // --- reference channel: resolve first, pair one-to-one, then decide on cross-spectrum ---
  let cross: CrossSpectrumBin[] = [];
  let channelPairs: ChannelPair[] = [];
  if (request.referenceChannelId) {
    if (request.referenceChannelId === primary[0].channelId) {
      warnings.push('REFERENCE_IS_PRIMARY: reference channel equals primary channel; running single-channel analysis without cross-spectrum');
    } else {
      const referenceSamples = calibrated.filter((sample) => sample.channelId === request.referenceChannelId);
      if (!referenceSamples.length) {
        warnings.push(`REFERENCE_MISSING: reference channel ${request.referenceChannelId} has no samples; degraded to single-channel analysis without cross-spectrum`);
      } else {
        const pairing = pairChannels(primary, referenceSamples, syncToleranceNs);
        if (!pairing.complete) {
          warnings.push(`REFERENCE_UNPAIRED: only ${pairing.pairs.length} of ${primary.length} primary sample(s) paired one-to-one within ${syncToleranceNs} ns (${pairing.unpairedPrimary} primary, ${pairing.unpairedReference} reference unpaired); cross-spectrum suppressed to avoid false coherence`);
        } else {
          channelPairs = pairing.pairs;
          const periodNs = pairing.pairs[0].primary.sampleRateHz ? 1e9 / pairing.pairs[0].primary.sampleRateHz : Infinity;
          if (pairing.maxSkewNs > Math.min(syncToleranceNs, periodNs * 0.1)) {
            warnings.push(`REFERENCE_JITTER: paired channels skewed by up to ${pairing.maxSkewNs.toFixed(0)} ns; coherence interpreted against that alignment tolerance`);
          }
        }
      }
    }
  }

  // --- primary spectrum on the observed time grid (never a mean of rates) ---
  const primaryBuild = buildSeries(primary, (sample) => sample.amplitude);
  const primarySpectrum = spectrumFromBuild(primaryBuild, request, 'PRIMARY_CHANNEL', warnings);

  // --- cross-spectrum only from complete one-to-one pairs on a shared grid ---
  if (channelPairs.length) {
    const leftBuild = buildPairedSeries(channelPairs, 'primary', (sample) => sample.amplitude);
    const rightBuild = buildPairedSeries(channelPairs, 'reference', (sample) => sample.amplitude);
    if (!leftBuild.series || leftBuild.reason || !rightBuild.series || rightBuild.reason) {
      warnings.push('CROSS_SPECTRUM: paired samples do not form a uniform time grid (jitter or gaps); cross-spectrum suppressed');
    } else {
      if (rightBuild.timebase?.declaredRateMismatch) warnings.push('REFERENCE_CHANNEL: declared reference sample rate disagrees with paired timestamps; observed rate used');
      if (leftBuild.timebase?.status === 'jittered' || rightBuild.timebase?.status === 'jittered') warnings.push('CROSS_SPECTRUM: paired time grids carry clock jitter; coherence estimated on the observed common rate');
      if (Math.abs(leftBuild.series.sampleRateHz - rightBuild.series.sampleRateHz) / leftBuild.series.sampleRateHz > 0.01) {
        warnings.push(`CROSS_SPECTRUM: primary ${leftBuild.series.sampleRateHz.toFixed(3)} Hz and reference ${rightBuild.series.sampleRateHz.toFixed(3)} Hz grids differ; cross-spectrum suppressed to keep one frequency axis`);
      } else {
        // Rebuild both sides on a single common rate so one frequency axis is
        // exact even when tiny jitter makes the two observed rates differ in ppm.
        const commonRateHz = (leftBuild.series.sampleRateHz + rightBuild.series.sampleRateHz) / 2;
        const commonLeft = buildPairedSeries(channelPairs, 'primary', (sample) => sample.amplitude, commonRateHz);
        const commonRight = buildPairedSeries(channelPairs, 'reference', (sample) => sample.amplitude, commonRateHz);
        const requestedSize = request.analysis?.windowSize ?? Math.min(128, commonLeft.series!.values.length);
        const size = requestedSize > Math.min(commonLeft.series!.values.length, commonRight.series!.values.length)
          ? -1
          : requestedSize;
        if (size < 8) {
          warnings.push(size === -1 ? `CROSS_SPECTRUM: ${request.analysis?.windowSize}-sample window does not fit the paired series; cross-spectrum suppressed` : 'CROSS_SPECTRUM: fewer than 8 paired samples; cross-spectrum suppressed');
        } else {
          const leftWindows = splitWindows(commonLeft.series!, size, request.analysis?.overlap ?? 0.5);
          const rightWindows = splitWindows(commonRight.series!, size, request.analysis?.overlap ?? 0.5);
          if (leftWindows.length !== rightWindows.length || !leftWindows.length) {
            warnings.push('CROSS_SPECTRUM: paired windowing produced unequal segments; cross-spectrum suppressed');
          } else {
            cross = crossSpectrum(leftWindows, rightWindows, request.analysis?.maxFrequencyHz ?? Number.POSITIVE_INFINITY);
            if (leftWindows.length < 2) warnings.push('CROSS_COHERENCE: only one Welch segment available; per-bin coherence is unidentifiable (reported null), cross-power retained');
          }
        }
      }
    }
  }

  const coherent = cross.length ? meanCoherence(cross) : null;
  const noise = primarySpectrum.length ? summarizeNoise(primarySpectrum, coherent) : insufficientNoise(coherent);

  const decay = request.kind === 'noise-only' ? null : fitExponential(primary, request.analysis?.fitStartNs, request.analysis?.fitEndNs);
  const amplitudes = primary.map((sample) => sample.amplitude);
  const phases = primary.map((sample) => sample.phaseRad);
  const primaryChannelId = primary[0].channelId;
  const scanResults = (request.analysis?.scan ?? []).map((scan) => {
    const channelId = scan.channelId ?? primaryChannelId;
    return { label: scan.label, ...analyzeScan(request, calibrated, scan.label, channelId, warnings) };
  });

  const calibrationVersions = [...new Set(calibrated.map((sample) => sample.calibrationProfileId))].sort();
  const rawPhaseDrift = phases.at(-1)! - phases[0];
  const phaseDriftRad = Math.atan2(Math.sin(rawPhaseDrift), Math.cos(rawPhaseDrift));
  const uniqueWarnings = [...new Set(warnings)];
  return {
    analysisId: randomUUID(), experimentId: request.experimentId, kind: request.kind, inputDigest: digest(request), calibrationVersions,
    metrics: { sampleCount: calibrated.length, channelCount: new Set(calibrated.map((sample) => sample.channelId)).size, durationNs: sync.samples.at(-1)!.timestampNs - sync.samples[0].timestampNs, triggerCount: sync.triggerCount, droppedSamples: sync.droppedSamples, medianSkewNs: sync.medianSkewNs, amplitudeMean: mean(amplitudes), amplitudeStdDev: stddev(amplitudes, mean(amplitudes)), phaseDriftRad, decay },
    primarySpectrum, crossSpectrum: cross, noise, scanResults, warnings: uniqueWarnings,
  };
}
