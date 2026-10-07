import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeExperiment } from '../src/application/analysis-service.ts';
import { synchronizeSamples } from '../src/domain/clock/synchronize.ts';
import { pairChannels } from '../src/domain/clock/pair.ts';
import { buildSeries, splitWindows } from '../src/domain/signal/window.ts';
import { crossSpectrum } from '../src/domain/signal/spectrum.ts';
import { summarizeNoise } from '../src/domain/noise/classify.ts';
import { applyCalibration } from '../src/domain/calibration/apply.ts';
import type { AnalysisRequest, CalibrationProfile, RawSample } from '../src/domain/types.ts';

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const profiles: CalibrationProfile[] = ['ch-a', 'ch-b'].map((channelId) => ({
  profileId: `cal-${channelId}`,
  channelId,
  validFromNs: 0,
  adcScale: 1,
  iOffset: 0,
  qOffset: 0,
  gainCorrection: 1,
  phaseCorrectionRad: 0,
  temperatureCoefficientPerK: 0,
  referenceTemperatureK: 0.02,
  systematicUncertainty: 0.001,
  sampleUncertainty: 0.001,
}));

type SampleOptions = {
  channelId?: string;
  index: number;
  timestampNs?: number;
  rate?: number;
  i?: number;
  q?: number;
  triggerId?: string;
  captureId?: string;
  quality?: RawSample['quality'];
};

function makeSample(options: SampleOptions): RawSample {
  const { index, channelId = 'ch-a' } = options;
  const rate = options.rate ?? 1_000;
  return {
    captureId: options.captureId ?? `${channelId}-${index}`,
    experimentId: 'exp-1',
    channelId,
    role: 'readout-i',
    triggerId: options.triggerId ?? `t-${Math.floor(index / 4)}`,
    timestampNs: options.timestampNs ?? index * (1e9 / rate),
    receivedAtNs: (options.timestampNs ?? index * (1e9 / rate)) + 100,
    sequence: index,
    sampleRateHz: rate,
    i: options.i ?? 0,
    q: options.q ?? 0,
    quality: options.quality,
  };
}

function correlatedInputs(count: number, jitterNs = 0, refMissing = 0): AnalysisRequest {
  const samples: RawSample[] = [];
  for (let index = 0; index < count; index += 1) {
    // Modulate magnitude well above zero so the analyzed amplitude stays at the
    // tone frequency (|i| of a zero-crossing sine would frequency-double).
    const tone = 2 + Math.cos((2 * Math.PI * index) / 8);
    const tsA = index * 1_000_000;
    samples.push(makeSample({ index, channelId: 'ch-a', i: tone, timestampNs: tsA }));
    if (index >= refMissing) {
      samples.push(makeSample({ index, channelId: 'ch-b', i: tone, timestampNs: tsA + (jitterNs ? (index % 2 === 0 ? jitterNs : -jitterNs) : 0) }));
    }
  }
  return {
    experimentId: 'exp-1',
    kind: 'noise-only',
    samples,
    calibrations: profiles,
    primaryChannelId: 'ch-a',
    referenceChannelId: 'ch-b',
    analysis: { windowSize: 32, syncToleranceNs: 20_000 },
  };
}

test('equal-rate correlated channels produce a complete cross-spectrum with high multi-window coherence', () => {
  const result = analyzeExperiment(correlatedInputs(64));
  assert.ok(result.crossSpectrum.length > 0);
  assert.ok(result.warnings.every((message) => !message.startsWith('Cross-spectrum')));
  const estimated = result.crossSpectrum.filter((bin) => bin.coherence !== null);
  assert.ok(estimated.length > 0);
  const peak = estimated.reduce((best, bin) => ((bin.coherence ?? 0) > (best.coherence ?? 0) ? bin : best));
  assert.ok((peak.coherence ?? 0) > 0.8, `expected high coherence at the shared tone, got ${peak.coherence}`);
  assert.equal(result.noise.crossChannelCoherence, result.noise.crossChannelCoherence); // number, not null
});

test('single window never reports fabricated unit coherence', () => {
  const result = analyzeExperiment(correlatedInputs(32));
  assert.ok(result.crossSpectrum.length > 0);
  assert.ok(result.crossSpectrum.every((bin) => bin.coherence === null));
  assert.ok(result.warnings.some((message) => /coherence is not estimable/.test(message)));
  assert.equal(result.noise.crossChannelCoherence, null);
});

