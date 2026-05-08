export class GraphCycleError extends Error {
  constructor(message = "dependency graph has a cycle") {
    super(message);
    this.name = "GraphCycleError";
  }
}

export function topologicalSort(
  ids: string[],
  dependenciesOf: (id: string) => readonly string[],
): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const sorted: string[] = [];

  function visit(id: string, stack: string[]): void {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart), id].join(" -> ");
      throw new GraphCycleError(`dependency graph has a cycle: ${cycle}`);
    }

    visiting.add(id);
    for (const dependency of dependenciesOf(id)) {
      visit(dependency, [...stack, id]);
    }
    visiting.delete(id);
    visited.add(id);
    sorted.push(id);
  }

  for (const id of ids) {
    visit(id, []);
  }

  return sorted;
}
