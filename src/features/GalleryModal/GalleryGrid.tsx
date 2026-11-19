import type { GalleryWorkImage } from '@lobechat/types';
import { Image, PreviewGroup, Text } from '@lobehub/ui';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';

import { downloadPreviewImage } from '@/features/Conversation/Messages/components/downloadPreviewImage';

const styles = stylex.create({
  caption: {
    color: cssVar.colorTextSecondary,
    fontSize: 12,
    lineHeight: 1.5,
  },
  grid: {
    display: 'grid',
    gap: 12,
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
  },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 0,
  },
});

interface GalleryGridProps {
  items: GalleryWorkImage[];
}

/**
 * Square tiles of every gallery image. One preview group lets the viewer step
 * through the gallery; its download action saves `/f/<id>` images under their
 * stored names.
 */
const GalleryGrid = ({ items }: GalleryGridProps) => (
  <PreviewGroup preview={{ onDownload: downloadPreviewImage }}>
    <div {...stylex.props(styles.grid)}>
      {items.map((item) => (
        <div key={item.fileId} {...stylex.props(styles.tile)}>
          <Image
            alt={item.caption ?? ''}
            objectFit={'cover'}
            src={item.url}
            style={{ aspectRatio: 1 }}
            width={'100%'}
          />
          {item.caption && (
            <Text ellipsis={{ tooltip: true }} {...stylex.props(styles.caption)}>
              {item.caption}
            </Text>
          )}
        </div>
      ))}
    </div>
  </PreviewGroup>
);

export default GalleryGrid;
