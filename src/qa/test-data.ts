// Higiene de datos de test contra la DB real de DEV. En vez de DB efímera,
// namespacing por SHA: toda entidad creada lleva el prefijo qa-bot-<sha7>,
// identificable y limpiable (cada test la borra en su teardown). Funciones
// puras (verificables sin red).

// SHA corto (7) — formato canónico para ramas, namespaces y títulos.
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function testDataNamespace(prefix: string, sha: string): string {
  return `${prefix}-${shortSha(sha)}`;
}
