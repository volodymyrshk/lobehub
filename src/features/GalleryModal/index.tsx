'use client';

import type { GalleryWorkImage } from '@lobechat/types';
import { createModal, Empty } from '@lobehub/ui';
import { t } from 'i18next';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';

import GalleryGrid from './GalleryGrid';
import { useGalleryImages } from './useGalleryImages';

export interface GalleryModalParams {
  /**
   * The gallery's images when the caller already has them (summary rows, the
   * share profile). Without them the modal loads the latest version, which only
   * the Work's owner may read.
   */
  items?: GalleryWorkImage[];
  title?: string | null;
  workId?: string;
}

const GalleryModalContent = ({ items, workId }: Pick<GalleryModalParams, 'items' | 'workId'>) => {
  const { t } = useTranslation('chat');
  const { error, images, isLoading, retry } = useGalleryImages({ items, workId });

  return (
    <AsyncBoundary
      data={images}
      empty={<Empty description={t('workingPanel.works.galleryEmpty')} />}
      error={error}
      isEmpty={!error && !images?.length}
      isLoading={isLoading}
      onRetry={retry}
    >
      {images && <GalleryGrid items={images} />}
    </AsyncBoundary>
  );
};

export const createGalleryModal = ({ items, title, workId }: GalleryModalParams) =>
  createModal({
    content: <GalleryModalContent items={items} workId={workId} />,
    footer: null,
    maskClosable: true,
    styles: { content: { maxHeight: '75vh', overflowY: 'auto' } },
    title: title?.trim() || t('workingPanel.works.galleryUntitled', { ns: 'chat' }),
    width: 'min(95vw, 960px)',
  });
