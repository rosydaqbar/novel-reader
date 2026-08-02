const adapterMarker = Symbol.for('novel-reader.sqlite-adapter');

function invokeBetterStatement(statement, method, parameters) {
  if (parameters == null) return statement[method]();
  if (Array.isArray(parameters)) return statement[method](...parameters);
  return statement[method](parameters);
}

export function createBetterSqliteAdapter(database) {
  let transactionDepth = 0;

  return {
    [adapterMarker]: true,
    kind: 'better-sqlite3',
    raw: database,
    exec(sql) {
      database.exec(sql);
    },
    run(sql, parameters = []) {
      const result = invokeBetterStatement(database.prepare(sql), 'run', parameters);
      return {
        changes: result.changes,
        lastInsertRowid: Number(result.lastInsertRowid)
      };
    },
    get(sql, parameters = []) {
      return invokeBetterStatement(database.prepare(sql), 'get', parameters) ?? null;
    },
    all(sql, parameters = []) {
      return invokeBetterStatement(database.prepare(sql), 'all', parameters);
    },
    transaction(operation) {
      if (transactionDepth > 0) return operation();
      const execute = database.transaction(() => {
        transactionDepth += 1;
        try {
          return operation();
        } finally {
          transactionDepth -= 1;
        }
      });
      return execute();
    },
    close() {
      database.close();
    }
  };
}

function readSqlJsRows(database, sql, parameters, firstOnly) {
  const statement = database.prepare(sql);
  try {
    if (parameters != null && (!Array.isArray(parameters) || parameters.length)) {
      statement.bind(parameters);
    }

    const rows = [];
    while (statement.step()) {
      rows.push(statement.getAsObject());
      if (firstOnly) break;
    }
    return firstOnly ? rows[0] ?? null : rows;
  } finally {
    statement.free();
  }
}

export function createSqlJsAdapter(database) {
  let transactionDepth = 0;

  return {
    [adapterMarker]: true,
    kind: 'sql.js',
    raw: database,
    exec(sql) {
      database.run(sql);
    },
    run(sql, parameters = []) {
      database.run(sql, parameters);
      const changes = database.getRowsModified();
      const lastIdResult = database.exec('SELECT last_insert_rowid() AS id');
      return {
        changes,
        lastInsertRowid: Number(lastIdResult[0]?.values[0]?.[0] ?? 0)
      };
    },
    get(sql, parameters = []) {
      return readSqlJsRows(database, sql, parameters, true);
    },
    all(sql, parameters = []) {
      return readSqlJsRows(database, sql, parameters, false);
    },
    transaction(operation) {
      if (transactionDepth > 0) return operation();
      database.run('BEGIN IMMEDIATE');
      transactionDepth += 1;
      try {
        const result = operation();
        database.run('COMMIT');
        return result;
      } catch (error) {
        database.run('ROLLBACK');
        throw error;
      } finally {
        transactionDepth -= 1;
      }
    },
    close() {
      database.close();
    }
  };
}

export function isSqliteAdapter(value) {
  return Boolean(value?.[adapterMarker]);
}

export function createSqliteAdapter(database) {
  if (isSqliteAdapter(database)) return database;
  if (typeof database?.pragma === 'function' && typeof database?.transaction === 'function') {
    return createBetterSqliteAdapter(database);
  }
  if (typeof database?.getRowsModified === 'function' && typeof database?.export === 'function') {
    return createSqlJsAdapter(database);
  }
  throw new TypeError('Unsupported SQLite database. Expected a better-sqlite3 or sql.js Database instance.');
}
