import type { GalleryModalParams } from '.';

/** Load the gallery viewer on first open, so cards do not bundle the image viewer. */
export const openGalleryModal = async (params: GalleryModalParams) => {
  const { createGalleryModal } = await import('.');
  return createGalleryModal(params);
};
