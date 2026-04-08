"""
OpenFS Indexer CLI

Crawl content sources and ingest into OpenFS-compatible databases.

Usage:
    openfs-index markdown ./docs --db ./docs.db
    openfs-index openapi ./spec.yaml --db ./docs.db
    openfs-index git https://github.com/org/repo --db ./docs.db
"""

import click
import json
import sqlite3
from pathlib import Path
from .loaders.markdown import load_markdown_dir
from .chunk import chunk_content


@click.group()
def main():
    """OpenFS content indexer."""
    pass


@main.command()
@click.argument("directory", type=click.Path(exists=True))
@click.option("--db", required=True, help="SQLite database path")
@click.option("--prefix", default="/docs", help="Virtual path prefix")
@click.option("--chunk-size", default=0, help="Chunk size in chars (0 = no chunking)")
@click.option("--public/--private", default=True, help="Set files as public")
@click.option("--groups", default="", help="Comma-separated group names")
def markdown(directory: str, db: str, prefix: str, chunk_size: int, public: bool, groups: str):
    """Index a directory of Markdown/MDX files into SQLite."""
    click.echo(f"Scanning {directory} ...")
    
    files = load_markdown_dir(Path(directory), prefix)
    click.echo(f"Found {len(files)} files")

    group_list = [g.strip() for g in groups.split(",") if g.strip()]
    
    conn = sqlite3.connect(db)
    _ensure_schema(conn)
    
    total_chunks = 0
    for vpath, content in files.items():
        if chunk_size > 0:
            chunks = chunk_content(content, chunk_size)
        else:
            chunks = [content]
        
        # Delete existing
        conn.execute("DELETE FROM files WHERE path = ?", (vpath,))
        
        for i, chunk in enumerate(chunks):
            conn.execute(
                """INSERT INTO files (path, chunk_index, content, size, is_public, groups, mtime)
                   VALUES (?, ?, ?, ?, ?, ?, datetime('now'))""",
                (vpath, i, chunk, len(chunk.encode("utf-8")), 1 if public else 0, json.dumps(group_list))
            )
            total_chunks += 1
    
    # Rebuild FTS
    try:
        conn.execute("INSERT INTO files_fts(files_fts) VALUES('rebuild')")
    except sqlite3.OperationalError:
        pass  # FTS table might not exist yet
    
    conn.commit()
    conn.close()
    
    click.echo(f"Indexed {len(files)} files ({total_chunks} chunks) into {db}")


@main.command()
@click.argument("spec_path", type=click.Path(exists=True))
@click.option("--db", required=True, help="SQLite database path")
@click.option("--prefix", default="/api-specs", help="Virtual path prefix")
def openapi(spec_path: str, db: str, prefix: str):
    """Index an OpenAPI spec file into SQLite. (stub)"""
    click.echo(f"OpenAPI indexing not yet implemented — contribution welcome!")
    click.echo(f"Would index {spec_path} into {db} at {prefix}")


@main.command()
@click.argument("repo_url")
@click.option("--db", required=True, help="SQLite database path")
@click.option("--prefix", default="/repo", help="Virtual path prefix")
def git(repo_url: str, db: str, prefix: str):
    """Index a Git repository into SQLite. (stub)"""
    click.echo(f"Git indexing not yet implemented — contribution welcome!")
    click.echo(f"Would clone {repo_url} and index into {db} at {prefix}")


def _ensure_schema(conn: sqlite3.Connection):
    """Create OpenFS tables if they don't exist."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS files (
            path TEXT NOT NULL,
            chunk_index INTEGER NOT NULL DEFAULT 0,
            content TEXT NOT NULL DEFAULT '',
            is_public INTEGER NOT NULL DEFAULT 1,
            groups TEXT NOT NULL DEFAULT '[]',
            size INTEGER NOT NULL DEFAULT 0,
            mtime TEXT NOT NULL DEFAULT (datetime('now')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (path, chunk_index)
        );
        CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
    """)
    try:
        conn.execute("""
            CREATE VIRTUAL TABLE files_fts USING fts5(
                path, content,
                content='files', content_rowid='rowid'
            )
        """)
    except sqlite3.OperationalError:
        pass

    conn.executescript("""
        CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
            INSERT INTO files_fts(rowid, path, content) VALUES (new.rowid, new.path, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
            INSERT INTO files_fts(files_fts, rowid, path, content) VALUES('delete', old.rowid, old.path, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
            INSERT INTO files_fts(files_fts, rowid, path, content) VALUES('delete', old.rowid, old.path, old.content);
            INSERT INTO files_fts(rowid, path, content) VALUES (new.rowid, new.path, new.content);
        END;
    """)


if __name__ == "__main__":
    main()