test('reference channel missing samples degrades explicitly and never fabricates a cross-spectrum', () => {
  const result = analyzeExperiment(correlatedInputs(64, 0, 5));
  assert.deepEqual(result.crossSpectrum, []);
  assert.equal(result.noise.crossChannelCoherence, null);
  assert.ok(result.warnings.some((message) => /Cross-spectrum degraded/.test(message)));
  assert.ok(result.warnings.some((message) => /59 of 64/.test(message)));
  assert.ok(result.primarySpectrum.length > 0, 'primary single-channel spectrum must still be available');
});

test('pairing is strictly one-to-one: a short reference cannot be reused against many primaries', () => {
  const calibrated = applyCalibration(
    Array.from({ length: 16 }, (_, index) => makeSample({ index, channelId: 'ch-a', timestampNs: index * 1_000_000 }))
      .concat([makeSample({ index: 0, channelId: 'ch-b', timestampNs: 10_000 })]),
    profiles,
  );
  const primary = calibrated.filter((sample) => sample.channelId === 'ch-a');
  const reference = calibrated.filter((sample) => sample.channelId === 'ch-b');
  const pairing = pairChannels(primary, reference, { toleranceNs: 20_000 });
  assert.equal(pairing.pairs.length, 1);
  assert.equal(pairing.unmatchedPrimary, 15);
  assert.equal(pairing.unmatchedReference, 0);
  assert.equal(pairing.complete, false);
});

test('pairing never crosses trigger boundaries', () => {
  const primary = Array.from({ length: 8 }, (_, index) => makeSample({ index, channelId: 'ch-a', timestampNs: index * 1_000_000 }));
  // Reference samples are far away in time but share no timestamps; tempt
  // nearest-match across triggers by putting them near other primary samples.
  const reference = [
    makeSample({ index: 20, channelId: 'ch-b', timestampNs: 1_200_000, triggerId: 'other-trigger' }),
  ];
  const calibrated = applyCalibration(primary.concat(reference), profiles);
  const pairing = pairChannels(
    calibrated.filter((sample) => sample.channelId === 'ch-a'),
    calibrated.filter((sample) => sample.channelId === 'ch-b'),
    { toleranceNs: 20_000 },
  );
  assert.equal(pairing.pairs.length, 0);
  assert.equal(pairing.complete, false);
});

test('independent white noise yields low coherence everywhere', () => {
  const random = mulberry32(7);
  const samples: RawSample[] = [];
  for (let index = 0; index < 256; index += 1) {
    const ts = index * 1_000_000;
    samples.push(makeSample({ index, channelId: 'ch-a', i: random() - 0.5, timestampNs: ts }));
    samples.push(makeSample({ index, channelId: 'ch-b', i: random() - 0.5, timestampNs: ts }));
  }
  const result = analyzeExperiment({
    experimentId: 'exp-1', kind: 'noise-only', samples, calibrations: profiles,
    primaryChannelId: 'ch-a', referenceChannelId: 'ch-b', analysis: { windowSize: 32 },
  });
  const estimated = result.crossSpectrum.filter((bin) => bin.coherence !== null);
  const average = estimated.reduce((sum, bin) => sum + (bin.coherence ?? 0), 0) / estimated.length;
  assert.ok(average < 0.2, `independent channels should not look coherent, got ${average}`);
  assert.ok(Math.max(...estimated.map((bin) => bin.coherence ?? 0)) < 0.5);
});

test('a shared tone is coherent at its bin while off-tone bins stay low', () => {
  const noiseA = mulberry32(42);
  const noiseB = mulberry32(1337);
  const samples: RawSample[] = [];
  for (let index = 0; index < 512; index += 1) {
    const tone = 2 + Math.cos((2 * Math.PI * index) / 8);
    const ts = index * 1_000_000;
    samples.push(makeSample({ index, channelId: 'ch-a', i: tone + (noiseA() - 0.5), timestampNs: ts }));
    samples.push(makeSample({ index, channelId: 'ch-b', i: tone + (noiseB() - 0.5), timestampNs: ts }));
  }
  const result = analyzeExperiment({
    experimentId: 'exp-1', kind: 'noise-only', samples, calibrations: profiles,
    primaryChannelId: 'ch-a', referenceChannelId: 'ch-b', analysis: { windowSize: 64 },
  });
  const toneBin = result.crossSpectrum.find((bin) => bin.frequencyHz === 125);
  assert.ok(toneBin && (toneBin.coherence ?? 0) > 0.8, `tone bin coherence ${toneBin?.coherence}`);
  const offTone = result.crossSpectrum.filter((bin) => bin.coherence !== null && Math.abs(bin.frequencyHz - 125) > 60);
  const averageOffTone = offTone.reduce((sum, bin) => sum + (bin.coherence ?? 0), 0) / offTone.length;
  assert.ok(averageOffTone < 0.3, `off-tone coherence should be low, got ${averageOffTone}`);
});

