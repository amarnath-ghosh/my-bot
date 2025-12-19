import { contextBridge, ipcRenderer, IpcRendererEvent, webFrame } from 'electron';

// 1. Inject the WebRTC patch immediately into the main world
// This ensures we capture the streams even if the content script is slow
const patchScript = `
  console.log("[Bot-Preload] ⚡ Injecting WebRTC Patch...");
  
  if (!window.RTCPeerConnection) {
    console.error("[Bot-Preload] RTCPeerConnection not found!");
  } else {
    const NativeRTCPeerConnection = window.RTCPeerConnection;
    
    // We need to expose this so the content script can find it if needed, 
    // or we just handle the "track" event here if we could, 
    // but the AudioContext logic needs to be in the main world.
    // So we patch it here to ensure NO events are missed.
    
    // Global buffer for tracks in case content script loads late
    window.__BOT_TRACKS = window.__BOT_TRACKS || [];

    class PatchedRTCPeerConnection extends NativeRTCPeerConnection {
      constructor(config) {
        super(config);
        console.log("[Bot-Preload] 🎧 Creating new RTCPeerConnection");
        
        this.addEventListener('track', (e) => {
          if (e.track.kind === 'audio') {
            console.log('[Bot-Preload] 🎤 Remote Audio Track Found via Patch!');
            
            // 1. Storage in buffer
            window.__BOT_TRACKS.push(e.track);
            
            // 2. Dispatch event
            window.dispatchEvent(new CustomEvent('bot-remote-track', { detail: { track: e.track } }));
          }
        });
      }
    }
    
    window.RTCPeerConnection = PatchedRTCPeerConnection;
    console.log("[Bot-Preload] ✅ WebRTC Patched in Main World.");
  }
`;

try {
  webFrame.executeJavaScript(patchScript);
} catch (e) {
  console.error("Failed to inject WebRTC patch:", e);
}


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

  /**
   * Sends audio data (Uint8Array) to the main process
   */
  sendAudio: (audioData: Uint8Array) => {
    ipcRenderer.send('bot:audio', audioData);
  },

  /**
   * Log to Electron console
   */
  log: (msg: string) => {
    console.log(msg);
  }
});
