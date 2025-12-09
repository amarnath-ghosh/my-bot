// electron/contentScript.ts

console.log('[Bot-Content] 🚀 Injection Successful');

(function () {
  let localAudioSender: RTCRtpSender | null = null;
  let originalUserTrack: MediaStreamTrack | null = null;
  let activePeerConnection: RTCPeerConnection | null = null;
  let audioSwapLock = false;

  const NativeRTCPeerConnection = window.RTCPeerConnection;

  class PatchedRTCPeerConnection extends NativeRTCPeerConnection {
    constructor(config?: RTCConfiguration) {
      super(config);
      console.log('[Bot-WebRTC] New PeerConnection created');
      activePeerConnection = this;
      
      this.addEventListener('track', (e) => {
        console.log('[Bot-WebRTC] Track detected:', e.track.kind);
      });
    }

    addTrack(track: MediaStreamTrack, ...streams: MediaStream[]) {
      if (track.kind === 'audio') {
        console.log('[Bot-WebRTC] 🎤 Audio track added via addTrack');
        this.updateAudioSender(track);
      }
      return super.addTrack(track, ...streams);
    }

    addTransceiver(trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) {
      if (trackOrKind instanceof MediaStreamTrack && trackOrKind.kind === 'audio') {
        console.log('[Bot-WebRTC] 🎤 Audio track added via addTransceiver');
        this.updateAudioSender(trackOrKind);
      }
      return super.addTransceiver(trackOrKind, init);
    }

    updateAudioSender(track: MediaStreamTrack) {
        setTimeout(() => {
            const senders = this.getSenders();
            const sender = senders.find(s => s.track === track);
            if (sender) {
                console.log('[Bot-WebRTC] ✅ Audio Sender SECURED.');
                localAudioSender = sender;
                originalUserTrack = track;
            } else {
                const transceivers = this.getTransceivers();
                const t = transceivers.find(t => t.sender.track === track);
                if (t) {
                    console.log('[Bot-WebRTC] ✅ Audio Sender SECURED (via Transceiver).');
                    localAudioSender = t.sender;
                    originalUserTrack = track;
                }
            }
        }, 500);
    }
  }

  window.RTCPeerConnection = PatchedRTCPeerConnection;

  // --- NEW: ACTIVE SPEAKER SCRAPER ---
  const observeSpeakers = () => {
    // Note: Adjust selector '.talking-indicator' based on actual BBB CSS
    const talkingSelector = '[class*="talkingIndicator"]'; 
    
    const observer = new MutationObserver((mutations) => {
      const talkingElements = document.querySelectorAll(talkingSelector);
      talkingElements.forEach(el => {
        // Look for the closest user name container
        const nameEl = el.closest('[class*="userItem"]')?.querySelector('[class*="userName"]');
        if (nameEl && nameEl.textContent) {
          const name = nameEl.textContent.trim();
          // Fixed: Use optional chaining
          if (window.meetingAPI?.sendActiveSpeaker) {
             window.meetingAPI.sendActiveSpeaker(name);
          }
        }
      });
    });

    // Observe body for dynamic changes if specific container isn't ready
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  };
  
  // Start observing after UI load
  setTimeout(observeSpeakers, 5000);

  // --- EXISTING AUDIO LOGIC ---
  const playBotAudio = async (pcmData: Float32Array) => {
    // ... (Existing audio playback logic remains the same) ...
    // Note: Keeping existing logic for brevity, ensure previous logic is retained here.
    console.log(`[Bot-Speaker] Request to play ${pcmData.length} samples`);
    
    if (!localAudioSender && activePeerConnection) {
        const senders = activePeerConnection.getSenders();
        const audioSender = senders.find(s => s.track?.kind === 'audio');
        if (audioSender && audioSender.track) {
            localAudioSender = audioSender;
            originalUserTrack = audioSender.track;
        }
    }

    if (!localAudioSender || !originalUserTrack) return;
    if (audioSwapLock) return;
    audioSwapLock = true;

    let audioCtx: AudioContext | null = null;
    try {
        audioCtx = new AudioContext({ sampleRate: 24000 });
        const buffer = audioCtx.createBuffer(1, pcmData.length, 24000);
        buffer.copyToChannel(pcmData as any, 0);
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        const destination = audioCtx.createMediaStreamDestination();
        source.connect(destination);
        const botTrack = destination.stream.getAudioTracks()[0];
        await localAudioSender.replaceTrack(botTrack);
        source.start();
        source.onended = async () => {
            if (localAudioSender && originalUserTrack) await localAudioSender.replaceTrack(originalUserTrack);
            if (audioCtx) audioCtx.close();
            audioSwapLock = false;
        };
    } catch (e) {
        if (localAudioSender && originalUserTrack) localAudioSender.replaceTrack(originalUserTrack);
        if (audioCtx) (audioCtx as AudioContext).close();
        audioSwapLock = false;
    }
  };

  if (window.meetingAPI && typeof window.meetingAPI.onBotSpeak === 'function') {
    window.meetingAPI.onBotSpeak((pcmData: Float32Array) => {
        playBotAudio(pcmData);
    });
  }

  setInterval(() => {
    const micBtn = Array.from(document.querySelectorAll('button')).find(b => 
       b.getAttribute('aria-label')?.toLowerCase().includes('microphone') || 
       (b.innerText && b.innerText.toLowerCase().includes('microphone'))
    );
    if (micBtn) micBtn.click();

    const echoBtn = Array.from(document.querySelectorAll('button')).find(b => 
        b.getAttribute('aria-label')?.toLowerCase().includes('echo is audible') || 
        (b.innerText && b.innerText.toLowerCase().includes('yes'))
    );
    if (echoBtn) echoBtn.click();
  }, 3000);

})();