test('mixed sample rates inside a channel are rejected instead of averaged', () => {
  const samples = Array.from({ length: 16 }, (_, index) => makeSample({ index, rate: index < 8 ? 1_000 : 2_000 }));
  const calibrated = applyCalibration(samples, [profiles[0]]);
  assert.throws(() => buildSeries(calibrated, (sample) => sample.amplitude), /mixed sample rates/);
});

test('sample rate change between primary and reference degrades the cross-spectrum but keeps the primary spectrum', () => {
  const samples: RawSample[] = [];
  for (let index = 0; index < 64; index += 1) {
    const tone = Math.cos((2 * Math.PI * index) / 8);
    samples.push(makeSample({ index, channelId: 'ch-a', i: tone, timestampNs: index * 1_000_000, rate: 1_000 }));
    // Same observation times so pairing completes, but the reference declares a
    // different sample rate: the frequency axes are incompatible.
    samples.push(makeSample({ index, channelId: 'ch-b', i: tone, timestampNs: index * 1_000_000, rate: 2_000 }));
  }
  const result = analyzeExperiment({
    experimentId: 'exp-1', kind: 'noise-only', samples, calibrations: profiles,
    primaryChannelId: 'ch-a', referenceChannelId: 'ch-b', analysis: { windowSize: 32, syncToleranceNs: 20_000 },
  });
  assert.deepEqual(result.crossSpectrum, []);
  assert.ok(result.warnings.some((message) => /does not match primary/.test(message)));
  // The primary frequency axis must still be self-consistent.
  assert.ok(result.primarySpectrum.every((bin) => bin.frequencyHz <= 500));
});

test('timestamp gaps are rejected rather than compressed into a window', () => {
  const samples = Array.from({ length: 16 }, (_, index) => makeSample({ index, timestampNs: (index < 8 ? index : index + 8) * 1_000_000 }));
  const calibrated = applyCalibration(samples, [profiles[0]]);
  assert.throws(() => buildSeries(calibrated, (sample) => sample.amplitude), /gap/);
});

test('small clock jitter within tolerance stays on the nominal grid and warns', () => {
  const samples = Array.from({ length: 16 }, (_, index) => makeSample({ index, timestampNs: index * 1_000_000 + (index % 2 === 0 ? 300 : -300) }));
  const calibrated = applyCalibration(samples, [profiles[0]]);
  const { series, warnings } = buildSeries(calibrated, (sample) => sample.amplitude, { jitterToleranceNs: 2_000 });
  assert.equal(series.sampleRateHz, 1_000);
  assert.ok(series.jitterNs >= 300);
  assert.ok(warnings.some((message) => /Clock jitter/.test(message)));
});

test('jitter beyond tolerance is refused', () => {
  const samples = Array.from({ length: 16 }, (_, index) => makeSample({ index, timestampNs: index * 1_000_000 + (index % 2 === 0 ? 700 : -700) }));
  const calibrated = applyCalibration(samples, [profiles[0]]);
  assert.throws(() => buildSeries(calibrated, (sample) => sample.amplitude, { jitterToleranceNs: 500 }), /jitter/i);
});

test('same capture id on different channels is a valid multi-channel capture, duplicate copies are folded', () => {
  const first = makeSample({ index: 0, channelId: 'ch-a', captureId: 'cap-1' });
  const otherChannel = makeSample({ index: 0, channelId: 'ch-b', captureId: 'cap-1' });
  const sync = synchronizeSamples([first, otherChannel, { ...first }]);
  assert.equal(sync.samples.length, 2);
  assert.equal(sync.droppedSamples, 1);
  assert.ok(sync.warnings.some((message) => /duplicate capture/.test(message)));
});

