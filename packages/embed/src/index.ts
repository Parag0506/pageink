export type {
  Anchor,
  FolderIO,
  InkConfig,
  InkState,
  KV,
  Note,
  PageRecord,
  Rect,
  Stroke,
  SyncReport,
  Theme,
  Tool,
} from 'pageink-core/types';
export { fsFolder } from './folder';
export { type IndexedDbKVOptions, indexedDbKV } from './kv/idb';
export { type LocalKVOptions, localKV, type OwnedKV } from './kv/local';
export { type LegacyStroke, legacySurface, type MigrateOptions, migrateLegacy } from './legacy';
export { type InkEvent, type InkExports, type InkHandle, type MountOptions, mount } from './mount';
