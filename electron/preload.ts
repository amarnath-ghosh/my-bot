import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { ElectronAPI, BotStatus } from '../lib/types';

// Define the API for the Dashboard
const electronAPI: ElectronAPI & { onActiveSpeakerChange: (cb: (name: string) => void) => void } = {
  joinMeeting: (url: string) => ipcRenderer.invoke('join-meeting', url),
  
  getSources: () => ipcRenderer.invoke('get-sources'),
  
  closeMeeting: (id?: string) => ipcRenderer.invoke('close-meeting', id),
  
  onTranscriptUpdate: (callback) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on('transcript-update', subscription);
  },
  
  removeTranscriptListener: () => {
    ipcRenderer.removeAllListeners('transcript-update');
  },
  
  sendBotAudio: (pcmData: Float32Array) => {
    ipcRenderer.send('bot-speak-data', pcmData);
  },
  
  onBotJoined: (callback) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on('bot-joined', subscription);
  },
  
  onBotLeft: (callback) => {
    const subscription = (_: any, id: string) => callback(id);
    ipcRenderer.on('bot-left', subscription);
  },
  
  getActiveBots: () => ipcRenderer.invoke('get-active-bots'),
  
  // --- NEW: Receive Active Speaker Name from Main Process ---
  onActiveSpeakerChange: (callback) => {
    ipcRenderer.on('active-speaker-update', (_, name) => callback(name));
  }
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);