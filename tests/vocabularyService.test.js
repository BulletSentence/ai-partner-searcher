import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildVocabulary,
  correctWithVocabulary,
  getLearnedTerms,
  phoneticKey,
  resetVocabulary,
  selectPromptTerms
} from '../src/main/vocabularyService.js'
import {
  configureTerminology,
  correctTerminology,
  formatTerminology,
  parseTerminologyText
} from '../src/main/terminologyService.js'

const notes = [
  'A proposta foi enviada para a Paketá ontem. O lote da Paketá entrou, e a Paketá confirmou.',
  'Falamos com a Paketá e com a Kanastra sobre o pacote de contratos.',
  'O arquivo da Dataprev chegou; a Dataprev devolveu o retorno e a Dataprev aprovou.',
  'O pacote foi pago. Cada pacote tem um contrato, e o pacote segue para a Kanastra e a Kanastra.',
  '# Resumo\nResumo da reunião. Definições Gerais do Produto.',
  '```sql\nselect * from x where a Join b Join c Join d\n```',
  'Siglas como FIDC e FIDC e FIDC aparecem, e o FIDC também.'
].map((content, index) => ({ path: `/vault/nota-${index}.md`, content }))

function learn() {
  resetVocabulary()
  return buildVocabulary(notes)
}

test('sounds that Whisper spells differently share one phonetic key', () => {
  assert.equal(phoneticKey('Paketá'), phoneticKey('Paquetá'))
  assert.equal(phoneticKey('Kanastra'), phoneticKey('Canastra'))
  assert.equal(phoneticKey('Rubicon'), phoneticKey('Rubicom'))
  assert.notEqual(phoneticKey('Paketá'), phoneticKey('pacote'))
})

test('learns proper names from notes, not headings, acronyms or code', () => {
  learn()
  const terms = getLearnedTerms().map(({ term }) => term)
  assert.ok(terms.includes('Paketá'))
  assert.ok(terms.includes('Dataprev'))
  assert.ok(terms.includes('Kanastra'))
  for (const noise of ['Resumo', 'Definições', 'Join', 'Fidc', 'FIDC', 'Pacote']) {
    assert.ok(!terms.includes(noise), `${noise} should not be learned`)
  }
})

test('repairs misheard names and leaves ordinary words alone', () => {
  learn()
  assert.equal(
    correctWithVocabulary('Falei com a Paquetá sobre o pacote'),
    'Falei com a Paketá sobre o pacote'
  )
  assert.equal(correctWithVocabulary('a paketa e a Canastra'), 'a Paketá e a Kanastra')
  assert.equal(correctWithVocabulary('o retorno da data prev'), 'o retorno da Dataprev')
  assert.equal(correctWithVocabulary('Resumo do contrato'), 'Resumo do contrato')
})

test('terms typed in the glossary win and are matched by sound too', () => {
  learn()
  configureTerminology(parseTerminologyText('Rubicon: rubicom dois\n# comentário\nCredifit'))
  assert.equal(correctTerminology('o rubicom e a credifiti'), 'o Rubicon e a Credifit')
  configureTerminology([])
})

test('prompt terms prefer names from notes related to the meeting', () => {
  learn()
  const terms = selectPromptTerms({ relatedText: 'Kanastra Kanastra', exclude: ['Dataprev'] })
  assert.equal(terms[0], 'Kanastra')
  assert.ok(terms.includes('Paketá'))
  assert.ok(!terms.includes('Dataprev'))
})

test('glossary text round-trips between the screen and the entries', () => {
  const entries = parseTerminologyText('Paketá: paqueta, paceta\nFIDC\n\n# nota')
  assert.deepEqual(entries, [
    { canonical: 'Paketá', aliases: ['paqueta', 'paceta'] },
    { canonical: 'FIDC', aliases: [] }
  ])
  assert.equal(
    formatTerminology([{ canonical: 'Paketá', aliases: ['paketá', 'paqueta'] }]),
    'Paketá: paqueta'
  )
})
