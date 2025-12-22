// electron/contentScript.ts

console.log('[ContentScript] 🚀 Injected successfully - AUDIO WORKLET + TTS MODE v3');

(function () {
    if ((window as any).__BOT_INJECTED) return;
    (window as any).__BOT_INJECTED = true;

    function debugLog(msg: string) {
        console.log(msg);
        const api = (window as any).meetingAPI;
        if (api && api.log) {
            api.log(msg);
        }
    }

    // === GLOBAL STATE ===
    let localPeerConnection: RTCPeerConnection | null = null;
    let localAudioSender: RTCRtpSender | null = null;
    let originalUserTrack: MediaStreamTrack | null = null;
    let audioSwapLock = false;
    let activePeerConnections: RTCPeerConnection[] = [];

    // Audio pipeline components (shared across connections)
    let transcriptionAudioContext: AudioContext | null = null;
    let transcriptionWorkletNode: AudioWorkletNode | null = null;

    // === AUDIO PIPELINE SETUP FOR TRANSCRIPTION ===
    async function initAudioPipeline(): Promise<void> {
        try {
            const workletCode = `
        class PCMProcessor extends AudioWorkletProcessor {
          process(inputs, outputs, parameters) {
            const input = inputs[0];
            if (input && input.length > 0) {
              const channelData = input[0];
              if (channelData) {
                this.port.postMessage(channelData);
              }
            }
            return true;
          }
        }
        registerProcessor('pcm-processor', PCMProcessor);
      `;

            transcriptionAudioContext = new AudioContext({ sampleRate: 16000 });
            debugLog(`[ContentScript] Transcription AudioContext created. State: ${transcriptionAudioContext.state}`);

            const blob = new Blob([workletCode], { type: 'application/javascript' });
            const workletUrl = URL.createObjectURL(blob);
            await transcriptionAudioContext.audioWorklet.addModule(workletUrl);
            debugLog('[ContentScript] AudioWorklet module loaded.');

            transcriptionWorkletNode = new AudioWorkletNode(transcriptionAudioContext, 'pcm-processor');

            // Handle audio data from worklet - send to Deepgram
            transcriptionWorkletNode.port.onmessage = (event) => {
                const float32Data = event.data;

                // Convert to Int16 for Deepgram
                const pcmData = new Int16Array(float32Data.length);
                for (let i = 0; i < float32Data.length; i++) {
                    let s = Math.max(-1, Math.min(1, float32Data[i]));
                    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                // Send to Main Process for transcription
                const api = (window as any).meetingAPI;
                if (api && typeof api.sendAudio === 'function') {
                    api.sendAudio(new Uint8Array(pcmData.buffer));
                }
            };

            // Keep node alive by connecting to destination (audio won't actually play)
            transcriptionWorkletNode.connect(transcriptionAudioContext.destination);
            debugLog('[ContentScript] ✅ Audio pipeline initialized for transcription.');

        } catch (e) {
            debugLog(`[ContentScript] ❌ Audio pipeline setup error: ${e}`);
        }
    }

    // Connect a WebRTC audio track to the transcription pipeline
    async function connectTrackToTranscription(track: MediaStreamTrack): Promise<void> {
        if (!transcriptionAudioContext || !transcriptionWorkletNode) {
            debugLog('[ContentScript] Audio pipeline not ready, initializing...');
            await initAudioPipeline();
        }

        if (!transcriptionAudioContext || !transcriptionWorkletNode) {
            debugLog('[ContentScript] ❌ Failed to initialize audio pipeline');
            return;
        }

        try {
            const stream = new MediaStream([track]);
            const source = transcriptionAudioContext.createMediaStreamSource(stream);
            source.connect(transcriptionWorkletNode);
            debugLog('[ContentScript] ✅ Connected remote audio track to transcription pipeline');

            if (transcriptionAudioContext.state === 'suspended') {
                await transcriptionAudioContext.resume();
                debugLog('[ContentScript] Transcription AudioContext resumed.');
            }
        } catch (err) {
            debugLog(`[ContentScript] ❌ Error connecting track to transcription: ${err}`);
        }
    }

    // === PATCH RTCPeerConnection ===
    const NativeRTCPeerConnection = window.RTCPeerConnection;

    class PatchedRTCPeerConnection extends NativeRTCPeerConnection {
        constructor(config?: RTCConfiguration) {
            debugLog('[ContentScript] PatchedRTCPeerConnection constructor called.');
            super(config);

            activePeerConnections.push(this);
            setupConnectionMonitoring(this);

            // Listen for remote audio tracks
            this.addEventListener('track', async (e) => {
                if (e.track.kind === 'audio') {
                    debugLog('[ContentScript] 🎤 Remote Audio Track Found!');

                    // Connect to transcription pipeline
                    await connectTrackToTranscription(e.track);

                    // Capture sender for TTS after a short delay
                    setTimeout(() => this.captureAudioSender(), 500);
                }
            });
        }

        addTrack(track: MediaStreamTrack, ...streams: MediaStream[]) {
            if (track.kind === 'audio') {
                debugLog('[ContentScript] Audio track being added (local mic). Storing references...');
                localPeerConnection = this;

                // Wait briefly for sender to be registered
                setTimeout(() => {
                    const sender = this.getSenders().find((s: RTCRtpSender) => s.track === track);
                    if (sender) {
                        localAudioSender = sender;
                        originalUserTrack = track;
                        debugLog('[ContentScript] ✅ Audio sender and original track stored.');
                    }
                }, 100);
            }
            return super.addTrack(track, ...streams);
        }

        private captureAudioSender() {
            const senders = this.getSenders();
            const sender = senders.find(s => s.track && s.track.kind === 'audio');
            if (sender) {
                debugLog('[ContentScript] ✅ Audio Sender Captured for TTS.');
                localAudioSender = sender;
                originalUserTrack = sender.track;
                localPeerConnection = this;
            } else {
                debugLog('[ContentScript] ⚠️ Audio Sender NOT found yet.');
            }
        }
    }

    // Replace global RTCPeerConnection
    window.RTCPeerConnection = PatchedRTCPeerConnection as any;
    debugLog('[ContentScript] RTCPeerConnection patched.');

    // === CONNECTION MONITORING ===
    function setupConnectionMonitoring(pc: RTCPeerConnection) {
        pc.onconnectionstatechange = () => {
            debugLog(`[ContentScript] Connection state: ${pc.connectionState}`);
            if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
                debugLog('[ContentScript] Connection lost - attempting to find new connection');
                findActivePeerConnectionAndUpdate();
            }
        };
    }

    function findActivePeerConnection(): RTCPeerConnection | null {
        for (let i = activePeerConnections.length - 1; i >= 0; i--) {
            const pc = activePeerConnections[i];
            if (pc.connectionState === 'connected' || pc.connectionState === 'connecting') {
                return pc;
            }
        }
        for (let i = activePeerConnections.length - 1; i >= 0; i--) {
            const pc = activePeerConnections[i];
            if (pc.connectionState !== 'closed') return pc;
        }
        return null;
    }

    function findActivePeerConnectionAndUpdate() {
        const pc = findActivePeerConnection();
        if (pc && pc !== localPeerConnection) {
            debugLog('[ContentScript] New peer connection detected, updating reference');
            localPeerConnection = pc;
            const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
            if (sender) {
                localAudioSender = sender;
                originalUserTrack = sender.track;
            }
            setupConnectionMonitoring(pc);
        }
    }

    function findMediaPeerConnectionWithAudioSender(): { pc: RTCPeerConnection; audioSender: RTCRtpSender } | null {
        for (let i = activePeerConnections.length - 1; i >= 0; i--) {
            const pc = activePeerConnections[i];
            try {
                if (pc.connectionState === 'closed' || pc.connectionState === 'failed') continue;
                const senders = pc.getSenders();
                const audioSender = senders.find(s => s.track?.kind === 'audio');
                if (audioSender) return { pc, audioSender };
            } catch (e) { }
        }
        return null;
    }

    async function waitForAudioSender(maxWaitMs = 3000): Promise<{ pc: RTCPeerConnection; audioSender: RTCRtpSender } | null> {
        const immediate = findMediaPeerConnectionWithAudioSender();
        if (immediate) return immediate;

        return new Promise(resolve => {
            const start = Date.now();
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

    // === TTS AUDIO INJECTION ===

    async function playBotAudioInternal(botAudioTrack: MediaStreamTrack) {
        if (!localPeerConnection ||
            localPeerConnection.connectionState === 'closed' ||
            localPeerConnection.connectionState === 'failed') {
            throw new Error(`Peer connection unavailable: ${localPeerConnection?.connectionState || 'null'}`);
        }

        if ((localPeerConnection as any).signalingState === 'closed') {
            throw new Error('Signaling state is closed');
        }

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
                debugLog(`[ContentScript] Audio swap attempt ${attempt}/${maxRetries}`);

                const found = await waitForAudioSender(2000);
                if (found) {
                    localPeerConnection = found.pc;
                    localAudioSender = found.audioSender;
                    if (!originalUserTrack) {
                        originalUserTrack = found.audioSender.track;
                    }
                }

                await playBotAudioInternal(botAudioTrack);
                debugLog('[ContentScript] ✅ Audio swap successful');
                return;
            } catch (error: any) {
                debugLog(`[ContentScript] ❌ Attempt ${attempt} failed: ${error?.message || error}`);

                if ((error?.message || '').includes('closed') || (error?.message || '').includes('failed')) {
                    findActivePeerConnectionAndUpdate();
                    localPeerConnection = findActivePeerConnection();
                }

                if (attempt < maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        throw new Error('Failed to swap audio after all retry attempts');
    }

    // Main TTS playback function
    const playBotAudio = async (pcmData: Float32Array) => {
        debugLog(`[ContentScript] 🔊 playBotAudio called with ${pcmData.length} samples`);

        if (!pcmData || pcmData.length === 0) {
            debugLog('[ContentScript] ❌ Empty PCM data received.');
            return;
        }

        if (audioSwapLock) {
            debugLog('[ContentScript] ⚠️ Audio swap already in progress.');
            return;
        }

        // Try to find sender if we don't have one
        if (!localAudioSender || !originalUserTrack) {
            debugLog('[ContentScript] Looking for audio sender...');
            const found = await waitForAudioSender(3000);
            if (found) {
                localPeerConnection = found.pc;
                localAudioSender = found.audioSender;
                originalUserTrack = found.audioSender.track;
                debugLog('[ContentScript] ✅ Found audio sender');
            } else {
                debugLog('[ContentScript] ❌ No audio sender found. Cannot inject audio.');
                return;
            }
        }

        let audioContext: AudioContext | null = null;
        let source: AudioBufferSourceNode | null = null;
        let destination: MediaStreamAudioDestinationNode | null = null;

        try {
            audioSwapLock = true;

            // Create AudioContext at 24kHz (must match TTS sample rate)
            audioContext = new AudioContext({ sampleRate: 24000 });

            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            const frameCount = pcmData.length;
            const audioBuffer = audioContext.createBuffer(1, frameCount, 24000);
            audioBuffer.copyToChannel(new Float32Array(pcmData), 0);

            source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            destination = audioContext.createMediaStreamDestination();
            source.connect(destination);

            const botAudioTrack = destination.stream.getAudioTracks()[0];
            debugLog('[ContentScript] 🗣️ Created bot audio track, swapping...');

            source.onended = () => {
                debugLog('[ContentScript] Bot audio finished. Restoring user mic...');

                if (localAudioSender && originalUserTrack) {
                    localAudioSender.replaceTrack(originalUserTrack)
                        .then(() => debugLog('[ContentScript] ✅ User mic restored.'))
                        .catch(err => debugLog(`[ContentScript] ❌ Failed to restore mic: ${err}`));
                }

                botAudioTrack.stop();
                source?.disconnect();
                destination?.disconnect();
                audioContext?.close().catch(() => { });
                audioSwapLock = false;
            };

            await playBotAudioWithRetry(botAudioTrack, 3);
            source.start();
            debugLog('[ContentScript] 🔊 Bot audio playing...');

        } catch (error) {
            debugLog(`[ContentScript] ❌ CRITICAL FAILURE in playBotAudio: ${error}`);

            try {
                const pc = localPeerConnection || findActivePeerConnection();
                if (pc) {
                    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
                    if (sender && originalUserTrack) {
                        await sender.replaceTrack(originalUserTrack);
                        debugLog('[ContentScript] User mic restored after error.');
                    }
                }
            } catch (err) {
                debugLog(`[ContentScript] Failed to restore mic after error: ${err}`);
            }

            audioContext?.close().catch(() => { });
            audioSwapLock = false;
        }
    };

    // === INITIALIZE ===

    // Initialize the audio pipeline immediately
    initAudioPipeline();

    // Listen for bot speak events
    const api = (window as any).meetingAPI;
    if (api && typeof api.onBotSpeak === 'function') {
        api.onBotSpeak((pcmData: Float32Array) => {
            debugLog('[ContentScript] 📢 Received bot-speak event from main process.');
            playBotAudio(pcmData);
        });
        debugLog('[ContentScript] ✅ Attached to window.meetingAPI.onBotSpeak');
    } else {
        debugLog('[ContentScript] ⚠️ window.meetingAPI is not available! Will retry...');
        setTimeout(() => {
            const retryApi = (window as any).meetingAPI;
            if (retryApi && typeof retryApi.onBotSpeak === 'function') {
                retryApi.onBotSpeak((pcmData: Float32Array) => {
                    debugLog('[ContentScript] 📢 Received bot-speak event (retry).');
                    playBotAudio(pcmData);
                });
                debugLog('[ContentScript] ✅ Attached to meetingAPI.onBotSpeak (retry successful)');
            } else {
                debugLog('[ContentScript] ❌ meetingAPI still not available after retry.');
            }
        }, 1000);
    }

    // === AUTO-PILOT: Auto-click join audio buttons ===
    setInterval(() => {
        try {
            if (document.querySelector('button[aria-label="Microphone"]')) return;

            const joinAudio = Array.from(document.querySelectorAll('button'))
                .find(b => b.innerText.includes('Microphone') || b.innerText.includes('Join audio'));
            if (joinAudio) {
                debugLog('[ContentScript] Auto-clicking join audio button...');
                (joinAudio as HTMLButtonElement).click();
            }

            const echoYes = Array.from(document.querySelectorAll('button'))
                .find(b => b.innerText.includes('Yes'));
            if (echoYes) {
                debugLog('[ContentScript] Auto-clicking echo test Yes button...');
                (echoYes as HTMLButtonElement).click();
            }
        } catch (e) { }
    }, 2000);

    debugLog('[ContentScript] 🎉 Initialization complete. Waiting for WebRTC connection...');
})();