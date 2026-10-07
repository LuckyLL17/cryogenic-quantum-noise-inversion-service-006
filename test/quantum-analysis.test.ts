import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCalibration } from '../src/domain/calibration/apply.ts';
import { synchronizeSamples } from '../src/domain/clock/synchronize.ts';
import { analyzeExperiment } from '../src/application/analysis-service.ts';
import { periodogram } from '../src/domain/signal/spectrum.ts';
import type { RawSample, CalibrationProfile } from '../src/domain/types.ts';

const calibration: CalibrationProfile = { profileId: 'cal-1', channelId: 'ch-a', validFromNs: 0, adcScale: 2, iOffset: 0.1, qOffset: -0.2, gainCorrection: 1, phaseCorrectionRad: 0, temperatureCoefficientPerK: 0, referenceTemperatureK: 0.02, systematicUncertainty: 0.01, sampleUncertainty: 0.001 };
function sample(index: number, channelId = 'ch-a'): RawSample { return { captureId: `${channelId}-${index}`, experimentId: 'exp-1', channelId, role: 'readout-i', triggerId: `t-${Math.floor(index / 4)}`, timestampNs: index * 1_000_000, receivedAtNs: index * 1_000_000 + 100, sequence: index, sampleRateHz: 1_000, i: Math.cos(index / 4) + 0.1, q: Math.sin(index / 4) - 0.2, quality: 'good' }; }

test('synchronization removes exact duplicates but rejects conflicting capture ids', () => { const first = sample(1); assert.equal(synchronizeSamples([first, { ...first }]).droppedSamples, 1); assert.throws(() => synchronizeSamples([first, { ...first, i: 4 }]), /conflicting payloads/); });
test('calibration applies offset, gain and phase while preserving profile identity', () => { const calibrated = applyCalibration([sample(0)], [calibration]); assert.equal(calibrated[0].calibrationProfileId, 'cal-1'); assert.ok(calibrated[0].uncertainty > calibration.systematicUncertainty); });
test('periodogram exposes a stable frequency axis', () => { const bins = periodogram([{ startNs: 0, endNs: 8, sampleRateHz: 8, timestampsNs: Array.from({ length: 8 }, (_, i) => i * 125_000_000), jitterNs: 0, nominalPeriodNs: 125_000_000, values: [1, 0, -1, 0, 1, 0, -1, 0], weights: Array(8).fill(1) }], 4); assert.equal(bins[1].frequencyHz, 1); assert.ok(bins[2].power > bins[1].power); });
test('full analysis returns reproducible digest and fitted metrics', () => { const input = { experimentId: 'exp-1', kind: 't1' as const, samples: Array.from({ length: 32 }, (_, index) => sample(index)), calibrations: [calibration], analysis: { windowSize: 16 } }; const first = analyzeExperiment(input); const second = analyzeExperiment(input); assert.equal(first.inputDigest, second.inputDigest); assert.equal(first.metrics.sampleCount, 32); assert.ok(first.primarySpectrum.length > 0); });
