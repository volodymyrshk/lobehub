import type { GalleryWorkVersionMetadata } from '@lobechat/types';

import { createDisplayWorkAdapter } from './displayWork';

export const galleryWorkAdapter = createDisplayWorkAdapter({ type: 'gallery' });

/**
 * The image a gallery card shows: the named cover, else the first image. List
 * rows carry no version metadata, so its URL is also denormalized into
 * `works.url`.
 */
export const galleryCoverUrl = (gallery: GalleryWorkVersionMetadata): string | null => {
  const cover = gallery.coverFileId
    ? gallery.items.find((item) => item.fileId === gallery.coverFileId)
    : undefined;
  return (cover ?? gallery.items[0])?.url ?? null;
};
