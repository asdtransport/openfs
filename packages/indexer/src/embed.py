"""
Optional embedding module for Chroma adapter.
Requires: pip install sentence-transformers

Community contribution welcome!
"""
def embed_chunks(chunks: list[str], model_name: str = "all-MiniLM-L6-v2") -> list[list[float]]:
    raise NotImplementedError("Embedding module not yet implemented — install openfs-indexer[embedding]")
