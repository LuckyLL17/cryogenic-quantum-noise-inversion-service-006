import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCalibration } from '../src/domain/calibration/apply.ts';
import { pairChannels, synchronizeSamples } from '../src/domain/clock/synchronize.ts';
import { assessTimebase } from '../src/domain/clock/timebase.ts';
import { analyzeExperiment } from '../src/application/analysis-service.ts';
import { crossSpectrum, periodogram } from '../src/domain/signal/spectrum.ts';
import type { RawSample, CalibrationProfile, AnalysisRequest } from '../src/domain/types.ts';

const calibration: CalibrationProfile = { profileId: 'cal-1', channelId: 'ch-a', validFromNs: 0, adcScale: 2, iOffset: 0.1, qOffset: -0.2, gainCorrection: 1, phaseCorrectionRad: 0, temperatureCoefficientPerK: 0, referenceTemperatureK: 0.02, systematicUncertainty: 0.01, sampleUncertainty: 0.001 };
function sample(index: number, channelId = 'ch-a'): RawSample { return { captureId: `${channelId}-${index}`, experimentId: 'exp-1', channelId, role: 'readout-i', triggerId: `t-${Math.floor(index / 4)}`, timestampNs: index * 1_000_000, receivedAtNs: index * 1_000_000 + 100, sequence: index, sampleRateHz: 1_000, i: Math.cos(index / 4) + 0.1, q: Math.sin(index / 4) - 0.2, quality: 'good' }; }

function profile(channelId: string): CalibrationProfile {
  return { profileId: `cal-${channelId}`, channelId, validFromNs: 0, adcScale: 1, iOffset: 0, qOffset: 0, gainCorrection: 1, phaseCorrectionRad: 0, temperatureCoefficientPerK: 0, referenceTemperatureK: 0.02, systematicUncertainty: 0.001, sampleUncertainty: 0.0001 };
}

function rawSample(channelId: string, index: number, timestampNs: number, i: number, q = 0, sampleRateHz = 1000, captureId?: string): RawSample {
  return { captureId: captureId ?? `${channelId}-cap-${index}`, experimentId: 'exp', channelId, role: 'readout-i', triggerId: `trig-${index}`, timestampNs, receivedAtNs: timestampNs + 50, sequence: index, sampleRateHz, i, q, quality: 'good' };
}

/** Build N equal-rate (fs=1000 Hz, 1 ms spacing) samples carrying a 125 Hz amplitude tone. */
function tonePair(channelId: string, count: number, phaseOffset = 0, startIndex = 0): RawSample[] {
  return Array.from({ length: count }, (_, n) => {
    const index = n + startIndex;
    // Real-valued amplitude oscillation (the spectrum pipeline analyses |IQ|);
    // bias keeps the amplitude strictly positive, which de-meaning removes.
    const amplitude = 2 + Math.cos(2 * Math.PI * 0.125 * n + phaseOffset);
    return rawSample(channelId, index, index * 1_000_000, amplitude, 0);
  });
}

function pairedRequest(a: RawSample[], b: RawSample[], windowSize = 32, extra: AnalysisRequest['analysis'] = {}): AnalysisRequest {
  const channels = [...new Set([...a, ...b].map((s) => s.channelId))];
  return {
    experimentId: 'exp',
    kind: 'noise-only',
    samples: [...a, ...b],
    calibrations: channels.map(profile),
    primaryChannelId: 'a',
    referenceChannelId: 'b',
    analysis: { windowSize, ...extra },
  };
}

// --- original coverage -------------------------------------------------------

test('synchronization removes exact duplicates but rejects conflicting payloads', () => {
  const first = sample(1);
  assert.equal(synchronizeSamples([first, { ...first }]).droppedSamples, 1);
  assert.throws(() => synchronizeSamples([first, { ...first, i: 4 }]), /conflicting payloads/);
});

test('calibration applies offset, gain and phase while preserving profile identity', () => {
  const calibrated = applyCalibration([sample(0)], [calibration]);
  assert.equal(calibrated[0].calibrationProfileId, 'cal-1');
  assert.ok(calibrated[0].uncertainty > calibration.systematicUncertainty);
});

test('periodogram exposes a stable frequency axis', () => {
  const bins = periodogram([{ startNs: 0, endNs: 8, sampleRateHz: 8, values: [1, 0, -1, 0, 1, 0, -1, 0], weights: Array(8).fill(1) }], 4);
  assert.equal(bins[1].frequencyHz, 1);
  assert.ok(bins[2].power > bins[1].power);
});

