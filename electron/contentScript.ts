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
                // Fallback: check transceivers if sender not found directly
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

  const playBotAudio = async (pcmData: Float32Array) => {
    console.log(`[Bot-Speaker] Request to play ${pcmData.length} samples`);

    if (!localAudioSender && activePeerConnection) {
        // Emergency Scan
        const senders = activePeerConnection.getSenders();
        const audioSender = senders.find(s => s.track?.kind === 'audio');
        if (audioSender && audioSender.track) {
            console.log('[Bot-Speaker] Emergency scan found audio sender!');
            localAudioSender = audioSender;
            originalUserTrack = audioSender.track;
        }
    }

    if (!localAudioSender || !originalUserTrack) {
        console.error('[Bot-Speaker] ❌ FAILURE: No audio connection found. Is the mic on?');
        return;
    }

    if (audioSwapLock) return;
    audioSwapLock = true;

    let audioCtx: AudioContext | null = null;

    try {
        audioCtx = new AudioContext({ sampleRate: 24000 });
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }
        
        const buffer = audioCtx.createBuffer(1, pcmData.length, 24000);
        buffer.copyToChannel(pcmData as any, 0);

        const source = audioCtx.createBufferSource();
        source.buffer = buffer;

        const destination = audioCtx.createMediaStreamDestination();
        source.connect(destination);
        const botTrack = destination.stream.getAudioTracks()[0];

        console.log('[Bot-Speaker] 🗣️ Swapping tracks to SPEAK...');
        await localAudioSender.replaceTrack(botTrack);
        
        source.start();

        source.onended = async () => {
            console.log('[Bot-Speaker] Finished. Restoring microphone.');
            if (localAudioSender && originalUserTrack) {
                await localAudioSender.replaceTrack(originalUserTrack).catch(e => console.error('Restore failed', e));
            }
            if (audioCtx) audioCtx.close();
            audioSwapLock = false;
        };

    } catch (e) {
        console.error('[Bot-Speaker] Error during playback:', e);
        if (localAudioSender && originalUserTrack) {
            localAudioSender.replaceTrack(originalUserTrack).catch(() => {});
        }
        if (audioCtx) (audioCtx as AudioContext).close();
        audioSwapLock = false;
    }
  };

  if (window.meetingAPI && typeof window.meetingAPI.onBotSpeak === 'function') {
    window.meetingAPI.onBotSpeak((pcmData: Float32Array) => {
        playBotAudio(pcmData);
    });
  }

  // Auto-Pilot to Click "Microphone" and "Yes"
  setInterval(() => {
    const micBtn = Array.from(document.querySelectorAll('button')).find(b => 
       b.getAttribute('aria-label')?.toLowerCase().includes('microphone') || 
       (b.innerText && b.innerText.toLowerCase().includes('microphone'))
    );
    if (micBtn) { console.log('[Auto-Pilot] Clicking Microphone'); micBtn.click(); }

    const echoBtn = Array.from(document.querySelectorAll('button')).find(b => 
        b.getAttribute('aria-label')?.toLowerCase().includes('echo is audible') || 
        (b.innerText && b.innerText.toLowerCase().includes('yes'))
    );
    if (echoBtn) { console.log('[Auto-Pilot] Clicking Yes'); echoBtn.click(); }
  }, 3000);

})();