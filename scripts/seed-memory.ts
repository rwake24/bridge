#!/usr/bin/env tsx
/**
 * bridge seed-memory — Seed the knowledge graph with account data.
 *
 * Reads account data from:
 *   - accounts-sync.json (Arc motion data)
 *   - account_alignment.json (AE/SSE/SSP assignments)
 *   - corrections.md (accumulated corrections)
 *
 * Writes entities + relations to a memory-graph.json file.
 *
 * Usage:
 *   npx tsx scripts/seed-memory.ts --accounts <path> --alignment <path> --output <path>
 *   bridge seed-memory  (uses defaults from config)
 */

import fs from 'fs';
import path from 'path';

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

function parseArgs(): { accounts?: string; alignment?: string; corrections?: string; output: string } {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1]) {
      parsed[args[i].slice(2)] = args[++i];
    }
  }
  return {
    accounts: parsed.accounts,
    alignment: parsed.alignment,
    corrections: parsed.corrections,
    output: parsed.output || 'memory-graph.json',
  };
}

function loadJson(filePath: string): any[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err: any) {
    console.warn(`⚠ Could not load ${filePath}: ${err.message}`);
    return [];
  }
}

function seedAccounts(data: any[]): { entities: Entity[]; relations: Relation[] } {
  const entities: Entity[] = [];
  const relations: Relation[] = [];

  for (const row of data) {
    const name = row['Account Name'] || row['accountName'] || row['name'];
    if (!name) continue;

    const observations: string[] = [];
    // Capture all fields as observations
    for (const [key, value] of Object.entries(row)) {
      if (key === 'Account Name' || key === 'accountName' || key === 'name') continue;
      if (value !== null && value !== undefined && value !== '') {
        observations.push(`${key}: ${value}`);
      }
    }

    entities.push({ name, entityType: 'Account', observations });
  }

  return { entities, relations };
}

function seedAlignment(data: any[]): { entities: Entity[]; relations: Relation[] } {
  const entities: Entity[] = [];
  const relations: Relation[] = [];
  const peopleSet = new Map<string, Entity>();

  for (const row of data) {
    const account = row['Account Name'] || row['accountName'] || row['Account'];
    if (!account) continue;

    // Extract people fields (AE, SSP, SSE, etc.)
    const roleFields = ['AE', 'SSP', 'SSE', 'SE', 'CSA', 'Security SSP'];
    for (const role of roleFields) {
      const person = row[role];
      if (!person || person === 'N/A' || person === '') continue;

      // Create or update person entity
      if (!peopleSet.has(person)) {
        peopleSet.set(person, { name: person, entityType: 'Person', observations: [`Role: ${role}`] });
      } else {
        const existing = peopleSet.get(person)!;
        const roleObs = `Role: ${role}`;
        if (!existing.observations.includes(roleObs)) {
          existing.observations.push(roleObs);
        }
      }

      relations.push({ from: person, to: account, relationType: `${role}_covers` });
    }
  }

  entities.push(...peopleSet.values());
  return { entities, relations };
}

function seedCorrections(filePath: string): { entities: Entity[]; relations: Relation[] } {
  const entities: Entity[] = [];
  const relations: Relation[] = [];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));

    for (const line of lines) {
      // Try to extract entity corrections like "X does NOT cover Y"
      const notCoverMatch = line.match(/(\S+)\s+does\s+(?:NOT|not)\s+cover\s+(.+)/i);
      if (notCoverMatch) {
        const [, person, account] = notCoverMatch;
        entities.push({
          name: person.trim(),
          entityType: 'Person',
          observations: [`Does NOT cover ${account.trim()}`],
        });
        continue;
      }

      // Generic correction — store as observation on a "Corrections" entity
      entities.push({
        name: 'Corrections',
        entityType: 'System',
        observations: [line.trim()],
      });
    }
  } catch {
    // No corrections file — that's fine
  }

  return { entities, relations };
}

function mergeGraphs(...graphs: { entities: Entity[]; relations: Relation[] }[]): KnowledgeGraph {
  const entityMap = new Map<string, Entity>();
  const allRelations: Relation[] = [];

  for (const graph of graphs) {
    for (const entity of graph.entities) {
      const existing = entityMap.get(entity.name);
      if (existing) {
        // Merge observations
        for (const obs of entity.observations) {
          if (!existing.observations.includes(obs)) {
            existing.observations.push(obs);
          }
        }
      } else {
        entityMap.set(entity.name, { ...entity, observations: [...entity.observations] });
      }
    }
    allRelations.push(...graph.relations);
  }

  // Deduplicate relations
  const relSet = new Set<string>();
  const uniqueRelations = allRelations.filter(r => {
    const key = `${r.from}|${r.relationType}|${r.to}`;
    if (relSet.has(key)) return false;
    relSet.add(key);
    return true;
  });

  return { entities: [...entityMap.values()], relations: uniqueRelations };
}

// --- Main ---
const args = parseArgs();
console.log('🧠 Bridge Memory Seed');
console.log('=====================\n');

const graphs: { entities: Entity[]; relations: Relation[] }[] = [];

if (args.accounts) {
  console.log(`📊 Loading accounts from ${args.accounts}`);
  const data = loadJson(args.accounts);
  console.log(`   Found ${data.length} account records`);
  graphs.push(seedAccounts(data));
}

if (args.alignment) {
  console.log(`👥 Loading alignment from ${args.alignment}`);
  const data = loadJson(args.alignment);
  console.log(`   Found ${data.length} alignment records`);
  graphs.push(seedAlignment(data));
}

if (args.corrections) {
  console.log(`✏️  Loading corrections from ${args.corrections}`);
  graphs.push(seedCorrections(args.corrections));
}

if (graphs.length === 0) {
  console.log('No data sources provided. Usage:');
  console.log('  bridge seed-memory --accounts <path> --alignment <path> [--corrections <path>] [--output <path>]');
  process.exit(1);
}

const merged = mergeGraphs(...graphs);
console.log(`\n📦 Merged graph:`);
console.log(`   ${merged.entities.length} entities`);
console.log(`   ${merged.relations.length} relations`);

// Write output
const outputPath = path.resolve(args.output);
fs.writeFileSync(outputPath, JSON.stringify(merged, null, 2));
console.log(`\n✅ Written to ${outputPath}`);
