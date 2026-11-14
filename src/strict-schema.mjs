// Called only inside the migration write lock, after the durable no-clobber backup.
export const CORE_TABLES = ['spaces','memories','memory_revisions','entity_slots','vectors','wiki_pages','ingest_queue','meta'];
const ident = s => '"' + s.replaceAll('"','""') + '"';
export function upgradeStrictTables(db) {
  if (!db.isTransaction) throw new Error('STRICT migration requires an active transaction');
  const list = db.prepare('PRAGMA main.table_list').all();
  const tables = CORE_TABLES.filter(n => list.some(t => t.name === n && t.schema === 'main' && t.strict !== 1));
  if (!tables.length) return;
  const objects = db.prepare("SELECT sql FROM main.sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL").all();
  const seq = db.prepare("SELECT 1 FROM main.sqlite_master WHERE name='sqlite_sequence'").get()
    ? db.prepare('SELECT name, seq FROM main.sqlite_sequence').all() : [];
  for (const name of tables) {
    const q = ident(name), temp = ident('__mj_strict_' + name);
    const sql = db.prepare("SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?").get(name)?.sql;
    const info = db.prepare('PRAGMA main.table_xinfo(' + q + ')').all();
    if (!sql || !/[)][ ]*$/.test(sql.trim()) || info.some(c => c.hidden)) throw new Error('unsupported STRICT source schema: ' + name);
    const cols = info.map(c => ident(c.name));
    // Unary + removes affinity: staging must not coerce invalid legacy storage classes.
    db.exec('CREATE TEMP TABLE ' + temp + ' AS SELECT +rowid AS __mj_rowid,' + cols.map(c=>'+'+c+' AS '+c).join(',') + ' FROM main.' + q);
    db.exec('DROP TABLE main.' + q);
    db.exec(sql.trim() + ' STRICT');
    db.exec('INSERT INTO main.' + q + '(rowid,'+cols.join(',')+') SELECT __mj_rowid,'+cols.join(',')+' FROM temp.'+temp);
    const projected = cols.flatMap(c=>[c,'typeof('+c+')']).join(',');
    const before = 'SELECT __mj_rowid,'+projected+' FROM temp.'+temp;
    const after = 'SELECT rowid,'+projected+' FROM main.'+q;
    if (db.prepare('SELECT 1 FROM ('+before+' EXCEPT '+after+') LIMIT 1').get()
        || db.prepare('SELECT 1 FROM ('+after+' EXCEPT '+before+') LIMIT 1').get()) {
      throw new Error('STRICT migration would change values or storage classes: ' + name);
    }
    db.exec('DROP TABLE temp.'+temp);
  }
  // Preserve deleted AUTOINCREMENT high-water marks; never reuse an old revision/job id.
  for(const row of seq) {
    db.prepare('UPDATE main.sqlite_sequence SET seq=? WHERE name=?').run(row.seq,row.name);
  }
  for(const {sql} of objects) {
    // Recreate only objects dropped with rebuilt tables; surviving objects are untouched.
    const exists = db.prepare('SELECT 1 FROM main.sqlite_master WHERE sql=?').get(sql);
    if(!exists) db.exec(sql);
  }
  if (db.prepare('PRAGMA main.foreign_key_check').get()) throw new Error('STRICT migration foreign key check failed');
  const integrity=db.prepare('PRAGMA main.integrity_check').all();
  if(integrity.length!==1 || integrity[0].integrity_check!=='ok') throw new Error('STRICT migration integrity check failed');
}