test('full analysis returns reproducible digest and fitted metrics', () => {
  const input = { experimentId: 'exp-1', kind: 't1' as const, samples: Array.from({ length: 32 }, (_, index) => sample(index)), calibrations: [calibration], analysis: { windowSize: 16 } };
  const first = analyzeExperiment(input);
  const second = analyzeExperiment(input);
  assert.equal(first.inputDigest, second.inputDigest);
  assert.equal(first.metrics.sampleCount, 32);
  assert.ok(first.primarySpectrum.length > 0);
});

// --- time synchronization ----------------------------------------------------

test('multi-channel captures share capture ids without a false CAPTURE_CONFLICT', () => {
  const a = tonePair('a', 32).map((s) => ({ ...s, captureId: `shared-${s.sequence}` }));
  const b = tonePair('b', 32, 0.4).map((s) => ({ ...s, captureId: `shared-${s.sequence}` }));
  const result = analyzeExperiment(pairedRequest(a, b, 16));
  assert.equal(result.metrics.sampleCount, 64);
  assert.ok(result.crossSpectrum.length > 0);
  assert.deepEqual(result.warnings, []);
});

test('duplicate capture of the same channel is dropped exactly once and warned', () => {
  const a = tonePair('a', 24);
  const duplicated = [a[0], { ...a[0] }, ...a.slice(1)];
  const request: AnalysisRequest = { experimentId: 'exp', kind: 't1', samples: duplicated, calibrations: [profile('a')], primaryChannelId: 'a', analysis: { windowSize: 16 } };
  const result = analyzeExperiment(request);
  assert.equal(result.metrics.droppedSamples, 1);
  assert.equal(result.metrics.sampleCount, 24);
  assert.match(result.warnings.join('\n'), /DUPLICATE_CAPTURE/);
});

test('same capture id on the same channel with different payload still conflicts', () => {
  const first = rawSample('a', 0, 0, 1);
  const conflicting = { ...first, i: 7, timestampNs: 500 };
  assert.throws(() => synchronizeSamples([first, conflicting]), /conflicting payloads/);
});

// --- channel pairing ---------------------------------------------------------

test('pairing is one-to-one: a short reference can never be stretched across primaries', () => {
  const a = tonePair('a', 40);
  const b = tonePair('b', 5, 0, 10); // five samples around t=10..14 ms
  const calA = applyCalibration(a, [profile('a')]);
  const calB = applyCalibration(b, [profile('b')]);
  const pairing = pairChannels(calA, calB, 2_000);
  assert.equal(pairing.pairs.length, 5);
  assert.equal(new Set(pairing.pairs.map((p) => p.reference.captureId)).size, 5);
  assert.equal(pairing.complete, false);
  assert.equal(pairing.unpairedPrimary, 35);
});

test('reference missing a few samples degrades explicitly with no cross-spectrum or coherence', () => {
  const a = tonePair('a', 64);
  const b = tonePair('b', 64, 0).filter((s) => s.sequence % 10 !== 0); // 57 samples
  const result = analyzeExperiment(pairedRequest(a, b, 32));
  assert.deepEqual(result.crossSpectrum, []);
  assert.equal(result.noise.crossChannelCoherence, null);
  assert.notEqual(result.noise.class, 'correlated');
  assert.match(result.warnings.join('\n'), /REFERENCE_UNPAIRED: only 57 of 64/);
  // primary analysis must remain usable
  assert.ok(result.primarySpectrum.length > 0);
});

test('missing reference channel degrades to single-channel with a clear warning', () => {
  const a = tonePair('a', 32);
  const request: AnalysisRequest = { experimentId: 'exp', kind: 'noise-only', samples: a, calibrations: [profile('a')], primaryChannelId: 'a', referenceChannelId: 'ghost', analysis: { windowSize: 16 } };
  const result = analyzeExperiment(request);
  assert.deepEqual(result.crossSpectrum, []);
  assert.match(result.warnings.join('\n'), /REFERENCE_MISSING/);
});

test('reference equal to primary is treated as single-channel analysis', () => {
  const a = tonePair('a', 32);
  const request: AnalysisRequest = { experimentId: 'exp', kind: 'noise-only', samples: a, calibrations: [profile('a')], primaryChannelId: 'a', referenceChannelId: 'a', analysis: { windowSize: 16 } };
  const result = analyzeExperiment(request);
  assert.deepEqual(result.crossSpectrum, []);
  assert.match(result.warnings.join('\n'), /REFERENCE_IS_PRIMARY/);
  assert.ok(result.primarySpectrum.length > 0);
});

test('single-channel analysis runs without any reference-related warnings', () => {
  const a = tonePair('a', 32);
  const request: AnalysisRequest = { experimentId: 'exp', kind: 't1', samples: a, calibrations: [profile('a')], primaryChannelId: 'a', analysis: { windowSize: 16 } };
  const result = analyzeExperiment(request);
  assert.deepEqual(result.crossSpectrum, []);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.primarySpectrum.length > 0);
  assert.notEqual(result.noise.class, 'insufficient-data');
});

