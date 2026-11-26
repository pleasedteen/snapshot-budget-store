# Offline Map Snapshot Lab

一个用 **TypeScript + Node.js** 实现的本地持久化快照库，用来归档离线地图工作站每天生成的构建产物。它没有外部服务：元数据放在嵌入式 SQLite 中，文件字节放在本地 SHA-256 内容寻址存储中。

核心能力：

- 从目录创建快照，保存文件的相对路径、字节和基础权限位；
- 跨版本、同版本相同内容只存一份；
- 列出/查询已发布版本；
- 设置或取消“保留/钉住”标记；
- 将指定版本整版校验后恢复到一个尚不存在的新目录；
- 按不同内容块的原始字节计算配额，并按发布顺序自动淘汰可淘汰版本；
- 回收无版本引用、也没有进行中操作需要的内容；
- 报告内容损坏影响到的全部文件，损坏版本不会交付半套恢复目录；
- 发布新版本与淘汰旧版本在同一个 SQLite 事务中提交，崩溃重开只能看到完整的变更前或变更后历史。

---

## 1. 环境与命令

需要 Node.js `>= 22.8`（开发环境为 Node 22.23，使用内置 `node:sqlite`）。

```bash
npm install        # 安装依赖；计时 80 秒不包含此步骤
npm test           # 构建并运行 18 个 Node 测试用例
npm run demo       # 构建并运行本地端到端演示，使用自带 fixtures
npm run verify     # 顺序执行全部测试和演示
./run.sh test      # 等价于 npm test
./run.sh demo      # 等价于 npm run demo
./verify.sh        # 等价于在项目目录执行 npm run verify
```

在当前工作区中，`npm run verify` 通常约 3–5 秒完成；即使在较慢环境中也远低于 80 秒。测试和演示只创建操作系统临时目录中的本地数据，不访问网络、Docker 或外部数据库。

重新生成自带夹具：

```bash
node scripts/make-fixtures.mjs
```

---

## 2. 30 秒使用示例

```ts
import { openArchive } from 'offline-map-snapshot-lab';

const archive = await openArchive('./.map-snapshots', {
  quotaBytes: 500 * 1024 * 1024, // 500 MiB；省略或传 null 表示不限配额
});

// 1. 从当天构建目录发布快照
const published = await archive.createSnapshot('./build/2026-11-26', {
  message: 'cuenca field build 1004',
  pinned: false,
});

console.log(published.version.id);          // v1, v2, ...
console.log(published.evictedVersions);     // 本次为腾配额而淘汰的版本
console.log(published.quota.usedBytes);     // 已发布版本引用的不同内容块总字节

// 2. 列出已发布版本，默认新→旧；也可传 { order: 'asc' }
const versions = await archive.listVersions();

// 3. 设置/取消保留标记；保留版本不会被配额淘汰
await archive.setRetention('v2', true);
await archive.pinVersion('v2');             // 别名
await archive.unpinVersion('v2');

// 4. 恢复到一个尚不存在的新目录
const restored = await archive.restoreVersion('v1', './restored/2026-11-26');
console.log(restored.verified);             // true

// 5. 回收无引用内容
const gc = await archive.gc();
console.log(gc.removedBlobIds, gc.removedBytes);

await archive.close();
```

也可以使用这些导出名：`SnapshotArchive`、`Archive`、`SnapshotLibrary`、`createArchive`、`createSnapshotArchive`、`openSnapshotLibrary`。

---

## 3. 主要 API

### `SnapshotArchive.open(root, options?)`

打开或初始化一个本地库。

- `root`：库目录，不存在会自动创建；
- `options.quotaBytes`：
  - 数字：持久化并设置配额；
  - `null`：取消配额；
  - 省略：保留库中已有配额，新库默认不限；
- `options.crashPoint`：测试/故障注入用，业务代码不要传。

### `createSnapshot(sourceDirectory, options?)`

递归读取普通文件（也会跟随符号链接到文件/目录），复制到私有暂存区并计算 SHA-256，然后在一个 SQLite 事务中发布。

返回：

```ts
interface PublishResult {
  version: VersionDetails;
  evictedVersions: EvictedVersion[];
  quota: { quotaBytes?: number; usedBytes: number; availableBytes?: number; beforeBytes: number };
  newBlobIds: string[];
}
```

