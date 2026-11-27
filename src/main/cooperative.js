// Long CPU work in the main process freezes the whole window: it stops answering clicks, including
// minimize. These helpers split such work into short slices and give the event loop back in between.

const SLICE_MS = 12

export function abortError() {
  const error = new Error('Preparação cancelada.')
  error.name = 'AbortError'
  return error
}

/**
 * Returns a function to call often inside a long loop. It yields to the event loop once the current
 * slice has run for a few milliseconds, and stops the work when the signal is aborted.
 */
export function createYielder(signal) {
  let sliceStart = performance.now()
  return async function maybeYield() {
    if (signal?.aborted) throw abortError()
    if (performance.now() - sliceStart < SLICE_MS) return
    await new Promise((resolve) => setImmediate(resolve))
    sliceStart = performance.now()
    if (signal?.aborted) throw abortError()
  }
}
