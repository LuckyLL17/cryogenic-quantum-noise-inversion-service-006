export type ExperimentKind = 'rabi' | 'ramsey' | 't1' | 't2-echo' | 'randomized-benchmarking' | 'noise-only';
export type ChannelRole = 'readout-i' | 'readout-q' | 'flux' | 'drive-monitor' | 'temperature';
export type SampleQuality = 'good' | 'suspect' | 'invalid';
export type NoiseClass = 'white' | 'flicker' | 'drift' | 'periodic' | 'correlated' | 'insufficient-data';

export type RawSample = {
  captureId: string;
  experimentId: string;
  channelId: string;
  role: ChannelRole;
  triggerId: string;
  timestampNs: number;
  receivedAtNs: number;
  sequence: number;
  sampleRateHz: number;
  i: number;
  q: number;
  gainDb?: number;
  phaseDeg?: number;
  temperatureK?: number;
  quality?: SampleQuality;
};

export type CalibrationProfile = {
  profileId: string;
  channelId: string;
  role?: ChannelRole;
  validFromNs: number;
  validToNs?: number;
  adcScale: number;
  iOffset: number;
  qOffset: number;
  gainCorrection: number;
  phaseCorrectionRad: number;
  temperatureCoefficientPerK: number;
  referenceTemperatureK: number;
  systematicUncertainty: number;
  sampleUncertainty: number;
};

export type SynchronizedSample = RawSample & {
  calibratedI: number;
  calibratedQ: number;
  amplitude: number;
  phaseRad: number;
  uncertainty: number;
  calibrationProfileId: string;
  syncIndex: number;
};

export type WindowedSeries = {
  startNs: number;
  endNs: number;
  sampleRateHz: number;
  values: number[];
  weights: number[];
};

export type SpectrumBin = { frequencyHz: number; power: number; amplitude: number };
export type CrossSpectrumBin = SpectrumBin & { coherence: number | null; phaseRad: number };

export type DecayFit = {
  model: 'exponential';
  amplitude0: number | null;
  timeConstantNs: number | null;
  offset: number;
  rSquared: number | null;
  usedPoints: number;
  rejectedPoints: number;
  confidence: { lowerNs: number | null; upperNs: number | null };
};

export type NoiseSummary = {
  class: NoiseClass;
  whiteLevel: number;
  lowFrequencySlope: number | null;
  dominantFrequencyHz: number | null;
  integratedPower: number;
  crossChannelCoherence: number | null;
  confidence: number;
};

export type AnalysisRequest = {
  experimentId: string;
  kind: ExperimentKind;
  samples: RawSample[];
  calibrations: CalibrationProfile[];
  primaryChannelId?: string;
  referenceChannelId?: string;
  analysis?: {
    maxFrequencyHz?: number;
    windowSize?: number;
    overlap?: number;
    syncToleranceNs?: number;
    fitStartNs?: number;
    fitEndNs?: number;
    scan?: Array<{ label: string; startNs?: number; endNs?: number; channelId?: string }>;
  };
};

export type ExperimentMetrics = {
  sampleCount: number;
  channelCount: number;
  durationNs: number;
  triggerCount: number;
  droppedSamples: number;
  medianSkewNs: number;
  amplitudeMean: number;
  amplitudeStdDev: number;
  phaseDriftRad: number;
  decay: DecayFit | null;
};

export type AnalysisResult = {
  analysisId: string;
  experimentId: string;
  kind: ExperimentKind;
  inputDigest: string;
  calibrationVersions: string[];
  metrics: ExperimentMetrics;
  primarySpectrum: SpectrumBin[];
  crossSpectrum: CrossSpectrumBin[];
  noise: NoiseSummary;
  scanResults: Array<{ label: string; noise: NoiseSummary; decay: DecayFit | null }>;
  warnings: string[];
};
