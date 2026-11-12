import { readFile, stat, writeFile } from 'fs/promises'
import { basename, join, resolve, relative, isAbsolute } from 'path'

export async function exportFinalTranscript({ meetingsDirectory, folder, destination }) {
  const child = relative(resolve(meetingsDirectory), resolve(folder || '.'))
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Reunião inválida.')
  if (!destination) throw new Error('Selecione a pasta de destino do Harness na configuração.')
  const summary = JSON.parse(await readFile(join(folder, 'reuniao.json'), 'utf8'))
  if (!Array.isArray(summary.finalTranscript)) throw new Error('A transcrição final ainda não está pronta.')
  const markdown = await readFile(join(folder, 'transcricao-final.md'), 'utf8')
  let target = resolve(destination)
  if (basename(target) !== 'HARNESS') {
    try {
      if ((await stat(join(target, 'HARNESS'))).isDirectory()) target = join(target, 'HARNESS')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (!(await stat(target)).isDirectory()) throw new Error('O destino precisa ser uma pasta.')
  const name = String(summary.meeting?.context || basename(folder))
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '-').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Reunião'
  const suffix = ' - transcricao final'
  for (let index = 0; index < 1000; index += 1) {
    const path = join(target, `${name}${suffix}${index ? ` (${index + 1})` : ''}.md`)
    try {
      await writeFile(path, markdown, { flag: 'wx' })
      return path
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  throw new Error('Não foi possível escolher um nome livre para o arquivo.')
}