### `listVersions({ order?: 'asc' | 'desc' })`

列出版本摘要。每个版本都有单调递增、永不复用的 `seq`；`asc` 即发布顺序。

### `getVersion(id)`

返回版本摘要和完整文件清单：

```ts
interface FileEntry {
  path: string;      // 可移植的 '/' 相对路径
  blobId: string;     // SHA-256 hex
  size: number;       // 原始字节
  mode?: number;
}
```

### `setRetention(id, retained)` / `pinVersion(id)` / `unpinVersion(id)`

设置或取消保留标记。标记会持久化，重开库后仍然存在。调整标记本身不会立即删除版本；它只会影响后续配额淘汰。

### `restoreVersion(id, targetDirectory, options?)` / `restore(...)`

将版本恢复到 **尚不存在的新目录**。恢复过程：

1. 在目录锁内读取清单并登记 blob 租约；
2. 对该版本引用的每个唯一内容块做大小和 SHA-256 校验；
3. 全部健康后复制到目标父目录下的隐藏临时目录；
4. 再对输出文件做一次哈希复核；
5. 全部通过后原子 `rename` 成目标目录。

如果内容损坏，会抛出 `SnapshotCorruptionError`：

```ts
error.affectedFiles; // 所有受影响的清单路径
error.issues;        // MISSING_BLOB / SIZE_MISMATCH / HASH_MISMATCH / READ_ERROR
```

异常情况下不会出现最终目标目录，临时目录会被清理。

### `verifyVersion(id)`

只校验、不恢复，返回 `{ healthy, issues, affectedFiles, ... }`。

### `gc()` / `reclaim()`

扫描内容寻址存储，删除：

- 没有任何已发布版本引用、且没有活动恢复/校验操作持有租约的 blob；
- 当前进程协调器中已不活动的暂存目录；
- 残留的 `.tmp-*` 文件。

返回删除的 blob ID、字节数和暂存目录。成功发布的健康版本仍有元数据引用，因此其 blob 不会被 GC 删除。

### `stats()`

返回版本数、钉住版本数、配额用量、引用 blob 数、磁盘 blob 数、逻辑字节和暂存字节等。

### `close()`

等待当前关键区结束并关闭 SQLite 连接。

---

## 4. 磁盘布局

```text
my-snapshot-archive/
├── archive.sqlite          # 嵌入式 SQLite 元数据（另有 -wal/-shm）
├── objects/
│   └── ab/
│       └── <64位 SHA-256>   # 去重后的原始文件字节
└── staging/
    └── <operation-uuid>/    # 入库准备阶段的私有暂存区
```

恢复时先在目标目录的父目录创建：

```text
.<目标目录名>.restore-<uuid>/
```

校验完成后再改名为目标目录，因此调用方要么看不到目标，要么看到完整目录。

配额只统计 **已发布版本引用的不同 blob 的原始字节总和**：

```sql
SELECT COALESCE(SUM(size), 0)
FROM blobs
WHERE id IN (SELECT DISTINCT blob_id FROM files);
```

以下内容不计入配额：

- `staging/` 中尚未提交的暂存字节；
- 恢复到库外目标目录的输出字节；
- 已无引用、等待 GC 的孤儿内容块。

`archive.stats()` 同时给出 `usedBytes` 和 `stagingBytes`，便于区分。

---

## 5. 配额淘汰规则

设当前所有已发布版本与候选新版本引用的 blob 并集为 `U`。

1. 如果 `sum(blob.size for blob in U) <= quotaBytes`，直接发布；
2. 否则按 `seq` 从早到晚检查旧版本：
   - `pinned = true` 的版本跳过；
   - 对普通版本，模拟删除它并重新计算剩余旧版本 + 新版本的 blob 并集；
   - 一旦总字节第一次降到配额以内，立即停止，因此淘汰的是顺序上最小的前缀集合；
3. 如果淘汰完全部普通版本后，保留版本 + 新版本仍超过配额，则拒绝本次入库；
4. 拒绝发生在任何元数据写入之前，原有版本、保留标记和历史均不变；
5. 成功时，新版本插入和旧版本删除位于同一个 `BEGIN IMMEDIATE` / `COMMIT` 事务中，外部不可能看到“新版本已出现但旧版本尚未淘汰”的中间状态。

