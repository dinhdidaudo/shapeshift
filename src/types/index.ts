// Core type definitions for the fingerprint shuffler extension

/**
 * Main configuration interface for fingerprint protection settings
 */
export interface FingerprintConfig {
  // General
  debug: boolean;
  perOriginFingerprint: boolean;

  // Canvas protection
  enableCanvasNoise: boolean;
  canvasNoiseStrength: number;

  // WebGL protection
  enableWebGLMasking: boolean;
  webglJitter: number;
  maskWebGLVendorStrings: boolean;
  shuffleWebGLExtensions: boolean;

  // Audio protection
  enableAudioNoise: boolean;
  audioNoiseStrength: number;

  // Navigator protection
  enableNavigatorFuzz: boolean;
  navigator: {
    fuzzHardwareConcurrency: boolean;
    fuzzDeviceMemory: boolean;
    shuffleLanguages: boolean;
  };

  // WebRTC protection
  enableWebRTCProtection: boolean;
  webrtc: {
    blockIPLeak: boolean;
    randomizeSDP: boolean;
    forceRelay: boolean;
  };

  // Media devices protection
  enableMediaDeviceProtection: boolean;
  mediaDevices: {
    randomizeDeviceIds: boolean;
    spoofDeviceLabels: boolean;
  };

  // Screen protection
  enableScreenProtection: boolean;
  screen: {
    useRealDistribution: boolean;
  };

  // Font protection
  enableFontProtection: boolean;

  // Timezone protection
  enableTimezoneProtection: boolean;

  // Sensor protection
  enableSensorProtection: boolean;
  sensors: {
    hideGamepads: boolean;
  };

  // Cryptographic settings
  useStrongKDF: boolean;
  kdfIterations: number;
  useGaussianNoise: boolean;
}

/**
 * PRNG function type - returns random number between 0 and 1
 */
export type PRNGFunction = () => number;

/**
 * Noise generation function type
 */
export type NoiseFunction = (scale?: number) => number;

/**
 * Gaussian noise function type
 */
export type GaussianNoiseFunction = (mean?: number, stddev?: number) => number;

/**
 * Fingerprint environment containing all runtime state
 */
export interface FingerprintEnv {
  salt: string;
  seed: number;
  prng: PRNGFunction;
  noise: NoiseFunction;
  gaussianNoise: GaussianNoiseFunction;
  uniformNoise: NoiseFunction;
  config: FingerprintConfig;
}

/**
 * Hook installer function type
 */
export type HookInstaller = (env: FingerprintEnv) => void | Promise<void>;

/**
 * Timing utilities interface
 */
export interface TimingUtils {
  init: (prng: PRNGFunction) => void;
  randomDelay: () => Promise<void>;
  randomDelaySync: () => void;
  executionJitter: () => number;
  timingResistant: <T extends (...args: any[]) => any>(
    fn: T,
    async?: boolean
  ) => T;
}

/**
 * Stealth utilities interface
 */
export interface StealthUtils {
  isPatched: (obj: any) => boolean;
  markPatched: (obj: any) => void;
  cleanupGlobals: () => void;
  createProxy: <T extends object>(target: T, handler: ProxyHandler<T>) => T;
}

/**
 * Global fingerprint API
 */
export interface FingerprintGlobals {
  ssConfig?: FingerprintConfig;
  ssGetSalt?: () => Promise<string>;
  ssDeriveSeed?: (baseSalt: string, origin: string) => number;
  ssHashString?: (str: string) => number;
  ssCreatePRNG?: (seed: number) => PRNGFunction;
  ssPRNG?: PRNGFunction;
  ssNoise?: NoiseFunction;
  ssEnv?: FingerprintEnv;
  ssReady?: Promise<FingerprintEnv | null>;
  ssHookInstallers?: HookInstaller[];
  ssTestFingerprint?: () => Promise<string>;
  ssTimingUtils?: TimingUtils;
  ssStealth?: StealthUtils;
}

/**
 * Extend Window interface with fingerprint globals
 */
declare global {
  interface Window extends FingerprintGlobals {}
  var ssConfig: FingerprintConfig | undefined;
  var ssGetSalt: (() => Promise<string>) | undefined;
  var ssDeriveSeed: ((baseSalt: string, origin: string) => number) | undefined;
  var ssHashString: ((str: string) => number) | undefined;
  var ssCreatePRNG: ((seed: number) => PRNGFunction) | undefined;
  var ssPRNG: PRNGFunction | undefined;
  var ssNoise: NoiseFunction | undefined;
  var ssEnv: FingerprintEnv | undefined;
  var ssReady: Promise<FingerprintEnv | null> | undefined;
  var ssHookInstallers: HookInstaller[] | undefined;
  var ssTestFingerprint: (() => Promise<string>) | undefined;
  var ssTimingUtils: TimingUtils | undefined;
  var ssStealth: StealthUtils | undefined;
}

/**
 * Chrome storage items
 */
export interface StorageItems {
  ss_salt?: string;
  ss_site_settings?: Record<string, SiteSettings>;
  ss_stats?: ExtensionStats;
}

/**
 * Per-site settings
 */
export interface SiteSettings {
  enabled: boolean;
  reason?: string;
  canvasNoiseStrength?: number;
  // Can override any config option
  [key: string]: any;
}

/**
 * Extension statistics
 */
export interface ExtensionStats {
  totalCanvasReads: number;
  totalWebGLCalls: number;
  sitesProtected: number;
  lastReset: string;
}

/**
 * Screen resolution entry
 */
export interface ScreenResolution {
  width: number;
  height: number;
  weight: number;
}

/**
 * Battery manager interface
 */
export interface BatteryManager extends EventTarget {
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
  level: number;
  onchargingchange: ((this: BatteryManager, ev: Event) => any) | null;
  onchargingtimechange: ((this: BatteryManager, ev: Event) => any) | null;
  ondischargingtimechange: ((this: BatteryManager, ev: Event) => any) | null;
  onlevelchange: ((this: BatteryManager, ev: Event) => any) | null;
}

/**
 * Network information interface
 */
export interface NetworkInformation extends EventTarget {
  effectiveType: '4g' | '3g' | '2g' | 'slow-2g';
  downlink: number;
  rtt: number;
  saveData: boolean;
  onchange: ((this: NetworkInformation, ev: Event) => any) | null;
}

export {};
