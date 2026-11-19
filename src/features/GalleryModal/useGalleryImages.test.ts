import { renderHook, waitFor } from '@testing-library/react';
import useSWR from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGalleryImages } from './useGalleryImages';

const { listVersions } = vi.hoisted(() => ({ listVersions: vi.fn() }));

vi.mock('@/services/work', () => ({ workService: { listVersions } }));
vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (key: unknown, fetcher: () => Promise<unknown>) => useSWR(key, fetcher),
}));

const image = (n: number) => ({ fileId: `file-${n}`, url: `https://app.example.com/f/file-${n}` });

describe('useGalleryImages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the images it is given without loading the versions', () => {
    const { result } = renderHook(() =>
      useGalleryImages({ items: [image(1), image(2)], workId: 'work-1' }),
    );

    expect(result.current).toMatchObject({ images: [image(1), image(2)], isLoading: false });
    expect(listVersions).not.toHaveBeenCalled();
  });

  it('loads the images of the latest version for a list row', async () => {
    // Versions come newest first.
    listVersions.mockResolvedValue([
      { metadata: { gallery: { items: [image(3)] } } },
      { metadata: { gallery: { items: [image(1)] } } },
    ]);

    const { result } = renderHook(() => useGalleryImages({ workId: 'work-gallery-latest' }));

    await waitFor(() => expect(result.current.images).toEqual([image(3)]));
    expect(listVersions).toHaveBeenCalledWith('work-gallery-latest');
  });
});