// --- coherence physics -------------------------------------------------------

test('Welch coherence is high for genuinely correlated channels over many windows', () => {
  const a = tonePair('a', 64);
  const b = tonePair('b', 64, 0.35);
  const result = analyzeExperiment(pairedRequest(a, b, 32));
  const toneBin = result.crossSpectrum.find((bin) => bin.frequencyHz === 125);
  assert.ok(toneBin, 'expected a 125 Hz bin in the cross-spectrum');
  assert.ok((toneBin!.coherence ?? 0) > 0.95);
});

test('single Welch segment yields null coherence bins instead of an artificial 1.0', () => {
  const a = tonePair('a', 8);
  const b = tonePair('b', 8, 0.4);
  const result = analyzeExperiment(pairedRequest(a, b, 8, { overlap: 0 }));
  assert.ok(result.crossSpectrum.length > 0);
  assert.ok(result.crossSpectrum.every((bin) => bin.coherence === null));
  assert.match(result.warnings.join('\n'), /CROSS_COHERENCE/);
  assert.equal(result.noise.crossChannelCoherence, null);
  // cross-power is still reported for inspection
  assert.ok(result.crossSpectrum.some((bin) => bin.power >= 0));
});

test('cross-spectrum rejects mismatched grid length/rate windows', () => {
  const windows = (rate: number, values: number[]) => [{ startNs: 0, endNs: 1, sampleRateHz: rate, values, weights: values.map(() => 1) }];
  assert.throws(
    () => crossSpectrum(windows(8, [1, 0, -1, 0, 1, 0, -1, 0]), windows(16, [1, 0, 0, 0, -1, 0, 0, 0]), 8),
    (error: unknown) => (error as { code?: string }).code === 'CROSS_GRID_MISMATCH',
  );
});

// --- time base and sample-rate changes --------------------------------------

test('equal-rate uniform data is assessed as uniform with no warnings', () => {
  const calibrated = applyCalibration(tonePair('a', 32), [profile('a')]);
  const assessment = assessTimebase(calibrated);
  assert.equal(assessment.status, 'uniform');
  assert.ok(Math.abs(assessment.observedRateHz - 1000) < 1e-6);
});

test('small clock jitter is tolerated, flagged, and uses the observed rate', () => {
  const jittered = Array.from({ length: 64 }, (_, n) => rawSample('a', n, n * 1_000_000 + (n % 2 ? -20_000 : 20_000), Math.cos(2 * Math.PI * 0.1 * n)));
  const calibrated = applyCalibration(jittered, [profile('a')]);
  assert.equal(assessTimebase(calibrated).status, 'jittered');
  const request: AnalysisRequest = { experimentId: 'exp', kind: 'noise-only', samples: jittered, calibrations: [profile('a')], primaryChannelId: 'a', analysis: { windowSize: 16 } };
  const result = analyzeExperiment(request);
  assert.ok(result.primarySpectrum.length > 0);
  assert.match(result.warnings.join('\n'), /clock jitter/);
});

test('sample-rate change mid-capture suppresses the spectrum instead of averaging rates', () => {
  const changed: RawSample[] = [];
  for (let n = 0; n < 64; n += 1) {
    const rate = n < 32 ? 1000 : 2000;
    const ts = n < 32 ? n * 1_000_000 : 32_000_000 + (n - 32) * 500_000;
    changed.push(rawSample('a', n, ts, Math.cos(2 * Math.PI * 0.1 * n), 0, rate));
  }
  assert.equal(assessTimebase(applyCalibration(changed, [profile('a')])).status, 'irregular');
  const request: AnalysisRequest = { experimentId: 'exp', kind: 'noise-only', samples: changed, calibrations: [profile('a')], primaryChannelId: 'a', analysis: { windowSize: 16 } };
  const result = analyzeExperiment(request);
  assert.deepEqual(result.primarySpectrum, []);
  assert.deepEqual(result.crossSpectrum, []);
  assert.equal(result.noise.class, 'insufficient-data');
  assert.match(result.warnings.join('\n'), /non-uniform time base/);
});

test('dropped-sample gap is irregular even when declared rate stays constant', () => {
  const gapped = Array.from({ length: 40 }, (_, n) => n).filter((n) => n !== 20).map((n) => rawSample('a', n, n * 1_000_000, 1));
  assert.equal(assessTimebase(applyCalibration(gapped, [profile('a')])).status, 'irregular');
});