因为多个版本可能共享 blob，淘汰一个版本不一定立刻释放字节；规划器会基于引用并集重新计算，继续处理后面的可淘汰版本，直到刚好放下或确认无法放下。

---

## 6. 并发、恢复与 GC

- 源目录遍历、复制、哈希等重 IO 在锁外执行，所以准备入库时仍可：
  - `listVersions()` / `getVersion()`；
  - `restoreVersion()` 已发布版本；
  - 执行 `gc()`。
- 发布、保留标记变更和 GC 关键区由按库根目录共享的 `AsyncMutex` 串行化。
- 恢复/校验在读取清单的同一关键区内登记 blob ID 租约。即使随后配额事务淘汰了该版本，GC 也会跳过这些 blob，直到恢复结束。
- 准备入库的暂存目录会标记为活动操作，并发 GC 不会删除它。
- GC 后，所有仍已发布且健康的版本保持完整可恢复；只有无引用且无活动租约的内容才会被释放。

测试中用确定性屏障复现了以下时序：

```text
restore 已取得版本和租约
  → publish 淘汰该版本
  → gc 跳过该 blob
  → restore 读完并校验成功
  → restore 结束
  → 再次 gc 才真正回收该 blob
```

---

## 7. 崩溃与持久性

SQLite 使用：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
```

blob 发布采用“写临时文件 → fsync → 原子 rename/hard-link → fsync 目录 → 提交 SQLite 事务”的顺序。

测试套件包含真实子进程故障注入：

- 在事务提交前发送 `SIGKILL`：重开后只看到旧历史，没有半版本；
- 在事务提交后发送 `SIGKILL`：重开后看到完整的新历史，以及同一事务中完成的旧版本淘汰，新版本可完整恢复。

正常 `createSnapshot()` resolve 即表示事务已提交；之后进程退出或重启都能查询到该版本。

---

## 8. 内容损坏处理

内容 ID 就是字节的 SHA-256。恢复前会检查：

- blob 文件是否存在；
- 字节数是否等于清单大小；
- 实际 SHA-256 是否等于 blob ID。

同一个损坏 blob 可能对应多个清单文件；错误会把这些文件一次性分组列出。只要有任何 issue，就不会 rename 出最终恢复目录。其他版本有自己的健康 blob，因此仍可恢复。

可以故意破坏演示库中的：

```text
objects/<id前两位>/<完整id>
```

然后调用 `restoreVersion()` 或 `verifyVersion()` 查看报告。

---

## 9. 自带夹具

`fixtures/offline-map-station/` 包含三天的离线地图工作站产物：

```text
day-2026-11-20/
  BUILD.txt
  manifest.json
  map/style.json
  tiles/.../*.mvt
day-2026-11-21/
  ...
day-2026-11-22/
  ...
```

瓦片是确定性生成的二进制数据；相邻日期保留相同瓦片，也包含新增和修改内容，适合演示路径恢复与跨版本去重。

---

## 10. 测试覆盖

`src/test/` 中的 17 个用例覆盖：

- 相对路径、二进制字节恢复；
- 同版本/跨版本内容去重；
- 列表顺序、版本详情、保留标记和重启持久化；
- 配额刚好足够、最早淘汰、跳过钉住版本、全部可淘汰版本仍不足时拒绝；
- 拒绝入库后原历史不变；
- 准备入库期间查询、恢复、GC 可并发；
- 已开始恢复在版本被淘汰和 GC 后仍完成，结束后 blob 才回收；
- 哈希损坏和 blob 缺失的多文件报告；
- 损坏版本不交付、健康版本可恢复；
- `SIGKILL` 子进程崩溃后的事务原子性。

---

## 11. 设计边界

当前实现保证同一个归档根目录在 Node.js 异步并发调用下的安全，并通过 SQLite 保证元数据事务的崩溃原子性。它面向单台离线地图工作站、一个本地 Node.js 进程持有库句柄的典型使用方式；没有实现多主机分布式锁或跨机器对象复制。

符号链接目前按其目标文件/目录内容归档，恢复结果是普通文件和目录，不重建符号链接本身；需求要求的是相对路径和字节，因此这样可以避免链接目标逃逸。
