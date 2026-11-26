import { QuotaExceededError } from './errors.js';

export interface QuotaVersionLike {
  id: string;
  seq: number;
  pinned: boolean;
  blobIds: ReadonlySet<string>;
}

export interface PlanQuotaInput {
  quotaBytes?: number | null;
  versions: readonly QuotaVersionLike[];
  nextBlobIds: Iterable<string>;
  /** Sizes for all existing and next-version blob IDs. */
  blobSizes: ReadonlyMap<string, number>;
}

export interface QuotaPlan {
  allowed: boolean;
  quotaBytes?: number;
  beforeBytes: number;
  afterBytes: number;
  evictVersionIds: string[];
  /** Present only when even all evictable versions are insufficient. */
  irreducibleBytes?: number;
}

export function unionBytes(
  versionSets: Iterable<ReadonlySet<string>>,
  blobSizes: ReadonlyMap<string, number>,
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const blobIds of versionSets) {
    for (const blobId of blobIds) {
      if (seen.has(blobId)) continue;
      seen.add(blobId);
      const size = blobSizes.get(blobId);
      if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
        throw new Error(`缺少内容块 ${blobId} 的有效字节大小`);
      }
      total += size;
    }
  }
  return total;
}

/**
 * Decide which earliest non-pinned published versions must be evicted.
 *
 * The planner is pure and does not mutate anything. Publication only commits
 * its result in one catalog transaction, so callers can safely reject without
 * changing history.
 */
export function planQuota(input: PlanQuotaInput): QuotaPlan {
  const { quotaBytes, versions, nextBlobIds, blobSizes } = input;
  const ordered = [...versions].sort((a, b) => a.seq - b.seq);
  const nextSet = new Set(nextBlobIds);
  const beforeBytes = unionBytes(ordered.map((version) => version.blobIds), blobSizes);

  if (quotaBytes === undefined || quotaBytes === null) {
    return {
      allowed: true,
      beforeBytes,
      afterBytes: unionBytes([...ordered.map((v) => v.blobIds), nextSet], blobSizes),
      evictVersionIds: [],
    };
  }

  if (!Number.isInteger(quotaBytes) || quotaBytes < 0) {
    throw new QuotaExceededError('配额必须是不小于 0 的整数字节数', { quotaBytes });
  }

  const evicted = new Set<string>();
  const evictVersionIds: string[] = [];

  const usedWith = (extraSet: ReadonlySet<string>): number =>
    unionBytes(
      [
        ...ordered.filter((version) => !evicted.has(version.id)).map((version) => version.blobIds),
        extraSet,
      ],
      blobSizes,
    );

  let afterBytes = usedWith(nextSet);

  if (afterBytes > quotaBytes) {
    for (const candidate of ordered) {
      if (afterBytes <= quotaBytes) break;
      if (candidate.pinned) continue;

      evicted.add(candidate.id);
      evictVersionIds.push(candidate.id);
      afterBytes = usedWith(nextSet);
    }
  }

  if (afterBytes > quotaBytes) {
    return {
      allowed: false,
      quotaBytes,
      beforeBytes,
      afterBytes,
      evictVersionIds,
      irreducibleBytes: afterBytes,
    };
  }

  return {
    allowed: true,
    quotaBytes,
    beforeBytes,
    afterBytes,
    evictVersionIds,
  };
}

export function assertQuotaPlan(plan: QuotaPlan): void {
  if (plan.allowed) return;
  throw new QuotaExceededError(
    `快照无法入库：即使淘汰全部可淘汰版本，仍需 ${plan.irreducibleBytes} 字节，` +
      `超过配额 ${plan.quotaBytes} 字节；原有历史已保留。`,
    {
      quotaBytes: plan.quotaBytes,
      requiredBytes: plan.irreducibleBytes,
      beforeBytes: plan.beforeBytes,
      attemptedEvictionIds: plan.evictVersionIds,
    },
  );
}
