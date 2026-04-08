"""
OpenFS Embedding Server
Runs all-MiniLM-L6-v2 locally via sentence-transformers.
384-dim cosine embeddings — fast, no API key, runs on CPU.

POST /embed   { "texts": ["..."] }   → { "embeddings": [[...]] }
GET  /health                         → { "ok": true, "model": "..." }
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import uvicorn
import os

MODEL_NAME = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")

app = FastAPI(title="OpenFS Embedding Server")

# Load model at startup — cached in /models volume across restarts
print(f"[embed] Loading model: {MODEL_NAME}")
model = SentenceTransformer(MODEL_NAME, cache_folder="/models")
print(f"[embed] Model ready. Dim={model.get_sentence_embedding_dimension()}")


class EmbedRequest(BaseModel):
    texts: list[str]
    # Optional: normalize to unit vectors for cosine similarity
    normalize: bool = True


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    model: str
    dim: int


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_NAME,
        "dim": model.get_sentence_embedding_dimension(),
    }


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest):
    if not req.texts:
        raise HTTPException(status_code=400, detail="texts cannot be empty")
    if len(req.texts) > 512:
        raise HTTPException(status_code=400, detail="max 512 texts per request")

    vecs = model.encode(
        req.texts,
        normalize_embeddings=req.normalize,
        show_progress_bar=False,
    )

    return EmbedResponse(
        embeddings=vecs.tolist(),
        model=MODEL_NAME,
        dim=vecs.shape[1],
    )


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8001"))
    uvicorn.run(app, host="0.0.0.0", port=port)
