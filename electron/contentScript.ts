// electron/contentScript.ts

(function () {
    function debugLog(msg: string) {
        console.log(msg);
        const api = (window as any).meetingAPI;
        if (api && api.log) {
            api.log(msg);
        }
    }

    debugLog('[Bot-Content] 🚀 Injection Successful - AUDIO WORKLET + TTS MODE');

    if ((window as any).__BOT_INJECTED) return;
    (window as any).__BOT_INJECTED = true;

    // Global variables for TTS
    let localAudioSender: RTCRtpSender | null = null;
    let originalUserTrack: MediaStreamTrack | null = null;
    let audioSwapLock = false;

    // 1. Define the Worklet Processor Code
    // This code runs in a separate thread (Audio Worklet)
    const workletCode = `
    class PCMProcessor extends AudioWorkletProcessor {
      process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (input && input.length > 0) {
          const channelData = input[0];
          if (channelData) {
            // Post the Float32Array to the main thread
            this.port.postMessage(channelData);
          }
        }
        return true; // Keep the processor alive
      }
    }
    registerProcessor('pcm-processor', PCMProcessor);
  `;

    async function startAudioPipeline() {
        try {
            const audioContext = new AudioContext({ sampleRate: 16000 });
            debugLog(`[Bot-Audio] AudioContext created. State: ${audioContext.state}`);

            // 2. Load the Worklet
            const blob = new Blob([workletCode], { type: 'application/javascript' });
            const workletUrl = URL.createObjectURL(blob);

            await audioContext.audioWorklet.addModule(workletUrl);
            debugLog('[Bot-Audio] AudioWorklet module loaded.');

            // 3. Create the Node
            const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

            // 4. Handle Audio Data from Worklet (Runs on Main Thread)
            workletNode.port.onmessage = (event) => {
                const float32Data = event.data; // Float32Array

                // Calculate RMS for logging (verify signal)
                let sum = 0;
                for (let i = 0; i < float32Data.length; i++) {
                    sum += float32Data[i] * float32Data[i];
                }
                const rms = Math.sqrt(sum / float32Data.length);

                if (rms > 0.01 && Math.random() < 0.05) {
                    debugLog(`[Bot-Audio] ~ RMS: ${rms.toFixed(4)}`);
                }

                // Convert to Int16 for Deepgram
                const pcmData = new Int16Array(float32Data.length);
                for (let i = 0; i < float32Data.length; i++) {
                    let s = Math.max(-1, Math.min(1, float32Data[i]));
                    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                // Send to Main Process
                const api = (window as any).meetingAPI;
                if (api && typeof api.sendAudio === 'function') {
                    api.sendAudio(new Uint8Array(pcmData.buffer));
                }
            };

            // Keep node alive by connecting to destination (even if silent)
            workletNode.connect(audioContext.destination);
            debugLog('[Bot-Audio] WorkletNode connected to destination.');

            // 5. Connect WebRTC Tracks
            const NativeRTCPeerConnection = window.RTCPeerConnection;
            class PatchedRTCPeerConnection extends NativeRTCPeerConnection {
                constructor(config?: RTCConfiguration) {
                    super(config);
                    this.addEventListener('track', async (e) => {
                        if (e.track.kind === 'audio') {
                            debugLog('[Bot-WebRTC] 🎤 Remote Audio Track Found!');

                            // Capture Sender for TTS
                            setTimeout(() => this.findAudioSender(e.track), 1000);

                            try {
                                const stream = new MediaStream([e.track]);
                                const source = audioContext.createMediaStreamSource(stream);
                                source.connect(workletNode);
                                debugLog('[Bot-Audio] Connected Source -> WorkletNode');

                                if (audioContext.state === 'suspended') {
                                    await audioContext.resume();
                                    debugLog('[Bot-Audio] Context Resumed.');
                                }
                            } catch (err) {
                                debugLog(`[Bot-Audio] Error connecting: ${err}`);
                            }
                        }
                    });
                }

                findAudioSender(track: MediaStreamTrack) {
                    const senders = this.getSenders();
                    const sender = senders.find(s => s.track && s.track.kind === 'audio');
                    if (sender) {
                        debugLog('[Bot-WebRTC] ✅ Audio Sender Captured for TTS.');
                        localAudioSender = sender;
                        originalUserTrack = sender.track;
                    } else {
                        debugLog('[Bot-WebRTC] ⚠️ Audio Sender NOT found yet.');
                    }
                }
            }
            window.RTCPeerConnection = PatchedRTCPeerConnection;
            debugLog('[Bot-Content] WebRTC Patched. Waiting for meeting...');

            // 6. Handle TTS (Play Audio)
            const api = (window as any).meetingAPI;
            if (api && typeof api.onBotSpeak === 'function') {
                api.onBotSpeak(async (pcmData: Float32Array) => {
                    debugLog(`[Bot-TTS] Received ${pcmData.length} samples to play.`);

                    if (!localAudioSender) {
                        debugLog('[Bot-TTS] ❌ Cannot play: No Audio Sender found.');
                        return;
                    }

                    if (audioSwapLock) {
                        debugLog('[Bot-TTS] ⚠️ Already playing, skipping.');
                        return;
                    }
                    audioSwapLock = true;

                    try {
                        // Create a separate context for playback to be safe (or reuse existing if stable)
                        // Let's reuse audioContext since it's working now, but careful with sample rates.
                        // Actually, let's create a new one for playback to avoid mixing sample rates logic
                        const playbackCtx = new AudioContext({ sampleRate: 24000 }); // Typical TTS rate

                        const buffer = playbackCtx.createBuffer(1, pcmData.length, 24000);
                        buffer.copyToChannel(pcmData as any, 0);

                        const source = playbackCtx.createBufferSource();
                        source.buffer = buffer;

                        const destination = playbackCtx.createMediaStreamDestination();
                        source.connect(destination);

                        const botTrack = destination.stream.getAudioTracks()[0];
                        debugLog('[Bot-TTS] 🗣️ Swapping track to Bot Voice...');

                        await localAudioSender.replaceTrack(botTrack);
                        source.start();

                        source.onended = async () => {
                            debugLog('[Bot-TTS] Finished speaking. Restoring mic.');
                            if (localAudioSender && originalUserTrack) {
                                await localAudioSender.replaceTrack(originalUserTrack);
                            }
                            playbackCtx.close();
                            audioSwapLock = false;
                        };

                    } catch (e) {
                        debugLog(`[Bot-TTS] Playback Error: ${e}`);
                        if (localAudioSender && originalUserTrack) {
                            localAudioSender.replaceTrack(originalUserTrack).catch(() => { });
                        }
                        audioSwapLock = false;
                    }
                });
            }

        } catch (e) {
            debugLog(`[Bot-Audio] SETUP ERROR: ${e}`);
        }
    }

    startAudioPipeline();

    // Auto-Pilot
    setInterval(() => {
        try {
            if (document.querySelector('button[aria-label="Microphone"]')) return;
            const joinAudio = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Microphone'));
            if (joinAudio) joinAudio.click();
            const echoYes = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Yes'));
            if (echoYes) echoYes.click();
        } catch (e) { }
    }, 2000);

})();