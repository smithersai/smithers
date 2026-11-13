import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const require = createRequire(new URL('../../../../../../package.json', import.meta.url))
const { build } = require('esbuild')
const dir = mkdtempSync(join(tmpdir(), 'repo-doc-blocks-'))
try {
 const out = join(dir, 'document.mjs')
 await build({ entryPoints: [fileURLToPath(new URL('./document.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' })
 const { documentBlocks } = await import(pathToFileURL(out).href)
 const code = source => documentBlocks(source).filter(b => b.kind === 'code')
 assert.deepEqual(code('> For agents\n>\n> ```text\n> Set up Effeck in this project.\n> ```\n> Continue here.'), [{kind:'code',lang:'text',text:'Set up Effeck in this project.'}])
 assert.deepEqual(code('> > ~~~ts\n> > const n = 1\n> > ~~~'), [{kind:'code',lang:'ts',text:'const n = 1'}])
 assert.deepEqual(code('````markdown\n```ts\nconst n = 1\n```\n````'), [{kind:'code',lang:'markdown',text:'```ts\nconst n = 1\n```'}])
 assert.deepEqual(code('```ts\n> comparison\n```'), [{kind:'code',lang:'ts',text:'> comparison'}])
 const blocks = documentBlocks('> ```text\n> command\n> ```\n\n## Next')
 assert.equal(blocks.at(-1).text, 'Next')
 const headings = names => documentBlocks(names.map(name => '## ' + name).join('\n')).filter(b => b.kind === 'heading').map(b => b.id)
 for (const [names, expected] of [
   [['Foo', 'Foo', 'Foo-1'], ['foo', 'foo-1', 'foo-1-1']],
   [['Foo-1', 'Foo', 'Foo'], ['foo-1', 'foo', 'foo-2']],
   [['Foo', 'Foo-1', 'Foo', 'Foo-2', 'Foo'], ['foo', 'foo-1', 'foo-2', 'foo-2-1', 'foo-3']],
   [['!!!', 'section', 'section-1', '???'], ['section', 'section-1', 'section-1-1', 'section-2']],
   [['**Foo**', '[Foo](link)', 'FOO-1'], ['foo', 'foo-1', 'foo-1-1']]
 ]) assert.deepEqual(headings(names), expected, names.join(', '))
 // All orderings of an explicit suffix, duplicates, and a nested suffix remain independently linkable.
 const permutations = values => values.length ? values.flatMap((value, i) => permutations(values.filter((_, j) => j !== i)).map(rest => [value, ...rest])) : [[]]
 for (const names of permutations(['Foo', 'Foo', 'Foo-1', 'Foo-1-1', 'Foo-2'])) {
   const ids = headings(names)
   assert.equal(new Set(ids).size, names.length, names.join(', '))
   assert.deepEqual(headings(names), ids, 'IDs remain stable across renders')
 }
 console.log('PASS docs document: quoted/nested fences, longer delimiters, code bytes, following heading')
} finally { rmSync(dir, {recursive:true,force:true}) }
