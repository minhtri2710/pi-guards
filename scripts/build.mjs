// Emits dist/*.js from the TypeScript sources with Node's own type stripping, since Node does not strip types under node_modules.
import { stripTypeScriptTypes } from "node:module";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function build(root, out = join(root, "dist")) {
  await mkdir(out, { recursive: true });
  const sources = (await readdir(root)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  for (const name of sources) {
    const js = stripTypeScriptTypes(await readFile(join(root, name), "utf8"), { mode: "strip" }).replace(/(from\s+"\.\/[^"]+)\.ts"/g, '$1.js"');
    await writeFile(join(out, name.replace(/\.ts$/, ".js")), js);
  }
  return sources;
}

if (import.meta.url === `file://${process.argv[1]}`) await build(join(import.meta.dirname, ".."));
