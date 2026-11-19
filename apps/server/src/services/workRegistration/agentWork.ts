import type { AgentWorkRunContext, WorkAccessScope } from '@lobechat/types';
import { FileSource } from '@lobechat/types';
import { eq } from 'drizzle-orm';

import { FileModel } from '@/database/models/file';
import { WorkModel } from '@/database/models/work';
import { hasActiveWorkspaceMembership } from '@/database/models/workspace';
import { agentOperations } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import type { HeteroOperationJwtClaims } from '@/libs/trpc/utils/internalJwt';
import { FileService } from '@/server/services/file';
import {
  HeteroOperationPrincipalError,
  resolveActiveHeteroOperationPrincipal,
} from '@/server/services/heterogeneousAgent/operationPrincipal';
import { resolveHeteroRunShareVisitor } from '@/server/services/heterogeneousAgent/shareVisitor';

import { resolveRunWorkAccessScope } from './shareWorkScope';

/** Why a run may not register Works; `status` follows HTTP semantics. */
export class AgentWorkRunError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = 'AgentWorkRunError';
  }
}

export interface AgentWorkRun {
  run: AgentWorkRunContext;
  workModel: WorkModel;
  workspaceId?: string;
}

/**
 * Resolve the running operation an `lh work` call belongs to, and the Work
 * scope it writes under. The topic, agent and share scope always come from the
 * operation row, never from the CLI.
 *
 * Two callers are accepted:
 * - A run's operation token (device, gateway and sandbox heterogeneous runs),
 *   which must carry `work:write` and name this operation.
 * - A user session naming one of its own operations: the cloud sandbox `lh`
 *   shim of a LobeHub agent run, or a logged-in device.
 */
export const resolveAgentWorkRun = async (params: {
  auth: { heteroAuthKind: string; heteroOperation?: HeteroOperationJwtClaims | null };
  db: LobeChatDatabase;
  operationId: string;
  userId: string;
}): Promise<AgentWorkRun> => {
  const { auth, db, operationId } = params;

  let userId: string;
  if (auth.heteroAuthKind === 'operation') {
    if (!auth.heteroOperation) throw new AgentWorkRunError('Invalid operation token', 401);
    try {
      ({ userId } = await resolveActiveHeteroOperationPrincipal({
        capability: 'work:write',
        claims: auth.heteroOperation,
        db,
        operationId,
      }));
    } catch (error) {
      if (!(error instanceof HeteroOperationPrincipalError)) throw error;
      throw new AgentWorkRunError(error.message, error.status);
    }
  } else if (auth.heteroAuthKind === 'user') {
    userId = params.userId;
  } else {
    throw new AgentWorkRunError('This token cannot register Works', 401);
  }

  const [operation] = await db
    .select({
      agentId: agentOperations.agentId,
      status: agentOperations.status,
      threadId: agentOperations.threadId,
      topicId: agentOperations.topicId,
      userId: agentOperations.userId,
      workspaceId: agentOperations.workspaceId,
    })
    .from(agentOperations)
    .where(eq(agentOperations.id, operationId))
    .limit(1);

  if (!operation || operation.userId !== userId) {
    throw new AgentWorkRunError(`Operation ${operationId} not found`, 404);
  }
  if (operation.status !== 'running') {
    throw new AgentWorkRunError('Operation has already ended', 409);
  }
  if (!operation.topicId) {
    throw new AgentWorkRunError('Operation has no conversation to attach Works to', 409);
  }
  const workspaceId = operation.workspaceId ?? undefined;
  if (
    auth.heteroAuthKind === 'user' &&
    workspaceId &&
    !(await hasActiveWorkspaceMembership(db, { userId, workspaceId }))
  ) {
    throw new AgentWorkRunError('Workspace membership is no longer active', 403);
  }

  const shareVisitor = await resolveHeteroRunShareVisitor({
    db,
    operationId,
    topicId: operation.topicId,
  });
  const accessScope: WorkAccessScope | null | undefined = resolveRunWorkAccessScope({
    shareVisitor,
    topicId: operation.topicId,
  });
  // `resolveRunWorkAccessScope` returns null only for a share run without a
  // topic, which the check above already rules out.
  if (accessScope === null) throw new AgentWorkRunError('Share run has no topic', 409);

  return {
    run: {
      agentId: operation.agentId,
      operationId,
      threadId: operation.threadId,
      topicId: operation.topicId,
      userId,
    },
    workModel: new WorkModel(db, userId, workspaceId, accessScope),
    workspaceId,
  };
};

/**
 * The version metadata of an uploaded file, read from its file row. The CLI
 * names only the file id: the size, type and URL a Work card opens come from
 * the server, never from the agent.
 *
 * Only a file the caller uploaded as run output (`lh work` uploads with the
 * `tool-result` source) qualifies: a workspace member can see teammates'
 * files, and registering one would claim it as this run's output.
 */
export const resolveAgentWorkFile = async (params: {
  db: LobeChatDatabase;
  fileId: string;
  userId: string;
  workspaceId?: string;
}): Promise<{ fileId: string; fileSize: number; fileUrl: string; mimeType: string }> => {
  const { db, fileId, userId, workspaceId } = params;
  const file = await new FileModel(db, userId, workspaceId).findById(fileId);
  if (!file || file.userId !== userId || file.source !== FileSource.ToolResult) {
    throw new AgentWorkRunError(`File ${fileId} not found`, 404);
  }

  return {
    fileId: file.id,
    fileSize: file.size,
    fileUrl: await new FileService(db, userId, workspaceId).getFileAccessUrl(file),
    mimeType: file.fileType,
  };
};
