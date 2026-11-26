import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QuotaExceededError,
  SnapshotArchive,
  SnapshotCorruptionError,
  type VersionSummary,
} from '../index.js';

const fixtureRoot = fileURLToPath(new URL('../../fixtures/offline-map-station/', import.meta.url));

function heading(title: string): void {
  console.log(`\n┌${'─'.repeat(76)}┐`);
  console.log(`│ ${title.padEnd(74, ' ')} │`);
  console.log(`└${'─'.repeat(76)}┘`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function printVersion(version: VersionSummary): void {
  const pin = version.pinned ? '📌保留' : '  普通';
  console.log(
    `  ${pin}  ${version.id}  seq=${version.seq}  文件=${version.fileCount}  ` +
      `逻辑字节=${formatBytes(version.logicalBytes)}  本版去重=${formatBytes(version.distinctBytes)}` +
      `${version.message ? `  说明=${version.message}` : ''}`,
  );
}

async function writeFiles(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

async function main(): Promise<void> {
  const demoRoot = path.join(tmpdir(), `offline-map-snapshot-demo-${randomUUID()}`);
  await mkdir(demoRoot, { recursive: true });

  console.log('🗺️  离线地图工作站快照库演示');
  console.log(`演示数据目录：${demoRoot}`);
  console.log('所有数据均为本地夹具和嵌入式 SQLite/文件存储，不访问网络。');

  // -------------------------------------------------------------------------
  heading('1. 从三天的地图构建产物创建快照并去重');
  // -------------------------------------------------------------------------
  const archiveRoot = path.join(demoRoot, 'map-archive');
  const archive = await SnapshotArchive.open(archiveRoot, { quotaBytes: 512 * 1024 });

  const days = ['day-2026-11-20', 'day-2026-11-21', 'day-2026-11-22'];
  for (const day of days) {
    const result = await archive.createSnapshot(path.join(fixtureRoot, day), {
      message: `离线地图构建 ${day}`,
    });
    console.log(
      `✅ 已发布 ${result.version.id}：${result.version.fileCount} 个文件，` +
        `新增不同内容 ${result.newBlobIds.length} 块，版本去重后 ${formatBytes(result.version.distinctBytes)}`,
    );
  }

  let versions = await archive.listVersions({ order: 'asc' });
  console.log('\n已发布版本（发布顺序）：');
  versions.forEach(printVersion);

  const beforeStats = await archive.stats();
  console.log(
    `\n配额用量：${formatBytes(beforeStats.usedBytes)} / ${formatBytes(beforeStats.quotaBytes ?? 0)}；` +
      `引用内容块=${beforeStats.referencedBlobCount}，磁盘内容块=${beforeStats.storedBlobCount}，` +
      `所有文件逻辑字节=${formatBytes(beforeStats.logicalBytes)}`,
  );
  console.log('逻辑字节大于去重后的配额字节，是因为跨日期/同版本相同瓦片只存一份。');

  // -------------------------------------------------------------------------
  heading('2. 设置/取消保留标记');
  // -------------------------------------------------------------------------
  await archive.setRetention('v2', true);
  console.log('📌 已为 v2 设置保留标记；以后配额淘汰会跳过它。');
  printVersion((await archive.getVersion('v2')) satisfies VersionSummary);
  await archive.setRetention('v2', false);
  console.log('已取消 v2 的保留标记（主流程配额充足，不会立即淘汰）。');

  // -------------------------------------------------------------------------
  heading('3. 恢复 v1 到全新目录并核对字节');
  // -------------------------------------------------------------------------
  const restoreTarget = path.join(demoRoot, 'restored', 'day-2026-11-20');
  const restored = await archive.restoreVersion('v1', restoreTarget);
  const buildText = await readFile(path.join(restoreTarget, 'BUILD.txt'), 'utf8');
  console.log(`✅ 整版校验通过后已原子交付：${restored.targetDir}`);
  console.log(`恢复文件数=${restored.fileCount}，字节=${restored.bytes}，verified=${restored.verified}`);
  console.log(`抽查 BUILD.txt：${buildText.trim()}`);

  const healthyGc = await archive.gc();
  console.log(`常规回收：删除 ${healthyGc.removedBlobIds.length} 个无引用内容块（健康版本仍完整）。`);
  await archive.close();

  // -------------------------------------------------------------------------
  heading('4. 配额淘汰：跳过保留版本，从最早可淘汰版本开始');
  // -------------------------------------------------------------------------
  const quotaRoot = path.join(demoRoot, 'quota-archive');
  const quotaArchive = await SnapshotArchive.open(quotaRoot, { quotaBytes: 20 });
  const quotaSources = path.join(demoRoot, 'quota-sources');

  await writeFiles(path.join(quotaSources, 'day1'), { 'base.bin': 'base00' }); // 6
  const q1 = await quotaArchive.createSnapshot(path.join(quotaSources, 'day1'), { pinned: true, message: '永久基线' });
  await writeFiles(path.join(quotaSources, 'day2'), { 'old-tile.bin': 'old000' }); // 6
  const q2 = await quotaArchive.createSnapshot(path.join(quotaSources, 'day2'), { message: '可淘汰' });
  await writeFiles(path.join(quotaSources, 'day3'), { 'new-tile.bin': '0123456789' }); // 10

  const q3 = await quotaArchive.createSnapshot(path.join(quotaSources, 'day3'), { message: '触发淘汰' });
  console.log(`配额=20 B；v1=${formatBytes(6)} 且保留，v2=${formatBytes(6)}，v3=${formatBytes(10)}。`);
  console.log(`v3 入库时淘汰：${q3.evictedVersions.map((v) => v.id).join(', ')}（跳过 ${q1.version.id}）。`);
  console.log('同时可见的历史：');
  (await quotaArchive.listVersions({ order: 'asc' })).forEach(printVersion);

  const quotaGc = await quotaArchive.gc();
  console.log(`回收 v2 独有内容：${quotaGc.removedBlobIds.length} 块 / ${formatBytes(quotaGc.removedBytes)}。`);

  await writeFiles(path.join(quotaSources, 'too-big'), { 'huge.bin': Buffer.alloc(30, 7) });
  try {
    await quotaArchive.createSnapshot(path.join(quotaSources, 'too-big'), { message: '应该被拒绝' });
    throw new Error('预期的配额拒绝没有发生');
  } catch (error) {
    if (!(error instanceof QuotaExceededError)) throw error;
    console.log(`\n🚫 30 B 新内容无法放入 20 B 配额：${error.message}`);
  }
  console.log('拒绝后历史仍为：');
  (await quotaArchive.listVersions({ order: 'asc' })).forEach(printVersion);
  await quotaArchive.close();

  // -------------------------------------------------------------------------
  heading('5. 内容损坏报告：失败版本不交付，其他健康版本可恢复');
  // -------------------------------------------------------------------------
  const corruptionRoot = path.join(demoRoot, 'corruption-archive');
  const corruptionArchive = await SnapshotArchive.open(corruptionRoot);
  const corruptionSources = path.join(demoRoot, 'corruption-sources');
  const badBytes = Buffer.from('bad-tile!');
  await writeFiles(path.join(corruptionSources, 'broken-day'), {
    'tiles/a.mvt': badBytes,
    'tiles/b.mvt': badBytes,
    'good.txt': 'fine',
  });
  await writeFiles(path.join(corruptionSources, 'healthy-day'), {
    'manifest.json': '{"ok":true}',
  });

  const broken = await corruptionArchive.createSnapshot(path.join(corruptionSources, 'broken-day'));
  const healthy = await corruptionArchive.createSnapshot(path.join(corruptionSources, 'healthy-day'));
  const badBlobId = broken.version.files.find((file) => file.path === 'tiles/a.mvt')!.blobId;
  const badBlobPath = path.join(corruptionRoot, 'objects', badBlobId.slice(0, 2), badBlobId);
  await writeFile(badBlobPath, Buffer.from('X'.repeat(badBytes.length)));

  try {
    await corruptionArchive.restoreVersion(broken.version.id, path.join(demoRoot, 'broken-restore'));
    throw new Error('预期的损坏错误没有发生');
  } catch (error) {
    if (!(error instanceof SnapshotCorruptionError)) throw error;
    console.log(`🧨 ${error.message}`);
    for (const issue of error.issues) {
      console.log(`   - ${issue.code} blob=${issue.blobId.slice(0, 12)}…，受影响文件：${issue.files.join(', ')}`);
    }
  }

  const healthyRestore = path.join(demoRoot, 'healthy-restore');
  await corruptionArchive.restoreVersion(healthy.version.id, healthyRestore);
  console.log(`✅ 健康版本 ${healthy.version.id} 仍可恢复到：${healthyRestore}`);
  await corruptionArchive.close();

  heading('演示完成');
  console.log('全部步骤成功。可重新运行 `npm run demo`；测试使用独立临时目录，互不污染。');
  console.log(`如需检查本次演示数据：${demoRoot}\n`);
}

main().catch((error) => {
  console.error('\n演示失败：', error);
  process.exitCode = 1;
});