test('declared sample rate disagreeing with timestamps is warned and timestamps win for the frequency axis', () => {
  const samples = Array.from({ length: 32 }, (_, n) => rawSample('a', n, n * 2_000_000, Math.cos(2 * Math.PI * 0.1 * n), 0, 1000));
  const request: AnalysisRequest = { experimentId: 'exp', kind: 'noise-only', samples, calibrations: [profile('a')], primaryChannelId: 'a', analysis: { windowSize: 16 } };
  const result = analyzeExperiment(request);
  assert.ok(result.primarySpectrum.length > 0);
  // timestamps say 500 Hz -> Nyquist 250 Hz, never the declared 1000 Hz / 500 Hz bin edge
  assert.ok(result.primarySpectrum.at(-1)!.frequencyHz <= 250 + 1e-9);
  assert.match(result.warnings.join('\n'), /declared sample rate 1000/);
});

test('duplicated timestamps are rejected as an irregular time base', () => {
  const samples = Array.from({ length: 16 }, (_, n) => rawSample('a', n, n < 8 ? n * 1_000_000 : (n - 1) * 1_000_000, 1));
  assert.equal(assessTimebase(applyCalibration(samples, [profile('a')])).status, 'irregular');
});

// --- cross-channel grids -----------------------------------------------------

test('reference channel that halves its rate mid-capture cannot produce a cross-spectrum', () => {
  const a = tonePair('a', 64);
  // reference shares timestamps with primary for the first 32 samples, then
  // switches to a 500 Hz grid; a wide sync tolerance makes pairing appear to
  // succeed, but the paired reference grid is non-uniform.
  const halfRateRef = a.map((s) => rawSample('b', s.sequence, s.timestampNs, s.i, s.q, 1000))
    .map((s, n) => (n >= 32
      ? { ...s, timestampNs: a[31].timestampNs + (n - 31) * 2_000_000, sampleRateHz: 500 }
      : s));
  const result = analyzeExperiment(pairedRequest(a, halfRateRef, 32, { syncToleranceNs: 3_000_000 }));
  assert.deepEqual(result.crossSpectrum, []);
  assert.match(result.warnings.join('\n'), /CROSS_SPECTRUM|non-uniform|REFERENCE_UNPAIRED/);
});

test('jittered paired channels still produce an explainable cross-spectrum on the common rate', () => {
  const timestamps = Array.from({ length: 64 }, (_, n) => n * 1_000_000 + (n % 2 ? -20_000 : 20_000));
  const a = timestamps.map((ts, n) => rawSample('a', n, ts, Math.cos(2 * Math.PI * 0.125 * n)));
  const b = timestamps.map((ts, n) => rawSample('b', n, ts, Math.cos(2 * Math.PI * 0.125 * n)));
  const result = analyzeExperiment(pairedRequest(a, b, 32));
  assert.ok(result.crossSpectrum.length > 0);
  assert.ok(result.crossSpectrum.every((bin) => Number.isFinite(bin.frequencyHz)));
  const tone = result.crossSpectrum.find((bin) => Math.abs(bin.frequencyHz - 125) < 2);
  assert.ok(tone && (tone.coherence ?? 0) > 0.8);
});

// --- metrics and degradation stay interpretable ------------------------------

test('irregular primary time base keeps time-domain metrics while only spectral outputs degrade', () => {
  const changed: RawSample[] = [];
  for (let n = 0; n < 64; n += 1) {
    const rate = n < 32 ? 1000 : 2000;
    const ts = n < 32 ? n * 1_000_000 : 32_000_000 + (n - 32) * 500_000;
    changed.push(rawSample('a', n, ts, Math.exp(-n / 40) + 0.05 * Math.cos(n), 0, rate));
  }
  const request: AnalysisRequest = { experimentId: 'exp', kind: 't1', samples: changed, calibrations: [profile('a')], primaryChannelId: 'a', analysis: { windowSize: 16 } };
  const result = analyzeExperiment(request);
  assert.equal(result.metrics.sampleCount, 64);
  assert.ok(result.metrics.durationNs > 0);
  assert.ok(result.metrics.decay !== null);
  assert.deepEqual(result.primarySpectrum, []);
});

test('requested window larger than the series degrades gracefully instead of throwing', () => {
  const request: AnalysisRequest = { experimentId: 'exp', kind: 'noise-only', samples: tonePair('a', 10), calibrations: [profile('a')], primaryChannelId: 'a', analysis: { windowSize: 64 } };
  const result = analyzeExperiment(request);
  assert.deepEqual(result.primarySpectrum, []);
  assert.equal(result.noise.class, 'insufficient-data');
  assert.match(result.warnings.join('\n'), /too short/);
});
