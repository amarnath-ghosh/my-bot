import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// Expose a minimal API for the content script to listen for the bot's audio
contextBridge.exposeInMainWorld('meetingAPI', {
  /**
   * Listens for the 'bot-speak' event from the main process and passes
   * the audio data (Float32Array) to the callback.
   */
  onBotSpeak: (callback: (pcmData: Float32Array) => void) => {
    const subscription = (event: IpcRendererEvent, pcmData: Float32Array) => 
      callback(pcmData);
    
    ipcRenderer.on('bot-speak', subscription);
    
    // Return a function to remove the listener
    return () => {
      ipcRenderer.removeListener('bot-speak', subscription);
    };
  },
});