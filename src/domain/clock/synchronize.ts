import { DomainError, invariant } from '../errors.ts';
import type { RawSample, SynchronizedSample } from '../types.ts';

export type SyncBatch = { samples: RawSample[]; droppedSamples: number; medianSkewNs: number; triggerCount: number };

export type ChannelPair = { primary: SynchronizedSample; reference: SynchronizedSample; skewNs: number };

export type PairingResult = {
  pairs: ChannelPair[];
  pairedPrimaryIds: Set<string>;
  unpairedPrimary: number;
  unpairedReference: number;
  complete: boolean;
  maxSkewNs: number;
};

function validateSample(sample: RawSample, index: number): void {
  invariant(sample.captureId && sample.experimentId && sample.channelId && sample.triggerId, 'INVALID_SAMPLE_ID', 'Sample identity fields are required', { index });
  invariant(Number.isFinite(sample.timestampNs) && sample.timestampNs >= 0, 'INVALID_SAMPLE_TIME', 'Sample timestamp must be finite and non-negative', { index });
  invariant(Number.isFinite(sample.receivedAtNs) && sample.receivedAtNs >= 0, 'INVALID_RECEIVE_TIME', 'Receive timestamp must be finite and non-negative', { index });
  invariant(Number.isInteger(sample.sequence) && sample.sequence >= 0, 'INVALID_SEQUENCE', 'Sample sequence must be a non-negative integer', { index });
  invariant(Number.isFinite(sample.sampleRateHz) && sample.sampleRateHz > 0, 'INVALID_SAMPLE_RATE', 'Sample rate must be positive', { index });
  invariant(Number.isFinite(sample.i) && Number.isFinite(sample.q), 'INVALID_IQ', 'I/Q values must be finite', { index });
  invariant(sample.quality !== 'invalid', 'INVALID_SAMPLE_QUALITY', 'Invalid samples must be removed before synchronization', { index });
}

export function synchronizeSamples(input: RawSample[], toleranceNs = 2_000): SyncBatch {
  invariant(Array.isArray(input) && input.length > 0, 'EMPTY_SAMPLES', 'At least one sample is required');
  input.forEach(validateSample);
  // A capture id identifies a hardware capture; one capture normally carries one
  // sample *per channel*. De-duplication therefore keys on (captureId, channelId),
  // never on captureId alone, otherwise multi-channel captures falsely conflict.
  const byCapture = new Map<string, Map<string, RawSample>>();
  let droppedSamples = 0;
  const ordered = [...input].sort((a, b) => a.timestampNs - b.timestampNs || a.sequence - b.sequence || a.channelId.localeCompare(b.channelId));
  for (const sample of ordered) {
    const perCapture = byCapture.get(sample.captureId) ?? new Map<string, RawSample>();
    const previous = perCapture.get(sample.channelId);
    if (!previous) {
      perCapture.set(sample.channelId, sample);
      byCapture.set(sample.captureId, perCapture);
      continue;
    }
    const samePayload = previous.timestampNs === sample.timestampNs
      && previous.triggerId === sample.triggerId
      && previous.sequence === sample.sequence
      && previous.i === sample.i
      && previous.q === sample.q
      && previous.sampleRateHz === sample.sampleRateHz;
    if (!samePayload) throw new DomainError('CAPTURE_CONFLICT', 'Capture id/channel pair contains conflicting payloads', 409, { captureId: sample.captureId, channelId: sample.channelId });
    droppedSamples += 1;
  }
  const samples = [...byCapture.values()].flatMap((perCapture) => [...perCapture.values()])
    .sort((a, b) => a.timestampNs - b.timestampNs || a.sequence - b.sequence || a.channelId.localeCompare(b.channelId));
  const triggerTimes = new Map<string, number>();
  for (const sample of samples) triggerTimes.set(sample.triggerId, Math.min(triggerTimes.get(sample.triggerId) ?? sample.timestampNs, sample.timestampNs));
  const skews = samples.map((sample) => Math.abs(sample.timestampNs - (triggerTimes.get(sample.triggerId) ?? sample.timestampNs))).filter((value) => value <= toleranceNs).sort((a, b) => a - b);
  const medianSkewNs = skews.length ? skews[Math.floor(skews.length / 2)] : 0;
  return { samples, droppedSamples, medianSkewNs, triggerCount: triggerTimes.size };
}

function sampleId(sample: SynchronizedSample): string {
  return `${sample.captureId}:${sample.channelId}:${sample.sequence}`;
}

/**
 * One-to-one nearest-first matching between primary and reference samples.
 *
 * Each reference sample can be claimed at most once (global greedy assignment by
 * ascending timestamp distance), which prevents a short/jittered reference
 * channel from being stretched across several primary samples. Matching is based
 * on actual timestamps within tolerance, never on array positions.
 */
export function pairChannels(primary: SynchronizedSample[], reference: SynchronizedSample[], toleranceNs = 2_000): PairingResult {
  const candidates: Array<{ primary: SynchronizedSample; reference: SynchronizedSample; distance: number }> = [];
  for (const p of primary) {
    for (const r of reference) {
      const distance = Math.abs(p.timestampNs - r.timestampNs);
      if (distance <= toleranceNs) candidates.push({ primary: p, reference: r, distance });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance
    || a.primary.timestampNs - b.primary.timestampNs
    || a.reference.timestampNs - b.reference.timestampNs
    || sampleId(a.primary).localeCompare(sampleId(b.primary))
    || sampleId(a.reference).localeCompare(sampleId(b.reference)));

  const claimedPrimary = new Set<string>();
  const claimedReference = new Set<string>();
  const pairs: ChannelPair[] = [];
  for (const candidate of candidates) {
    const pId = sampleId(candidate.primary);
    const rId = sampleId(candidate.reference);
    if (claimedPrimary.has(pId) || claimedReference.has(rId)) continue;
    claimedPrimary.add(pId);
    claimedReference.add(rId);
    pairs.push({ primary: candidate.primary, reference: candidate.reference, skewNs: candidate.distance });
  }
  pairs.sort((a, b) => a.primary.timestampNs - b.primary.timestampNs || a.primary.syncIndex - b.primary.syncIndex);
  return {
    pairs,
    pairedPrimaryIds: claimedPrimary,
    unpairedPrimary: primary.length - pairs.length,
    unpairedReference: reference.length - pairs.length,
    complete: pairs.length === primary.length && pairs.length > 0,
    maxSkewNs: pairs.reduce((max, pair) => Math.max(max, pair.skewNs), 0),
  };
}
