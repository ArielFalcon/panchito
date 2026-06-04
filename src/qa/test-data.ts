// Higiene de datos de test contra la DB real de DEV. En vez de DB efímera,
// namespacing por SHA: toda entidad creada lleva el prefijo qa-bot-<sha7>,
// identificable y limpiable. Funciones puras (verificables sin red).

export function testDataNamespace(prefix: string, sha: string): string {
  return `${prefix}-${sha.slice(0, 7)}`;
}

export function isOwnedByRun(value: string, prefix: string, sha: string): boolean {
  return value.startsWith(testDataNamespace(prefix, sha));
}
