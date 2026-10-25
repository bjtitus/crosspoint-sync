import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/db.js';
import { documentInfo, editionless } from '../src/models/cover.js';
import { cacheKey } from '../src/models/hardcover-catalog.js';
import type { HttpTransport } from '../src/connectors/types.js';

describe('covers', () => {
  it('drops edition notes from a title before searching', () => {
    expect(editionless('Bel Canto [Movie Tie-In]: A Novel')).toBe('Bel Canto');
    expect(editionless('Dune (Deluxe Edition)')).toBe('Dune');
    expect(editionless('The Hobbit')).toBe('The Hobbit');
  });

  it("uses a matched book's cached Hardcover cover after the free sources missed", async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO users (id, username, key_hash, created_at) VALUES (1, 'u', 'h', 0)").run();
    // Searched an hour ago with no cover, then matched on Hardcover.
    db.prepare(
      `INSERT INTO documents (user_id, document, title, author, cover_checked_at, hc_id, hc_checked_at, page_count, updated_at)
       VALUES (1, ?, 'The Hobbit Sketchbook', 'Alan Lee', ?, '42', ?, 160, 0)`
    ).run('a'.repeat(32), now - 3600, now);
    db.prepare('INSERT INTO catalog_cache (key, data, checked_at) VALUES (?, ?, ?)').run(
      cacheKey('The Hobbit Sketchbook', 'Alan Lee'), JSON.stringify({ id: 42, cover: 'https://hc.test/hobbit.jpg', pages: 160 }), now
    );
    const offline: HttpTransport = async () => {
      throw new Error('no network expected');
    };
    expect((await documentInfo(db, 1, 'a'.repeat(32), offline, {})).cover).toBe('https://hc.test/hobbit.jpg');
  });
});
