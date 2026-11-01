import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
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
  prepareKnowledgeSources: (data) => ipcRenderer.invoke('prepare-knowledge-sources', data),
  getSavedMeetings: () => ipcRenderer.invoke('get-saved-meetings'),
  toggleAudioSource: (source) => ipcRenderer.send('toggle-audio-source', source),
  onAudioLevel: (cb) => ipcRenderer.on('audio-level', (_e, val) => cb(val)),
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
