// Run with: node --test tests/*.test.mjs
// The app's real Drive code (js/gdrive.js, js/sync-remote.js) against a fake
// Drive REST API, so the requests it sends are the ones Drive expects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncOnce, SyncStopped } from '../js/sync-engine.js';
import { driveRemote } from '../js/sync-remote.js';
import { FakeDrive } from './fake-drive.mjs';
import { FakeDevice } from './fake-device.mjs';
import { fakeDriveFetch } from './fake-drive-http.mjs';

const realFetch = globalThis.fetch;

function setup({ pageSize = 1000, intercept = null } = {}) {
  const drive = new FakeDrive();
  const fetch = fakeDriveFetch(drive, { pageSize, intercept });
  globalThis.fetch = fetch;
  const clock = { now: 1_700_000_000_000 };
  const remote = driveRemote(() => 'test-token');
  return { drive, fetch, remote, a: new FakeDevice('A', clock), b: new FakeDevice('B', clock) };
}

test.afterEach(() => { globalThis.fetch = realFetch; });

const sync = (remote, device, opts = {}) => syncOnce({ remote, local: device, now: () => device.now(), ...opts });

test('upload, list across pages, rename, trash and download all speak Drive’s language', async () => {
  const { drive, fetch, remote, a, b } = setup({ pageSize: 2 });
  for (const n of ['1', '2', '3', '4', '5']) a.add(`Score ${n}`, `content ${n}`);
  assert.equal((await sync(remote, a)).uploaded, 5);
  const live = drive.live();
  assert.equal(live.length, 5);
  for (const m of live) {
    assert.equal(m.mimeType, 'application/pdf');
    assert.equal(m.appProperties.msKind, 'score');
    assert.match(m.appProperties.msHash, /^[0-9a-f]{64}$/);
    assert.equal(m.parents[0], drive.live('folder')[0].id);
  }
  // Six files (five scores and the folder) at two per page.
  assert.equal((await sync(remote, b)).downloaded, 5);
  assert.ok(fetch.requests.some((r) => r.includes('pageToken=4')));
  b.rename(b.byName('Score 1').id, 'First');
  b.delete(b.byName('Score 2').id);
  await sync(remote, b);
  const r = await sync(remote, a);
  assert.deepEqual([r.renamed, r.deleted], [1, 1]);
  assert.deepEqual(a.names(), ['First', 'Score 3', 'Score 4', 'Score 5']);
});

test('a big PDF goes up and comes down in pieces, and a stopped download carries on', async () => {
  const { drive, fetch, remote, a, b } = setup();
  a.add('Hymnal', 'h'.repeat(20 * 1024 * 1024));
  assert.equal((await sync(remote, a)).uploaded, 1);
  const puts = fetch.requests.filter((r) => r.startsWith('PUT /upload'));
  assert.equal(puts.length, 3); // 8 + 8 + 4 MiB
  assert.equal(drive.live()[0].size, String(20 * 1024 * 1024));
  let gets = 0;
  await assert.rejects(sync(remote, b, {
    progress: (p) => { if (p.step === 'download' && p.sent) gets++; },
    shouldStop: () => gets >= 2,
  }), SyncStopped);
  assert.equal((await b.partial(drive.live()[0].id)).length, 2);
  const before = fetch.requests.length;
  assert.equal((await sync(remote, b)).downloaded, 1);
  assert.equal(fetch.requests.slice(before).filter((r) => r.includes('alt=media')).length, 1);
  assert.equal(b.files.values().next().value.hash, a.files.values().next().value.hash);
});

