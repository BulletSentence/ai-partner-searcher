import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  isMac: process.platform === 'darwin',
  onTranscription: (callback) => ipcRenderer.on('on-transcription', (_event, value) => callback(value)),
  onAiAnswer: (callback) => ipcRenderer.on('on-ai-answer', (_event, value) => callback(value)),
  onAiAnswerStart: (callback) => ipcRenderer.on('on-ai-answer-start', (_event, value) => callback(value)),
  onAiAnswerDelta: (callback) => ipcRenderer.on('on-ai-answer-delta', (_event, value) => callback(value)),
  onAiAnswerStatus: (callback) => ipcRenderer.on('on-ai-answer-status', (_event, value) => callback(value)),
  startMeeting: (data) => ipcRenderer.send('start-meeting', data),
  stopMeeting: () => ipcRenderer.send('stop-meeting'),
  askMeetingQuestion: (question) => ipcRenderer.send('ask-meeting-question', question),
  retryLastMeetingQuestion: () => ipcRenderer.send('retry-last-meeting-question'),
  setKnowledgeSourceFilter: (source) => ipcRenderer.send('set-knowledge-source-filter', source),
  minimize: () => ipcRenderer.send('minimize-window'),
  close: () => ipcRenderer.send('close-window'),
  onWindowLockChange: (cb) => ipcRenderer.on('window-unlocked', (_e, val) => cb(val)),
  getDefaultMeetingProfile: () => ipcRenderer.invoke('get-default-meeting-profile'),
  getMeetingSettings: () => ipcRenderer.invoke('get-meeting-settings'),
  saveMeetingSettings: (settings) => ipcRenderer.invoke('save-meeting-settings', settings),
  getAudioOutputs: () => ipcRenderer.invoke('get-audio-outputs'),
  getTranscriptionModels: () => ipcRenderer.invoke('get-transcription-models'),
  getTranscriberStatus: () => ipcRenderer.invoke('get-transcriber-status'),
  selectFolders: (multiple = false) => ipcRenderer.invoke('select-folders', { multiple }),
  prepareKnowledgeSources: (data) => ipcRenderer.invoke('prepare-knowledge-sources', data),
  getSavedMeetings: () => ipcRenderer.invoke('get-saved-meetings'),
  toggleAudioSource: (source) => ipcRenderer.send('toggle-audio-source', source),
  onAudioLevel: (cb) => ipcRenderer.on('audio-level', (_e, val) => cb(val)),
  onNativeAudioCaptureStart: (cb) => ipcRenderer.on('start-native-audio-capture', () => cb()),
  onNativeAudioCaptureStop: (cb) => ipcRenderer.on('stop-native-audio-capture', () => cb()),
  sendNativeAudioChunk: (chunk) => ipcRenderer.send('native-audio-chunk', chunk),
  reportNativeAudioError: (message) => ipcRenderer.send('native-audio-capture-error', message),
  setWindowInteractive: () => ipcRenderer.send('set-window-interactive'),
  setWindowClickthrough: () => ipcRenderer.send('set-window-clickthrough'),
  maximize: () => ipcRenderer.send('maximize-window')
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
