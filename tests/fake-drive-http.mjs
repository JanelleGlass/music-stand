// Google Drive's REST API (the parts the app uses) answered from a FakeDrive,
// as a fetch() replacement. It lets the tests run the app's real Drive code
// (js/gdrive.js, js/sync-remote.js) in Node or in a browser.
//
// It behaves like Drive where the app depends on it: without a fields
// parameter only id, name and mimeType come back; listings come in pages;
// resumable uploads answer 308 with a Range header until the last piece;
// downloads honour Range with 206.

const MINIMAL = (m) => ({ kind: 'drive#file', id: m.id, name: m.name, mimeType: m.mimeType });

// intercept(method, path): may throw (a dropped connection) or return a
// Response (an error from Drive) instead of the normal answer.
export function fakeDriveFetch(drive, { pageSize = 1000, user = { displayName: 'Test', emailAddress: 'test@example.com' }, passThrough = null, intercept = null } = {}) {
  const sessions = new Map();
  let seq = 0;
  const requests = [];

  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const error = (status, message, reason = '') => json(status, { error: { code: status, message, errors: [{ reason }] } });
  const shape = (url, meta) => (url.searchParams.get('fields') ? meta : MINIMAL(meta));

  // The files a listing query asks for: the msKind values it names, and
  // whether it wants trashed files too.
  function matches(q, m) {
    if (!q) return true;
    const kinds = [...q.matchAll(/value='([^']+)'/g)].map((x) => x[1]);
    if (kinds.length && !kinds.includes((m.appProperties || {}).msKind)) return false;
    if (/trashed = false/.test(q) && !/trashed = true/.test(q) && m.trashed) return false;
    return true;
  }

  // A multipart/related body: [metadata JSON, content text].
  function multipart(init, headers) {
    const boundary = ((headers.get('Content-Type') || '').match(/boundary=(\S+)/) || [])[1];
    const parts = String(init.body).split(`--${boundary}`).slice(1, -1)
      .map((p) => p.slice(p.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''));
    return { metadata: JSON.parse(parts[0] || '{}'), text: parts[1] || '' };
  }

  async function bodyBytes(body) {
    if (body == null) return new Uint8Array(0);
    return new Uint8Array(await new Response(body).arrayBuffer());
  }

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host !== 'www.googleapis.com') {
      if (passThrough) return passThrough(input, init);
      throw new TypeError('Load failed');
    }
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const p = url.pathname;
    requests.push(`${method} ${p}${url.search}`);
    const instead = intercept && intercept(method, p);
    if (instead) return instead;

    // Resumable upload pieces: the session address is the credential.
    if (p === '/upload/drive/v3/files' && method === 'PUT') {
      const s = sessions.get(url.searchParams.get('upload_id'));
      if (!s) return error(404, 'Upload session not found');
      const range = headers.get('Content-Range') || '';
      if (range === `bytes */${s.size}`) {
        if (s.file) return json(200, s.file);
        return new Response(null, { status: 308, headers: s.got ? { Range: `bytes=0-${s.got - 1}` } : {} });
      }
      const m = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (!m || Number(m[3]) !== s.size) return error(400, `Bad Content-Range: ${range}`);
      const start = Number(m[1]);
      const bytes = await bodyBytes(init.body);
      if (start !== s.got || bytes.length !== Number(m[2]) - start + 1) return error(400, 'Piece out of order');
      if (s.got + bytes.length < s.size && bytes.length % (256 * 1024)) return error(400, 'Pieces must be multiples of 256 KiB');
      s.parts.push(bytes);
      s.got += bytes.length;
      if (s.got < s.size) return new Response(null, { status: 308, headers: { Range: `bytes=0-${s.got - 1}` } });
      s.file = await drive.upload(s.metadata, new Blob(s.parts));
      return json(200, shape(s.url, s.file));
    }

    if (!/^Bearer \S+/.test(headers.get('Authorization') || '')) return error(401, 'Login Required', 'authError');

    if (p === '/drive/v3/about') return json(200, { user });

    if (p === '/upload/drive/v3/files' && method === 'POST' && url.searchParams.get('uploadType') === 'multipart') {
      const { metadata, text } = multipart(init, headers);
      if ((metadata.appProperties || {}).msKind !== 'data') return error(400, 'The fake only takes the data file this way');
      return json(200, shape(url, await drive.createData(metadata.parents[0], text)));
    }
    const media = p.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (media && method === 'PATCH') {
      const id = decodeURIComponent(media[1]);
      if (!drive.files.has(id)) return error(404, `File not found: ${id}`, 'notFound');
      const { metadata, text } = multipart(init, headers);
      if (Object.keys(metadata).length) await drive.update(id, metadata);
      return json(200, shape(url, await drive.writeData(id, text)));
    }

    if (p === '/upload/drive/v3/files' && method === 'POST') {
      if (url.searchParams.get('uploadType') !== 'resumable') return error(400, 'Only resumable uploads');
      const id = `up${++seq}`;
      sessions.set(id, {
        metadata: JSON.parse(init.body),
        size: Number(headers.get('X-Upload-Content-Length')),
        parts: [],
        got: 0,
        file: null,
        url,
      });
      return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` } });
    }

    if (p === '/drive/v3/files' && method === 'GET') {
      const all = [...drive.files.values()].map((f) => JSON.parse(JSON.stringify(f.meta))).filter((m) => matches(url.searchParams.get('q'), m));
      const start = Number(url.searchParams.get('pageToken') || 0);
      const size = Math.min(pageSize, Number(url.searchParams.get('pageSize') || 100));
      const page = all.slice(start, start + size);
      const fields = url.searchParams.get('fields') || '';
      const body = { files: page.map((m) => (fields.includes('files(') ? m : MINIMAL(m))) };
      if (start + size < all.length) body.nextPageToken = String(start + size);
      return json(200, body);
    }

    if (p === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(init.body);
      if (meta.mimeType !== 'application/vnd.google-apps.folder') return error(400, 'The fake only makes folders this way');
      const file = await drive.createFolder(meta.name, meta.appProperties);
      return json(200, shape(url, file));
    }

    const one = p.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (one) {
      const id = decodeURIComponent(one[1]);
      if (!drive.files.has(id)) return error(404, `File not found: ${id}`, 'notFound');
      if (method === 'PATCH') {
        const add = url.searchParams.get('addParents');
        const remove = url.searchParams.get('removeParents');
        if (add) await drive.move(id, remove, add);
        const file = await drive.update(id, JSON.parse(init.body || '{}'));
        return json(200, shape(url, file));
      }
      if (method === 'GET' && url.searchParams.get('alt') === 'media') {
        const bytes = drive.files.get(id).bytes;
        const range = (headers.get('Range') || '').match(/^bytes=(\d+)-(\d+)$/);
        if (!range) return new Response(bytes, { status: 200 });
        const from = Number(range[1]);
        const to = Math.min(Number(range[2]), bytes.length - 1);
        return new Response(bytes.slice(from, to + 1), { status: 206, headers: { 'Content-Range': `bytes ${from}-${to}/${bytes.length}` } });
      }
      if (method === 'GET') return json(200, shape(url, (await drive.list()).find((m) => m.id === id)));
      if (method === 'DELETE') {
        drive.files.delete(id);
        return new Response(null, { status: 204 });
      }
    }
    return error(400, `The fake doesn’t know ${method} ${p}`);
  };
  fetchImpl.requests = requests;
  return fetchImpl;
}
