import type { GalleryWorkImage } from '@lobechat/types';

import { useClientDataSWR } from '@/libs/swr';
import { workService } from '@/services/work';

/**
 * The images a gallery viewer shows: the ones the caller passed, else those of
 * the Work's latest version (readable by its owner only).
 */
export const useGalleryImages = ({
  items,
  workId,
}: {
  items?: GalleryWorkImage[];
  workId?: string;
}) => {
  const { data, error, isLoading, mutate } = useClientDataSWR(
    items || !workId ? null : ['gallery-work-images', workId],
    async () => {
      // Versions come newest first.
      const [latest] = await workService.listVersions(workId!);
      return latest?.metadata?.gallery?.items ?? [];
    },
  );

  return {
    error: items ? undefined : error,
    images: items ?? data,
    isLoading: !items && isLoading,
    retry: () => {
      void mutate();
    },
  };
};
