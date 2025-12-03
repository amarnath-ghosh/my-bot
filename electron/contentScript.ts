// electron/contentScript.ts

console.log('[ContentScript] Injected successfully.');

(function () {
  let localPeerConnection: RTCPeerConnection | null = null;
  let localAudioSender: RTCRtpSender | null = null;
  let originalUserTrack: MediaStreamTrack | null = null;
  let audioSwapLock = false;
  let botConnectionLost = false;
  let activePeerConnections: RTCPeerConnection[] = [];
  let connectionMonitor: number | null = null;
  // Expose for other helpers / debugging (LiveKit environment detection)
  try { (window as any)._livekitPeerConnections = activePeerConnections; } catch (e) {}

  class PatchedRTCPeerConnection extends window.RTCPeerConnection {
    constructor(config?: RTCConfiguration) {
      console.log('[ContentScript] PatchedRTCPeerConnection constructor called.');
      super(config);

      // Track instances so we can discover a fresh active connection later
      try {
        activePeerConnections.push(this);
        // If we see a new PC right away, set up monitoring on it
        setupConnectionMonitoring(this);

        // Monitor tracks being added to this PC (helps detect media PC in LiveKit)
        try {
          this.addEventListener('track', (evt: any) => {
            try {
              console.log('[ContentScript] track event on PC:', evt.track?.kind, evt.track?.id);
            } catch (e) {}
          });
        } catch (e) {}
      } catch (e) {
        console.warn('[ContentScript] Failed to register peer connection:', e);
      }
    }

    addTrack(track: MediaStreamTrack, ...streams: MediaStream[]) {
      // MODIFIED: Always update when we see a new audio track.
      // This ensures we always have the *latest active* track.
      if (track.kind === 'audio') {
        console.log('[ContentScript] Found an audio track. Updating references...');
        localPeerConnection = this; // Store this peer connection
        
        // We must wait for the track to be added to the senders list.
        // We use a brief timeout to allow the browser to update.
        setTimeout(() => {
          const sender = this.getSenders().find((s: RTCRtpSender) => s.track === track);
          
          if (sender) {
            localAudioSender = sender;
            originalUserTrack = track;
            console.log('[ContentScript] Stored/Updated audio sender and original track.');
            // Ensure monitoring/refresh is running
            setupConnectionMonitoring(this);
            setupConnectionRefreshMonitor();
          } else {
            console.warn('[ContentScript] Could not find sender for the new audio track.');
          }
        }, 100); // 100ms should be enough
      }
      // Call the original (super) method
      return super.addTrack(track, ...streams);
    }
  }

  window.RTCPeerConnection = PatchedRTCPeerConnection;

  // --- Connection monitoring and refresh helpers ---
  function setupConnectionMonitoring(pc: RTCPeerConnection) {
    try {
      pc.onconnectionstatechange = () => {
        console.log('[Bot] Connection state:', pc.connectionState);
        if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
          console.warn('[Bot] Connection lost - flagging for reinitialization');
          botConnectionLost = true;
          // Try to find a new active PC soon
          setTimeout(findActivePeerConnectionAndUpdate, 500);
        }
      };

      pc.onsignalingstatechange = () => {
        console.log('[Bot] Signaling state:', pc.signalingState);
      };

      pc.oniceconnectionstatechange = () => {
        console.log('[Bot] ICE state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed') {
          console.error('[Bot] ICE connection failed');
        }
      };
    } catch (e) {
      console.warn('[Bot] Failed to setup connection monitoring:', e);
    }
  }

  function findActivePeerConnectionAndUpdate() {
    const pc = findActivePeerConnection();
    if (pc && pc !== localPeerConnection) {
      console.log('[Bot] New peer connection detected, updating reference');
      localPeerConnection = pc;
      // try to refresh sender immediately
      try {
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio') || null;
        if (sender) localAudioSender = sender;
      } catch (e) {
        console.warn('[Bot] Could not refresh audio sender:', e);
      }
      setupConnectionMonitoring(pc);
    }
  }

  function setupConnectionRefreshMonitor() {
    if (connectionMonitor) return; // already running
    connectionMonitor = window.setInterval(() => {
      // Remove closed PCs from the list
      activePeerConnections = activePeerConnections.filter(pc => pc.connectionState !== 'closed');

      const current = findActivePeerConnection();
      if (current && current !== localPeerConnection) {
        console.log('[Bot] Detected replaced peer connection - switching refs');
        localPeerConnection = current;
        setupConnectionMonitoring(current);
        try {
          const s = current.getSenders().find(s => s.track?.kind === 'audio');
          if (s) localAudioSender = s;
        } catch (e) {}
      }
    }, 2000);
  }

  function findActivePeerConnection() : RTCPeerConnection | null {
    // Prefer any connection that reports connected
    for (let i = activePeerConnections.length - 1; i >= 0; i--) {
      const pc = activePeerConnections[i];
      if (pc.connectionState === 'connected' || pc.connectionState === 'connecting') return pc;
    }
    // fallback to the latest non-closed
    for (let i = activePeerConnections.length - 1; i >= 0; i--) {
      const pc = activePeerConnections[i];
      if (pc.connectionState !== 'closed') return pc;
    }
    return null;
  }

  // Search all tracked peer connections for one that has an audio sender
  function findMediaPeerConnectionWithAudioSender(): { pc: RTCPeerConnection; audioSender: RTCRtpSender } | null {
    for (let i = activePeerConnections.length - 1; i >= 0; i--) {
      const pc = activePeerConnections[i];
      try {
        if (pc.connectionState === 'closed' || pc.connectionState === 'failed') continue;
        const senders = pc.getSenders();
        if (!senders || senders.length === 0) continue;
        const audioSender = senders.find(s => s.track?.kind === 'audio');
        if (audioSender) return { pc, audioSender };
      } catch (e) {
        // ignore errors reading senders
      }
    }
    return null;
  }

  // Wait until a peer connection with an audio sender appears (useful for LiveKit)
  async function waitForAudioSender(maxWaitMs = 3000): Promise<{ pc: RTCPeerConnection; audioSender: RTCRtpSender } | null> {
    const start = Date.now();
    // fast-path
    const immediate = findMediaPeerConnectionWithAudioSender();
    if (immediate) return immediate;

    return new Promise(resolve => {
      const interval = 200;
      const id = window.setInterval(() => {
        const found = findMediaPeerConnectionWithAudioSender();
        if (found) {
          clearInterval(id);
          resolve(found);
          return;
        }

        if (Date.now() - start > maxWaitMs) {
          clearInterval(id);
          resolve(null);
        }
      }, interval);
    });
  }

  // --- Bot Audio Playback Function (NEW VERSION) ---
  async function playBotAudioInternal(botAudioTrack: MediaStreamTrack) {
    // CRITICAL: Validate connection state IMMEDIATELY before replaceTrack
    if (!localPeerConnection || localPeerConnection.connectionState === 'closed' || localPeerConnection.connectionState === 'failed') {
      throw new Error(`Peer connection unavailable: ${localPeerConnection?.connectionState || 'null'}`);
    }

    if (localPeerConnection.signalingState === 'closed') {
      throw new Error('Signaling state is closed');
    }

    // Get a fresh sender reference immediately before replacing
    const senders = localPeerConnection.getSenders();
    const audioSender = senders.find(s => s.track?.kind === 'audio');

    if (!audioSender) {
      throw new Error('No audio sender found');
    }

    await audioSender.replaceTrack(botAudioTrack);
  }

  async function playBotAudioWithRetry(botAudioTrack: MediaStreamTrack, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Bot] Audio swap attempt ${attempt}/${maxRetries}`);
        // Ensure we target the media peer connection that actually has an audio sender
        const found = await waitForAudioSender(2000);
        if (found) {
          localPeerConnection = found.pc;
          // update localAudioSender reference for diagnostic/legacy usage
          localAudioSender = found.audioSender;
        }

        await playBotAudioInternal(botAudioTrack);
        console.log('[Bot] Audio swap successful');
        return;
      } catch (error: any) {
        console.error(`[Bot] Attempt ${attempt} failed:`, error?.message || error);

        if ((error?.message || '').includes('closed') || (error?.message || '').includes('failed')) {
          // Try to find a new peer connection
          findActivePeerConnectionAndUpdate();
          localPeerConnection = findActivePeerConnection();

          if (!localPeerConnection && attempt === maxRetries) {
            throw new Error('No active peer connection available');
          }
        }

        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error('Failed to swap audio after all retry attempts');
  }

  const playBotAudio = async (pcmData: Float32Array) => {
    console.log('[ContentScript-Debug] 1. playBotAudio START (with PCM data)');
    
    if (!originalUserTrack) {
      console.error('[ContentScript-Debug] 1-ERROR. No original user track. Aborting.');
      return;
    }
    
    if (!pcmData || pcmData.length === 0) {
      console.error('[ContentScript-Debug] 1-ERROR. Received empty PCM data. Aborting.');
      return;
    }

    let audioContext: AudioContext | null = null;
    let source: AudioBufferSourceNode | null = null;
    let destination: MediaStreamAudioDestinationNode | null = null;

    try {
      // 1. Create AudioContext at the correct sample rate
      console.log('[ContentScript-Debug] 2. Creating new AudioContext at 24000Hz...');
      audioContext = new AudioContext({ sampleRate: 24000 });
      console.log(`[ContentScript-Debug] 3. AudioContext created. State: ${audioContext.state}`);
      
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
        console.log(`[ContentScript-Debug] 5. AudioContext resumed. State: ${audioContext.state}`);
      }

      // 2. Create a blank AudioBuffer
      const frameCount = pcmData.length;
      console.log(`[ContentScript-Debug] 6. Creating blank AudioBuffer for ${frameCount} frames...`);
      const audioBuffer = audioContext.createBuffer(1, frameCount, 24000);

      // 3. Copy our received PCM data into the buffer
      console.log('[ContentScript-Debug] 7. Copying PCM data into AudioBuffer...');
      audioBuffer.copyToChannel(new Float32Array(pcmData), 0);
      console.log('[ContentScript-Debug] 8. PCM data copied.');

      // 4. Create source and destination
      source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      destination = audioContext.createMediaStreamDestination();
      source.connect(destination);
      
  const botAudioTrack = destination.stream.getAudioTracks()[0];
      console.log('[ContentScript-Debug] 9. Bot audio track created from buffer.');

      // 5. Set up onended handler
      source.onended = () => {
        console.log('[ContentScript-Debug] 12. [onended] Bot audio finished. Restoring user mic...');
        if (localAudioSender && originalUserTrack) {
          localAudioSender.replaceTrack(originalUserTrack)
            .then(() => console.log('[ContentScript-Debug] 13. [onended] User mic restored.'))
            .catch(err => console.error('[ContentScript-Debug] 13-ERROR. [onended] Failed to restore user mic:', err));
        }
        // Cleanup
        botAudioTrack.stop();
        source?.disconnect();
        destination?.disconnect();
        audioContext?.close().catch(e => console.error('[ContentScript-Debug] 14. [onended] Error closing AudioContext', e));
      };
      console.log('[ContentScript-Debug] 9a. onended handler attached.');

      // 6. Swap track and play (with locking + retry)
      console.log('[ContentScript-Debug] 10. Swapping to bot audio track (with lock/retry)...');

      if (audioSwapLock) {
        console.warn('[ContentScript-Debug] Audio swap already in progress. Aborting this attempt.');
        // cleanup
        botAudioTrack.stop();
        source.disconnect();
        destination.disconnect();
        audioContext.close().catch(() => {});
        return;
      }

      audioSwapLock = true;
      try {
        await playBotAudioWithRetry(botAudioTrack, 3);
        console.log('[ContentScript-Debug] 11. Track swapped. Starting playback...');
        source.start();
      } finally {
        audioSwapLock = false;
      }

    } catch (error) {
      console.error('[ContentScript-Debug] 99-ERROR. CRITICAL FAILURE in playBotAudio:', error);
        // Restore original mic safely (refresh sender reference first)
        try {
          const pc = localPeerConnection || findActivePeerConnection();
          if (pc) {
            const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
            if (sender && originalUserTrack) {
              await sender.replaceTrack(originalUserTrack);
              console.log('[ContentScript-Debug] 13. [onended] User mic restored.');
            }
          }
        } catch (err) {
          console.error('[ContentScript-Debug] 13-ERROR. [onended] Failed to restore user mic:', err);
        }
      audioContext?.close().catch(e => console.error('[ContentScript-Debug] 99-ERROR. Error closing AudioContext', e));
    }
  };

  // --- Listen for events from preload ---
  if (window.meetingAPI && typeof window.meetingAPI.onBotSpeak === 'function') {
    window.meetingAPI.onBotSpeak((pcmData: Float32Array) => {
      console.log('[ContentScript] Received bot-speak event with PCM data.');
      playBotAudio(pcmData);
    });
    console.log('[ContentScript] Attached to window.meetingAPI.onBotSpeak');
  } else {
    console.error('[ContentScript] window.meetingAPI is not available!');
  }
})();

//
// ... (Your existing audio injection code remains above) ...

// --- AUTO-PILOT FOR BIGBLUEBUTTON UI ---
(function runAutoPilot() {
  console.log('[Bot] Auto-Pilot Engaged: Scanning for Audio Buttons...');
  
  const checkAndClick = () => {
    // 1. Join Audio Modal -> Click "Microphone"
    // BBB usually uses aria-labels or specific classes. We check generically.
    const buttons = Array.from(document.querySelectorAll('button'));
    
    const micBtn = buttons.find(b => 
      b.getAttribute('aria-label')?.includes('Microphone') || 
      b.innerText.includes('Microphone')
    );

    if (micBtn) {
      console.log('[Bot] Clicking Microphone...');
      micBtn.click();
    }

    // 2. Echo Test Modal -> Click "Yes" / "Thumbs Up"
    const echoYesBtn = buttons.find(b => 
      b.getAttribute('aria-label')?.includes('Echo is audible') || 
      b.innerText.includes('Yes')
    );

    if (echoYesBtn) {
      console.log('[Bot] Clicking Echo Test Confirmation...');
      echoYesBtn.click();
    }
  };

  // Run this check every 2 seconds to catch modals whenever they appear
  setInterval(checkAndClick, 2000);
})();