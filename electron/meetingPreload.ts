import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('meetingAPI', {
  onBotSpeak: (callback: (pcmData: Float32Array) => void) => {
    const subscription = (event: IpcRendererEvent, pcmData: Float32Array) => callback(pcmData);
    ipcRenderer.on('bot-speak', subscription);
    return () => ipcRenderer.removeListener('bot-speak', subscription);
  },
  sendActiveSpeaker: (name: string) => {
    ipcRenderer.send('active-speaker', name);
  }
});