test('single-channel short runs degrade to insufficient-data and still return', () => {
  const result = analyzeExperiment({
    experimentId: 'exp-1',
    kind: 'noise-only',
    samples: Array.from({ length: 4 }, (_, index) => makeSample({ index })),
    calibrations: [profiles[0]],
    primaryChannelId: 'ch-a',
  });
  assert.deepEqual(result.crossSpectrum, []);
  assert.equal(result.noise.class, 'insufficient-data');
  assert.ok(result.warnings.some((message) => /at least 8/i.test(message) || /needs at least/.test(message)));
  assert.equal(result.metrics.sampleCount, 4);
});

test('reference channel equal to primary runs single-channel analysis with a warning', () => {
  const result = analyzeExperiment({
    experimentId: 'exp-1',
    kind: 'noise-only',
    samples: Array.from({ length: 64 }, (_, index) => makeSample({ index, i: Math.cos((2 * Math.PI * index) / 8) })),
    calibrations: [profiles[0]],
    primaryChannelId: 'ch-a',
    referenceChannelId: 'ch-a',
    analysis: { windowSize: 32 },
  });
  assert.deepEqual(result.crossSpectrum, []);
  assert.ok(result.warnings.some((message) => /same as the primary/.test(message)));
  assert.equal(result.noise.crossChannelCoherence, null);
});

test('unknown reference channel is a hard error, not a silent single-channel run', () => {
  assert.throws(() => analyzeExperiment({
    experimentId: 'exp-1',
    kind: 'noise-only',
    samples: Array.from({ length: 64 }, (_, index) => makeSample({ index })),
    calibrations: [profiles[0]],
    primaryChannelId: 'ch-a',
    referenceChannelId: 'ch-missing',
    analysis: { windowSize: 32 },
  }), (error) => error instanceof Error && error.name === 'DomainError' && /no calibrated samples/.test(error.message));
});

test('window boundaries follow measured timestamps, not the nominal rate', () => {
  const samples = Array.from({ length: 16 }, (_, index) => makeSample({ index, timestampNs: 50_000 + index * 1_000_000 + (index % 2 === 0 ? 100 : -100) }));
  const calibrated = applyCalibration(samples, [profiles[0]]);
  const { series } = buildSeries(calibrated, (sample) => sample.amplitude, { jitterToleranceNs: 2_000 });
  const windows = splitWindows(series, 8, 0.5);
  assert.equal(windows[0].startNs, series.timestampsNs[0]);
  assert.equal(windows[0].endNs, series.timestampsNs[7]);
  assert.equal(windows.at(-1)!.endNs, series.timestampsNs.at(-1));
});

test('noise summary without a spectrum is insufficient-data instead of throwing', () => {
  const summary = summarizeNoise([], null);
  assert.equal(summary.class, 'insufficient-data');
  assert.equal(summary.confidence, 0);
});

test('cross-spectrum rejects mismatched rates and lengths outright at the domain layer', () => {
  const window = (rate: number, size: number) => {
    const values = Array.from({ length: size }, (_, index) => Math.cos((2 * Math.PI * index) / 8));
    return {
      startNs: 0,
      endNs: size * (1e9 / rate),
      sampleRateHz: rate,
      timestampsNs: values.map((_, index) => (index * 1e9) / rate),
      jitterNs: 0,
      nominalPeriodNs: 1e9 / rate,
      values,
      weights: values.map(() => 1),
    };
  };
  assert.throws(() => crossSpectrum([window(1000, 16)], [window(2000, 16)]), /identical sample rates/);
  assert.throws(() => crossSpectrum([window(1000, 16)], [window(1000, 32)]), /equal-length/);
});

test('out-of-tolerance cross-channel trigger skew is surfaced as a warning, not silently dropped from metrics', () => {
  const sync = synchronizeSamples([
    makeSample({ index: 0, triggerId: 't-0', timestampNs: 0 }),
    makeSample({ index: 1, triggerId: 't-0', timestampNs: 500 }),
    makeSample({ index: 2, channelId: 'ch-b', triggerId: 't-0', timestampNs: 9_000 }),
    makeSample({ index: 3, channelId: 'ch-b', triggerId: 't-0', timestampNs: 9_500 }),
  ], 2_000);
  assert.equal(sync.skewOutOfTolerance, 1);
  assert.equal(sync.medianSkewNs, 9_000);
  assert.ok(sync.warnings.some((message) => /exceed the 2000 ns/.test(message)));
});
