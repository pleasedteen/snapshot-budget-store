/**
 * JSON-lines worker used by the local multi-process interleaving tests.
 *
 * Protocol:
 *  - stdin:  one JSON command per line, `{ id, cmd, token?, ... }`
 *  - stdout: one JSON reply/event per line:
 *      `{ id, ok, result? , error? }` for command completion
 *      `{ event: 'barrier', barrier, token }` when a hook barrier is reached
 *
 * A blocked barrier is released with `{ cmd: 'release', token }`.
 */
import { createInterface } from 'node:readline';
import { SnapshotArchive, type OpenArchiveOptions } from '../index.js';

const archiveRootArg = process.argv[2];
if (!archiveRootArg) {
  process.stderr.write('xproc-worker: missing archive root argument\n');
  process.exit(64);
}
const archiveRoot: string = archiveRootArg;

let archive: SnapshotArchive | undefined;
const releasers = new Map<string, () => void>();

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: unknown, ok: boolean, payload: Record<string, unknown> = {}): void {
  send({ id, ok, ...payload });
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...((error as { code?: string }).code ? { code: (error as { code?: string }).code } : {}),
    };
  }
  return { message: String(error) };
}

function waitForRelease(token: string | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!token) {
      resolve();
      return;
    }
    releasers.set(token, resolve);
  });
}

async function handleCommand(message: Record<string, unknown>): Promise<void> {
  const id = message.id;
  const cmd = String(message.cmd ?? '');

  if (cmd === 'release') {
    const token = String(message.token ?? '');
    const release = releasers.get(token);
    if (release) {
      releasers.delete(token);
      release();
    }
    reply(id, true);
    return;
  }

  try {
    switch (cmd) {
      case 'open': {
        archive = await SnapshotArchive.open(
          archiveRoot,
          (message.options as OpenArchiveOptions | undefined) ?? {},
        );
        reply(id, true);
        break;
      }

      case 'publish': {
        if (!archive) throw new Error('archive not open');
        const source = String(message.source ?? '');
        const options = { ...((message.options as Record<string, unknown> | undefined) ?? {}) };
        if (message.barrier === 'beforePublish') {
          options.hooks = {
            beforePublish: async () => {
              send({ event: 'barrier', barrier: 'beforePublish', token: message.token });
              await waitForRelease(message.token as string | undefined);
            },
          };
        }
        const result = await archive.createSnapshot(
          source,
          options as Parameters<SnapshotArchive['createSnapshot']>[1],
        );
        reply(id, true, { result });
        break;
      }

      case 'restore': {
        if (!archive) throw new Error('archive not open');
        const version = String(message.version ?? '');
        const target = String(message.target ?? '');
        const options = { ...((message.options as Record<string, unknown> | undefined) ?? {}) };
        if (message.barrier === 'afterLease') {
          options.hooks = {
            afterLease: async () => {
              send({ event: 'barrier', barrier: 'afterLease', token: message.token });
              await waitForRelease(message.token as string | undefined);
            },
          };
        }
        const result = await archive.restoreVersion(
          version,
          target,
          options as Parameters<SnapshotArchive['restoreVersion']>[2],
        );
        reply(id, true, { result });
        break;
      }

      case 'verify': {
        if (!archive) throw new Error('archive not open');
        const result = await archive.verifyVersion(String(message.version ?? ''));
        reply(id, true, { result });
        break;
      }

      case 'gc': {
        if (!archive) throw new Error('archive not open');
        const result = await archive.gc();
        reply(id, true, { result });
        break;
      }

      case 'list': {
        if (!archive) throw new Error('archive not open');
        const result = await archive.listVersions(
          (message.options as { order?: 'asc' | 'desc' } | undefined) ?? {},
        );
        reply(id, true, { result });
        break;
      }

      case 'getVersion': {
        if (!archive) throw new Error('archive not open');
        const result = await archive.getVersion(String(message.version ?? ''));
        reply(id, true, { result });
        break;
      }

      case 'setRetention': {
        if (!archive) throw new Error('archive not open');
        const result = await archive.setRetention(
          String(message.version ?? ''),
          Boolean(message.retained),
        );
        reply(id, true, { result });
        break;
      }

      case 'stats': {
        if (!archive) throw new Error('archive not open');
        const result = await archive.stats();
        reply(id, true, { result });
        break;
      }

      case 'close': {
        if (archive) await archive.close();
        reply(id, true);
        setTimeout(() => process.exit(0), 25);
        break;
      }

      default:
        reply(id, false, { error: { message: `unknown command: ${cmd}` } });
    }
  } catch (error) {
    reply(id, false, { error: serializeError(error) });
  }
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (!line.trim()) return;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    send({ event: 'fatal', error: serializeError(error) });
    return;
  }
  // Dispatch without awaiting so a blocked barrier command does not stall
  // processing of the matching `release` line.
  void handleCommand(message);
});

input.on('close', () => {
  // Parent went away; do not leave the archive handle lying around.
  setTimeout(() => process.exit(0), 25);
});
