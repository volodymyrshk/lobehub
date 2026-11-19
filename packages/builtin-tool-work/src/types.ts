/** Permanent: stored in message history. */
export const WorkIdentifier = 'lobe-work';

export const WorkApiName = {
  createWork: 'createWork',
  deleteWork: 'deleteWork',
  updateWork: 'updateWork',
} as const;

export type WorkApiNameType = (typeof WorkApiName)[keyof typeof WorkApiName];

/** One gallery image as the model names it. */
export interface WorkImageArg {
  caption?: string;
  /** A file id (`file_…`) or the `/f/file_…` link image generation returns. */
  image: string;
}

export interface CreateWorkArgs {
  /** One of `items[].image`; the first image when left out. Gallery only. */
  coverImage?: string;
  description?: string;
  /** Gallery images in display order. Required for a gallery. */
  items?: WorkImageArg[];
  title: string;
  type: 'gallery' | 'link';
  /** http(s) link. Required for a link. */
  url?: string;
}

export interface UpdateWorkArgs {
  coverImage?: string;
  description?: string;
  /** The complete new image list; replaces the current one. Gallery only. */
  items?: WorkImageArg[];
  title?: string;
  workId: string;
}

export interface DeleteWorkArgs {
  workId: string;
}

/** A Work as the model and the inspector see it after a create or update. */
export interface WorkSummary {
  /** Number of images; gallery only. */
  imageCount?: number;
  title: string | null;
  type: 'gallery' | 'link';
  url?: string | null;
  workId: string;
}

export interface WorkState {
  work: WorkSummary;
}

export interface DeleteWorkState {
  deleted: { title: string | null; workId: string };
}

export const WORK_TOOL_ERROR_CODES = [
  'conflict',
  'forbidden',
  'invalid_input',
  'not_found',
  'unavailable',
  'unknown',
] as const;

export type WorkToolErrorCode = (typeof WORK_TOOL_ERROR_CODES)[number];

export interface WorkToolErrorState {
  error: { code: WorkToolErrorCode; message: string };
}
