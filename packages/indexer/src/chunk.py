"""
Content chunking strategies for OpenFS indexer.
"""


def chunk_content(content: str, chunk_size: int, overlap: int = 200) -> list[str]:
    """
    Split content into chunks of approximately chunk_size characters
    with overlap for context continuity.
    """
    if chunk_size <= 0 or len(content) <= chunk_size:
        return [content]

    chunks = []
    start = 0
    while start < len(content):
        end = start + chunk_size

        # Try to break at a paragraph or sentence boundary
        if end < len(content):
            # Look for paragraph break
            newline_pos = content.rfind("\n\n", start + chunk_size // 2, end + overlap)
            if newline_pos > start:
                end = newline_pos + 2
            else:
                # Look for sentence break
                period_pos = content.rfind(". ", start + chunk_size // 2, end + overlap)
                if period_pos > start:
                    end = period_pos + 2

        chunks.append(content[start:end].strip())
        start = max(start + 1, end - overlap)

    return [c for c in chunks if c]
