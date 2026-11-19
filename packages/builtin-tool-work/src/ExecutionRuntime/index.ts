import type { BuiltinServerRuntimeOutput } from '@lobechat/types';

import type {
  CreateWorkArgs,
  DeleteWorkArgs,
  DeleteWorkState,
  UpdateWorkArgs,
  WorkState,
  WorkSummary,
  WorkToolErrorCode,
  WorkToolErrorState,
} from '../types';
import { WORK_TOOL_ERROR_CODES } from '../types';

/**
 * The server's Work writes for the running agent. The run (conversation,
 * operation, share scope) is bound by the server when it builds this service;
 * nothing here takes it from the model.
 */
export interface WorkToolService {
  create: (args: CreateWorkArgs) => Promise<WorkSummary>;
  delete: (workId: string) => Promise<{ title: string | null; workId: string }>;
  update: (args: UpdateWorkArgs) => Promise<WorkSummary>;
}

/** A refused call with a stable code the inspector and the model can read. */
export class WorkToolError extends Error {
  constructor(
    readonly code: WorkToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkToolError';
  }
}

const ERROR_CODES = new Set<WorkToolErrorCode>(WORK_TOOL_ERROR_CODES);

const describeWork = (verb: string, work: WorkSummary) => {
  const images = typeof work.imageCount === 'number' ? `, ${work.imageCount} images` : '';
  return `${verb} ${work.type} Work ${work.workId} ("${work.title ?? ''}"${images}). Use workId ${work.workId} to update or delete it.`;
};

const invalid = (message: string) => new WorkToolError('invalid_input', message);

export class WorkExecutionRuntime {
  constructor(private readonly service: WorkToolService) {}

  private async result<T>(
    run: () => Promise<{ content: string; state: T }>,
  ): Promise<BuiltinServerRuntimeOutput> {
    try {
      const { content, state } = await run();
      return { content, state, success: true };
    } catch (error) {
      const candidate = error instanceof Error && 'code' in error ? error.code : undefined;
      const code: WorkToolErrorCode =
        typeof candidate === 'string' && ERROR_CODES.has(candidate as WorkToolErrorCode)
          ? (candidate as WorkToolErrorCode)
          : 'unknown';
      const message =
        error instanceof Error && error.message ? error.message : 'Could not save the Work.';
      const state: WorkToolErrorState = { error: { code, message } };
      return { content: message, error: { message, type: code }, state, success: false };
    }
  }

  createWork = (args: CreateWorkArgs) =>
    this.result<WorkState>(async () => {
      if (!args?.title?.trim()) throw invalid('A Work needs a title.');
      if (args.type === 'gallery') {
        if (!args.items?.length) throw invalid('A gallery needs at least one image in items.');
        if (args.url) throw invalid('A gallery takes images in items, not a url.');
      } else if (args.type === 'link') {
        if (!args.url) throw invalid('A link Work needs a url.');
        if (args.items?.length || args.coverImage) throw invalid('A link Work takes no images.');
      } else {
        throw invalid('type must be "gallery" or "link".');
      }
      const work = await this.service.create(args);
      return { content: describeWork('Created', work), state: { work } };
    });

  updateWork = (args: UpdateWorkArgs) =>
    this.result<WorkState>(async () => {
      if (!args?.workId) throw invalid('workId is required.');
      if (args.items && args.items.length === 0) {
        throw invalid('items must list at least one image; delete the Work instead.');
      }
      if (args.coverImage && !args.items) {
        throw invalid('Pass the full items list together with coverImage.');
      }
      if (args.title === undefined && args.description === undefined && !args.items) {
        throw invalid('Nothing to update: pass title, description or items.');
      }
      const work = await this.service.update(args);
      return { content: describeWork('Updated', work), state: { work } };
    });

  deleteWork = (args: DeleteWorkArgs) =>
    this.result<DeleteWorkState>(async () => {
      if (!args?.workId) throw invalid('workId is required.');
      const deleted = await this.service.delete(args.workId);
      return {
        content: `Deleted Work ${deleted.workId}${deleted.title ? ` ("${deleted.title}")` : ''}. Its images stay in the file store.`,
        state: { deleted },
      };
    });
}
