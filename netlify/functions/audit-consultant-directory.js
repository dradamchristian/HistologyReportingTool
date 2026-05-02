const { getPool, json } = require('./_audit-db');

exports.handler = async (event) => {
  try {
    const db = getPool();
    await db.query(`create table if not exists audit.consultant_directory (name text primary key, created_at timestamptz not null default now())`);

    if (event.httpMethod === 'GET') {
      const result = await db.query('select name, created_at from audit.consultant_directory order by name');
      return json(200, { ok: true, consultants: result.rows });
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const name = (b.name || '').trim();
      if (!name) return json(400, { ok: false, error: 'name is required' });
      await db.query('insert into audit.consultant_directory(name) values ($1) on conflict do nothing', [name]);
      return json(200, { ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const b = JSON.parse(event.body || '{}');
      const name = (b.name || '').trim();
      if (!name) return json(400, { ok: false, error: 'name is required' });
      await db.query('delete from audit.consultant_directory where name = $1', [name]);
      return json(200, { ok: true });
    }

    return json(405, { ok: false, error: 'Method not allowed' });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
