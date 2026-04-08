"""
Markdown/MDX file loader for OpenFS indexer.
Recursively scans a directory for .md/.mdx files and maps them to virtual paths.
"""

from pathlib import Path


def load_markdown_dir(
    directory: Path,
    prefix: str = "/docs",
    extensions: tuple[str, ...] = (".md", ".mdx", ".markdown"),
) -> dict[str, str]:
    """
    Load all markdown files from a directory into a path→content map.

    Args:
        directory: Root directory to scan
        prefix: Virtual path prefix (e.g., "/docs")
        extensions: File extensions to include

    Returns:
        Dict mapping virtual paths to file contents
    """
    files: dict[str, str] = {}
    root = directory.resolve()

    for filepath in sorted(root.rglob("*")):
        if not filepath.is_file():
            continue
        if filepath.suffix.lower() not in extensions:
            continue
        if filepath.name.startswith("."):
            continue

        # Build virtual path
        relative = filepath.relative_to(root)
        vpath = f"{prefix}/{relative}".replace("\\", "/")

        try:
            content = filepath.read_text(encoding="utf-8")
            files[vpath] = content
        except (UnicodeDecodeError, PermissionError) as e:
            print(f"  Skipping {filepath}: {e}")

    return files
