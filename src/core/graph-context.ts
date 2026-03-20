/**
 * graph-context.ts — Local knowledge graph context injection
 *
 * Searches the in-memory knowledge graph for entities matching the user's
 * message and returns a context block to prepend. This avoids relying on
 * Copilot to pick the right MCP tool.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('graph-context');

interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

interface Relation {
  from: string;
  to: string;
  relationType: string;
}

interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

let cachedGraph: KnowledgeGraph | null = null;
let lastLoadTime = 0;
const RELOAD_INTERVAL_MS = 60_000; // reload every 60s

function loadGraph(graphPath: string): KnowledgeGraph | null {
  try {
    if (!fs.existsSync(graphPath)) return null;
    const stat = fs.statSync(graphPath);
    if (cachedGraph && Date.now() - lastLoadTime < RELOAD_INTERVAL_MS) return cachedGraph;
    const raw = fs.readFileSync(graphPath, 'utf8');
    cachedGraph = JSON.parse(raw) as KnowledgeGraph;
    lastLoadTime = Date.now();
    return cachedGraph;
  } catch (err) {
    log.error('Failed to load knowledge graph:', err);
    return null;
  }
}

/**
 * Search the graph for entities matching any word/phrase in the query.
 * Returns related entities (via relations) as well.
 */
function searchGraph(graph: KnowledgeGraph, query: string): { entities: Entity[]; relations: Relation[] } {
  const q = query.toLowerCase();
  const matchedNames = new Set<string>();

  // Direct name match (substring)
  for (const e of graph.entities) {
    const nameLower = e.name.toLowerCase();
    if (q.includes(nameLower) || nameLower.includes(q)) {
      matchedNames.add(e.name);
    }
  }

  // Also try individual significant words (3+ chars, skip stop words)
  const stopWords = new Set(['who', 'what', 'the', 'does', 'cover', 'covers', 'for', 'and', 'are', 'has', 'have', 'with', 'about', 'tell', 'show', 'list', 'give', 'get']);
  const words = q.split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));
  for (const word of words) {
    for (const e of graph.entities) {
      if (e.name.toLowerCase().includes(word)) {
        matchedNames.add(e.name);
      }
    }
  }

  if (matchedNames.size === 0) return { entities: [], relations: [] };

  // Get related entities (1 hop)
  const relatedNames = new Set<string>();
  const matchedRelations: Relation[] = [];
  for (const r of graph.relations) {
    if (matchedNames.has(r.from)) {
      relatedNames.add(r.to);
      matchedRelations.push(r);
    }
    if (matchedNames.has(r.to)) {
      relatedNames.add(r.from);
      matchedRelations.push(r);
    }
  }

  // Combine matched + related entity objects
  const allNames = new Set([...Array.from(matchedNames), ...Array.from(relatedNames)]);
  const entities = graph.entities.filter(e => allNames.has(e.name));

  // Cap to avoid enormous context
  const MAX_ENTITIES = 30;
  const MAX_RELATIONS = 50;

  return {
    entities: entities.slice(0, MAX_ENTITIES),
    relations: matchedRelations.slice(0, MAX_RELATIONS),
  };
}

function formatContext(results: { entities: Entity[]; relations: Relation[] }): string {
  if (results.entities.length === 0) return '';

  const lines: string[] = ['[Knowledge Graph Context — use this data to answer the question]', ''];

  for (const e of results.entities) {
    lines.push(`## ${e.name} (${e.entityType})`);
    for (const obs of e.observations) {
      lines.push(`- ${obs}`);
    }
    lines.push('');
  }

  if (results.relations.length > 0) {
    lines.push('## Relationships');
    for (const r of results.relations) {
      lines.push(`- ${r.from} —[${r.relationType}]→ ${r.to}`);
    }
  }

  return lines.join('\n');
}

/**
 * Given a user message, search the knowledge graph and return context to prepend.
 * Returns empty string if no matches found.
 */
export function getGraphContext(graphPath: string, userMessage: string): string {
  const graph = loadGraph(graphPath);
  if (!graph) return '';

  const results = searchGraph(graph, userMessage);
  if (results.entities.length === 0) return '';

  log.info(`Graph context: found ${results.entities.length} entities, ${results.relations.length} relations`);
  return formatContext(results);
}
