import type { Config } from '../config.js';
import { createCatboxMirror } from './catbox.js';
import { createImgbbMirror } from './imgbb.js';
import { createYourImageShareMirror } from './yourimageshare.js';
import type { MirrorHost } from './types.js';

export type { MirrorHost, UploadInput, UploadResult } from './types.js';

/**
 * Builds the mirror registry from config. A host named in MIRRORS but not
 * configured (e.g. imgbb without IMGBB_KEY) is a startup error: silently
 * dropping it would make posts look mirrored when they are not.
 */
export function createMirrors(config: Config): Map<string, MirrorHost> {
  const registry = new Map<string, MirrorHost>();

  for (const name of config.mirrors) {
    if (registry.has(name)) continue;
    switch (name) {
      case 'catbox':
        registry.set(name, createCatboxMirror());
        break;
      case 'imgbb': {
        if (!config.imgbbKey) {
          throw new Error('MIRRORS includes imgbb but IMGBB_KEY is not set');
        }
        registry.set(name, createImgbbMirror(config.imgbbKey));
        break;
      }
      case 'yourimageshare': {
        if (!config.yourImageShareKey) {
          throw new Error('MIRRORS includes yourimageshare but YOURIMAGESHARE_KEY is not set');
        }
        registry.set(name, createYourImageShareMirror(config.yourImageShareKey));
        break;
      }
      default:
        throw new Error(`unknown mirror: ${name}`);
    }
  }

  return registry;
}
