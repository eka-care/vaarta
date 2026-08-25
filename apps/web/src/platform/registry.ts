import type {
  CapabilityId,
  HostId,
  IBlobStore,
  IStorage,
  Platform,
  PlatformImplementations,
} from './contracts';
// Build-time family selection: `@platform-impl` resolves to `src/platform/web` or
// `src/platform/electron` per NEXT_PUBLIC_APP_SOURCE (next.config.ts), so the non-target
// family is tree-shaken out. See .claude/docs/architecture/implementation-guide.md §2.
import { host as familyHost, flavour as familyFlavour, implementations as familyImplementations } from '@platform-impl';

/**
 * Descriptor ids each capability key contributes to the active set. When an
 * implementation for a key is present in the selected family, its descriptors become
 * active and any UI gated on them appears. Keep this aligned with `CapabilityId`.
 */
const DESCRIPTORS_BY_CAPABILITY: Record<keyof Platform, CapabilityId[]> = {
  appUpdates: ['app-updates'],
  audioCapture: ['mic-permission-prompt', 'system-audio-capture'],
  authTokens: ['host-managed-auth'],
  blobStore: ['large-blob-store'],
  clipboard: ['rich-clipboard'],
  desktopSettings: ['desktop-settings'],
  filePicker: ['native-file-dialog'],
  hostBridge: ['host-recording-control'],
  network: ['ipc-network'],
  notifier: ['os-notifications'],
  printer: ['native-pdf-export'],
  storage: ['persistent-kv'],
  system: ['shell-open'],
};

const implementations: PlatformImplementations = familyImplementations;

const activeCapabilities: ReadonlySet<CapabilityId> = new Set(
  (Object.keys(implementations) as Array<keyof Platform>)
    .flatMap((key) => DESCRIPTORS_BY_CAPABILITY[key] ?? [])
    // Every family registers `printer`, but only one with a native HTML->PDF path exports PDFs.
    .filter(
      (id) =>
        id !== 'native-pdf-export' || typeof implementations.printer?.htmlToPdf === 'function'
    )
);

/** The build-selected capability implementations. */
export function getPlatform(): PlatformImplementations {
  return implementations;
}

/** The descriptor ids active in this build/runtime. */
export function getActiveCapabilities(): ReadonlySet<CapabilityId> {
  return activeCapabilities;
}

/**
 * Host identity of the build-selected family (`'web'` | `'desktop'`). Drives the
 * platform-visibility primitives only; everything else gates on capabilities.
 */
export function getHost(): HostId {
  return familyHost;
}

/** Build-time app flavour string. Varies per platform family. */
export function getFlavour(): string {
  return familyFlavour;
}

/** Network transport for non-React code. Every family registers it. */
export function getNetwork(): PlatformImplementations['network'] {
  return implementations.network;
}

/** Auth tokens for non-React code. Every family registers it. */
export function getAuthTokens(): PlatformImplementations['authTokens'] {
  return implementations.authTokens;
}

/**
 * Key-value storage accessor for non-React code (store, utils). Every family registers
 * `storage`, so it is always present.
 */
export function getStorage(): IStorage {
  const storage = implementations.storage;
  if (!storage) throw new Error('Storage capability is not registered');
  return storage;
}

/** Blob store accessor for non-React code. Always present in every family. */
export function getBlobStore(): IBlobStore {
  const blob = implementations.blobStore;
  if (!blob) throw new Error('BlobStore capability is not registered');
  return blob;
}
