/**
 * Knowledge graph extraction layer.
 *
 * Uses the LLM to extract entities and relationships from document chunks,
 * then builds a graph that maps how topics connect across the entire corpus.
 *
 * Graph is stored as JSON files in OpenFS at:
 *   /kg/entities/<id>.json
 *   /kg/relationships/<id>.json
 *   /kg/clusters/<topic>.json
 *   /kg/index.json  — full graph summary
 */

import type { KgEntity, KgRelationship, KnowledgeGraph, SemanticResult } from "./types.js";

export interface LlmAdapter {
  complete(system: string, prompt: string, opts?: { maxTokens?: number }): Promise<string>;
}

const EXTRACT_SYSTEM = `You are a knowledge graph extractor. Given text chunks from a document corpus, extract:
1. Named entities: people, organizations, technologies, concepts, events, places
2. Relationships between entities
3. Topic clusters

Respond ONLY with valid JSON matching this schema:
{
  "entities": [{ "id": "slug-id", "name": "Full Name", "type": "person|organization|concept|technology|event|place", "description": "one sentence" }],
  "relationships": [{ "fromId": "slug-id", "toId": "slug-id", "type": "relates_to|depends_on|part_of|created_by|used_by|competes_with", "description": "brief" }],
  "cluster": "main topic name"
}`;

export class KnowledgeGraphBuilder {
  constructor(private llm: LlmAdapter) {}

  /**
   * Extract entities and relationships from a batch of search results.
   * Called after semantic retrieval to build the graph incrementally.
   */
  async extractFromChunks(
    chunks: SemanticResult[],
    topic: string,
  ): Promise<{ entities: KgEntity[]; relationships: KgRelationship[] }> {
    // Take top chunks to keep LLM prompt manageable
    const text = chunks
      .slice(0, 8)
      .map(c => `[Source: ${c.title}]\n${c.content}`)
      .join("\n\n---\n\n")
      .slice(0, 6000);

    let raw: string;
    try {
      raw = await this.llm.complete(EXTRACT_SYSTEM, `Topic: ${topic}\n\nText:\n${text}`, {
        maxTokens: 1500,
      });
    } catch {
      return { entities: [], relationships: [] };
    }

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { entities: [], relationships: [] };
      const parsed = JSON.parse(jsonMatch[0]);

      const sources = chunks.map(c => c.source);
      const entities: KgEntity[] = (parsed.entities ?? []).map((e: any) => ({
        id: e.id ?? slugify(e.name),
        name: e.name,
        type: e.type ?? "concept",
        sources,
        description: e.description,
      }));

      const relationships: KgRelationship[] = (parsed.relationships ?? []).map((r: any) => ({
        fromId: r.fromId,
        toId: r.toId,
        type: r.type ?? "relates_to",
        source: chunks[0]?.source ?? topic,
      }));

      return { entities, relationships };
    } catch {
      return { entities: [], relationships: [] };
    }
  }

  /**
   * Merge incremental extractions into a full KnowledgeGraph,
   * deduplicating entities by ID and merging their source lists.
   */
  mergeGraph(
    existing: KnowledgeGraph,
    newEntities: KgEntity[],
    newRelationships: KgRelationship[],
    topic: string,
  ): KnowledgeGraph {
    const entityMap = new Map<string, KgEntity>(
      existing.entities.map(e => [e.id, e]),
    );

    for (const e of newEntities) {
      const current = entityMap.get(e.id);
      if (current) {
        // Merge sources
        current.sources = [...new Set([...current.sources, ...e.sources])];
        if (!current.description && e.description) current.description = e.description;
      } else {
        entityMap.set(e.id, e);
      }
    }

    // Deduplicate relationships by from+to+type
    const relKey = (r: KgRelationship) => `${r.fromId}→${r.toId}:${r.type}`;
    const relMap = new Map<string, KgRelationship>(
      existing.relationships.map(r => [relKey(r), r]),
    );
    for (const r of newRelationships) {
      if (entityMap.has(r.fromId) && entityMap.has(r.toId)) {
        relMap.set(relKey(r), r);
      }
    }

    const clusters = { ...existing.clusters };
    const entityIds = newEntities.map(e => e.id);
    clusters[topic] = [...new Set([...(clusters[topic] ?? []), ...entityIds])];

    return {
      entities: [...entityMap.values()],
      relationships: [...relMap.values()],
      clusters,
      builtAt: new Date().toISOString(),
    };
  }

  /**
   * Serialize the knowledge graph into OpenFS-friendly markdown files.
   * Returns a record of path → content to ingest into the WASM FS.
   */
  graphToFiles(graph: KnowledgeGraph): Record<string, string> {
    const files: Record<string, string> = {};

    // Master index
    files["/kg/index.json"] = JSON.stringify(
      {
        entityCount: graph.entities.length,
        relationshipCount: graph.relationships.length,
        clusters: Object.fromEntries(
          Object.entries(graph.clusters).map(([k, ids]) => [k, ids.length]),
        ),
        builtAt: graph.builtAt,
      },
      null,
      2,
    );

    // Per-entity files as markdown (wiki-readable)
    for (const entity of graph.entities) {
      const related = graph.relationships
        .filter(r => r.fromId === entity.id || r.toId === entity.id)
        .map(r => {
          const otherId = r.fromId === entity.id ? r.toId : r.fromId;
          const other = graph.entities.find(e => e.id === otherId);
          return `- **${r.type}**: ${other?.name ?? otherId}`;
        })
        .join("\n");

      const content = [
        `# ${entity.name}`,
        ``,
        `**Type**: ${entity.type}`,
        entity.description ? `\n${entity.description}` : "",
        entity.sources.length ? `\n**Sources**: ${entity.sources.join(", ")}` : "",
        related ? `\n## Relationships\n\n${related}` : "",
      ]
        .join("\n")
        .trim();

      files[`/kg/entities/${entity.id}.md`] = content;
    }

    // Per-cluster summary
    for (const [topic, entityIds] of Object.entries(graph.clusters)) {
      const members = entityIds
        .map(id => graph.entities.find(e => e.id === id))
        .filter(Boolean) as KgEntity[];

      const content = [
        `# Knowledge Cluster: ${topic}`,
        ``,
        `${members.length} entities in this cluster.`,
        ``,
        `## Entities`,
        members.map(e => `- **${e.name}** (${e.type}): ${e.description ?? ""}`).join("\n"),
      ].join("\n");

      files[`/kg/clusters/${slugify(topic)}.md`] = content;
    }

    return files;
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-]/g, "");
}
