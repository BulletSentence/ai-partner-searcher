import { app, safeStorage } from 'electron'
import { join } from 'path'
import { createProviderStore } from './providerStore.js'

// The API keys live in their own file, encrypted with the system keychain (Keychain on macOS,
// DPAPI on Windows, libsecret on Linux). They are never read from .env and never sent to the screen.
let store = null

function getStore() {
  if (!store) {
    store = createProviderStore({
      filePath: join(app.getPath('userData'), 'ai-providers.bin'),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (buffer) => safeStorage.decryptString(buffer),
      isAvailable: () => safeStorage.isEncryptionAvailable()
    })
  }
  return store
}

export const getProviderState = () => getStore().getPublicState()
export const addProviderKey = (key) => getStore().addKey(key)
export const removeProvider = (id) => getStore().removeProvider(id)
export const selectAgentModel = (id, model) => getStore().selectModel(id, model)
export const refreshProviderModels = (id) => getStore().refreshModels(id)
export const configureOllama = (options) => getStore().configureOllama(options)
export const getAgentPlan = () => getStore().getAgentPlan()
