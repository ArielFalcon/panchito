export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Falta variable de entorno: ${key}`);
  return v;
}
