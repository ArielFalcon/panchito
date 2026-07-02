// service-topology/infrastructure/glob-suffix.ts
// Compiles profile.frontFiles (a "**/*.<ext>" glob, e.g. "**/*.api.ts") into a filename
// predicate. The directory walk already recurses, so the core only needs the filename-suffix
// shape of the glob, not a full glob engine — but the compiler is generic over the extension,
// so any app's egress-file naming convention plugs in without a code change.

/** Compile a "**\/*.<ext>" glob into a predicate over a bare filename (no directory segments
 *  required — callers pass the entry name from their own directory walk). Only two shapes are
 *  supported, because the walk already recurses and only ever hands this predicate a bare
 *  filename — a directory-structured glob (e.g. "**\/api/*.ts") is not expressible against a
 *  filename alone:
 *    - "**\/*.<ext>" — filename-suffix, ignoring the recursive-directory prefix.
 *    - "*.<ext>"     — filename-suffix, no directory prefix.
 *  Any other shape (a wildcard not immediately preceded by "**\/" or a bare "*.", e.g.
 *  "**\/api/*.ts" or "order*.ts") is UNSUPPORTED: it warns loudly and fails CLOSED (the
 *  predicate matches nothing) rather than silently degrading to a substring-suffix match that
 *  could match every file sharing the trailing extension. */
export function compileFileGlob(glob: string): (filename: string) => boolean {
  const match = /^(?:\*\*\/)?\*(\.[^*/]+)$/.exec(glob);
  if (!match) {
    console.warn(
      `[compileFileGlob] unsupported frontFiles glob "${glob}" — only "**/*.<ext>" or "*.<ext>" ` +
        `(filename-suffix) shapes are supported. Failing closed: this predicate will match no files.`,
    );
    return (): boolean => false;
  }
  const suffix = match[1] as string;
  return (filename: string): boolean => filename.endsWith(suffix);
}
