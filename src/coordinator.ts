import { randomUUID } from 'node:crypto';

export type OperationKind = 'create-snapshot' | 'restore' | 'verify' | 'gc';

export interface ActiveOperation {
  id: string;
  kind: OperationKind;
  blobIds: Set<string>;
  scratchDirs: Set<string>;
}

/** Minimal promise mutex; every critical catalog/GC section is serialized. */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  async runExclusive<T>(callback: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

/**
 * State shared by all Archive handles for one resolved root in this process.
 * This makes multiple handles in tests/application code observe the same
 * critical-section lock and in-progress operation leases.
 */
export class RootCoordinator {
  readonly root: string;
  readonly mutex = new AsyncMutex();
  readonly operations = new Map<string, ActiveOperation>();

  constructor(root: string) {
    this.root = root;
  }

  startOperation(kind: OperationKind): ActiveOperation {
    const operation: ActiveOperation = {
      id: randomUUID(),
      kind,
      blobIds: new Set(),
      scratchDirs: new Set(),
    };
    this.operations.set(operation.id, operation);
    return operation;
  }

  finishOperation(operationId: string): void {
    this.operations.delete(operationId);
  }

  activeBlobIds(): Set<string> {
    const result = new Set<string>();
    for (const operation of this.operations.values()) {
      for (const blobId of operation.blobIds) result.add(blobId);
    }
    return result;
  }

  isScratchDirectoryActive(directory: string): boolean {
    for (const operation of this.operations.values()) {
      if (operation.scratchDirs.has(directory)) return true;
    }
    return false;
  }
}

const coordinators = new Map<string, RootCoordinator>();

export function coordinatorForRoot(resolvedRoot: string): RootCoordinator {
  let coordinator = coordinators.get(resolvedRoot);
  if (!coordinator) {
    coordinator = new RootCoordinator(resolvedRoot);
    coordinators.set(resolvedRoot, coordinator);
  }
  return coordinator;
}

/** Test helper: forget coordinators between explicitly isolated scenarios. */
export function resetCoordinatorRegistryForTests(): void {
  coordinators.clear();
}
