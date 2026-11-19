"""Store readers the terminal runs in the agents' backend (Windows or WSL), printing JSON.

  opencode DB SINCE_MS             OpenCode sessions updated since SINCE_MS
  backup TOOL DEST SOURCE HOURS KEEP
                                   Snapshot a tool's history into DEST/<tool>-history-<stamp>.tar.gz
                                   unless the newest one is younger than HOURS; keep KEEP.
  board MINUTES                    running sessions with their subagents and shells (board.collect)
"""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import sys
import tarfile
import tempfile
import time


def opencode(database, since):
    if not Path(database).is_file():
        return []
    # closing(): a connection's own `with` only commits, and on Windows an open one locks the file.
    with closing(sqlite3.connect(Path(database).as_uri() + '?mode=ro', uri=True)) as db:
        rows = db.execute('SELECT id, directory, title, time_created, time_updated, parent_id FROM session_v2 '
                          'WHERE time_archived IS NULL AND time_updated >= ?', (int(since),)).fetchall()
    return [{'id': sid, 'cwd': cwd, 'title': title, 'birth': created, 't': updated}
            for sid, cwd, title, created, updated, parent in rows if not parent]


def backup(tool, dest, source, hours, keep):
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    for stale in dest.glob(tool + '-history-*.tar.gz.part'):
        stale.unlink()  # An interrupted snapshot; only finished ones count below.
    snapshots = sorted(dest.glob(tool + '-history-*.tar.gz'))
    if snapshots:
        stamp = snapshots[-1].name[len(tool + '-history-'):-len('.tar.gz')]
        try:
            if time.time() - time.mktime(time.strptime(stamp, '%Y%m%d-%H%M%S')) < float(hours) * 3600:
                return None
        except ValueError:
            pass  # A hand-renamed snapshot: better an extra one than a skipped one.
    out = dest / (tool + '-history-' + time.strftime('%Y%m%d-%H%M%S') + '.tar.gz')
    part = out.with_name(out.name + '.part')
    with tempfile.TemporaryDirectory() as work:
        if tool == 'opencode':
            if not Path(source).is_file():
                return None
            # The online backup API: a plain copy while OpenCode writes can tear the database.
            copy = Path(work) / 'opencode.db'
            with closing(sqlite3.connect(Path(source).as_uri() + '?mode=ro', uri=True)) as db, closing(sqlite3.connect(copy)) as target:
                db.backup(target)
            root, names = Path(work), ['opencode.db']
        else:
            root = Path(source)
            names = {'claude': ['projects', 'history.jsonl'], 'codex': ['sessions', 'session_index.jsonl']}[tool]
            names = [n for n in names if (root / n).exists()]
            if not names:
                return None
        with tarfile.open(part, 'w:gz') as archive:
            for name in names:
                for path in [root / name, *sorted((root / name).rglob('*'))]:
                    try:
                        archive.add(path, arcname=str(path.relative_to(root)), recursive=False)
                    except OSError:
                        pass  # Removed while being read; a live transcript mid-append is still a good-enough copy.
    part.replace(out)
    for old in sorted(dest.glob(tool + '-history-*.tar.gz'))[:-int(keep)]:
        old.unlink()
    return str(out)


def board(minutes):
    import board as live

    def row(r):
        return {'label': r.label, 'project': r.project, 'title': r.title, 'state': r.state, 'since': r.since,
                'detail': r.detail, 'depth': r.depth, 'model': r.model, 'children': [row(c) for c in r.children]}
    return [row(r) for r in live.collect(int(minutes))]


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    command, args = sys.argv[1], sys.argv[2:]
    result = {'opencode': opencode, 'backup': backup, 'board': board}[command](*args)
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