test('an upload paused part way resumes from what Drive has', async () => {
  const { drive, fetch, remote, a } = setup();
  a.add('Hymnal', 'h'.repeat(20 * 1024 * 1024));
  let pieces = 0;
  await assert.rejects(sync(remote, a, { progress: () => { pieces++; }, shouldStop: () => pieces >= 1 }), SyncStopped);
  assert.equal(drive.live().length, 0);
  const before = fetch.requests.length;
  assert.equal((await sync(remote, a)).uploaded, 1);
  const after = fetch.requests.slice(before);
  assert.equal(after.filter((r) => r.startsWith('POST /upload')).length, 0); // same session
  assert.equal(after.filter((r) => r.startsWith('PUT /upload')).length, 3); // status check + 2 pieces
  assert.equal(drive.live().length, 1);
});

test('two Music Stand folders are merged by moving files between them', async () => {
  const { drive, remote, a, b } = setup();
  a.add('Grace', 'g');
  b.add('Vision', 'v');
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const res = await real(input, init);
    // Both iPads see an empty Drive the first time.
    if (String(input).includes('/drive/v3/files?') && ((init && init.method) || 'GET') === 'GET') return new Response(JSON.stringify({ files: [] }));
    return res;
  };
  await sync(remote, a);
  await sync(remote, b);
  globalThis.fetch = real;
  assert.equal(drive.live('folder').length, 2);
  await sync(remote, a);
  const inUse = drive.live('folder').sort((x, y) => (x.createdTime < y.createdTime ? -1 : 1))[0];
  assert.ok(drive.live().every((m) => m.parents.length === 1 && m.parents[0] === inUse.id));
  a.clock.now += 9 * 24 * 60 * 60 * 1000;
  await sync(remote, a);
  assert.equal(drive.live('folder').length, 1);
});

test('without a sign-in Drive refuses, and the run stops with a 401', async () => {
  const { a } = setup();
  a.add('Grace', 'g');
  const remote = driveRemote(() => { throw Object.assign(new Error('ran out'), { status: 401 }); });
  await assert.rejects(sync(remote, a), (e) => e.status === 401);
});

test('a dropped connection part way through an upload is waited out, and the upload goes on', async () => {
  let puts = 0;
  const { drive, remote, a } = setup({
    intercept: (method, path) => {
      if (method === 'PUT' && path === '/upload/drive/v3/files' && ++puts === 2) throw new TypeError('Load failed');
      return null;
    },
  });
  a.add('Hymnal', 'h'.repeat(20 * 1024 * 1024));
  const r = await sync(remote, a);
  assert.equal(r.uploaded, 1);
  assert.equal(drive.live()[0].size, String(20 * 1024 * 1024));
});

test('two short Drive outages in one long upload don’t stop it', async () => {
  let puts = 0;
  const busy = () => new Response(JSON.stringify({ error: { code: 503, message: 'busy' } }), { status: 503 });
  const { drive, remote, a } = setup({
    intercept: (method, path) => {
      if (method !== 'PUT' || path !== '/upload/drive/v3/files') return null;
      puts++;
      return puts === 2 || puts === 6 ? busy() : null;
    },
  });
  a.add('Hymnal', 'h'.repeat(40 * 1024 * 1024));
  const r = await sync(remote, a);
  assert.equal(r.uploaded, 1);
  assert.equal(drive.live().length, 1);
});

test('a network blip while checking a paused upload keeps the upload’s progress', async () => {
  let failStatus = 0;
  const { drive, fetch, remote, a } = setup({
    intercept: (method, path) => {
      if (failStatus > 0 && method === 'PUT' && path === '/upload/drive/v3/files') { failStatus--; throw new TypeError('Load failed'); }
      return null;
    },
  });
  a.add('Hymnal', 'h'.repeat(20 * 1024 * 1024));
  let pieces = 0;
  await assert.rejects(sync(remote, a, { progress: () => { pieces++; }, shouldStop: () => pieces >= 2 }), SyncStopped);
  failStatus = 1; // the first status check after waking fails
  const before = fetch.requests.length;
  assert.equal((await sync(remote, a)).uploaded, 1);
  const after = fetch.requests.slice(before);
  assert.equal(after.filter((r) => r.startsWith('POST /upload')).length, 0); // same session, progress kept
  assert.equal(drive.live().length, 1);
});
