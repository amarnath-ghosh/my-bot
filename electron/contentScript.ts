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


            // 5. Connect WebRTC Tracks Logic
            const processedTracks = new Set<string>();

            const handleTrack = async (track: MediaStreamTrack) => {
                // Ensure we don't process the same track ID twice
                if (processedTracks.has(track.id)) return;
                processedTracks.add(track.id);

                if (track.kind === 'audio') {
                    debugLog(`[Bot-Content] 🎤 Found Remote Audio Track: ${track.id}`);
                    try {
                        const stream = new MediaStream([track]);
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
            };

            // A. Listen for new tracks from the preload patch
            window.addEventListener('bot-remote-track', (e: any) => {
                if (e.detail && e.detail.track) {
                    handleTrack(e.detail.track);
                }
            });

            // B. Process existing buffered tracks that arrived before this script loaded
            const existingTracks = (window as any).__BOT_TRACKS || [];
            if (existingTracks.length > 0) {
                debugLog(`[Bot-Content] Processing ${existingTracks.length} buffered tracks...`);
                existingTracks.forEach(handleTrack);
            }

            debugLog('[Bot-Content] Listening for WebRTC tracks...');

            debugLog('[Bot-Content] Listening for WebRTC tracks...');

            // 6. Handle TTS (Play Audio) - WITH QUEUE
            const api = (window as any).meetingAPI;
            const audioQueue: Float32Array[] = [];
            let isProcessingQueue = false;

            async function processAudioQueue() {
                if (isProcessingQueue || audioQueue.length === 0) return;

                if (!localAudioSender) {
                    debugLog('[Bot-TTS] ❌ Cannot play: No Audio Sender found.');
                    // Don't clear queue immediately, maybe sender will appear? 
                    // But to avoid buildup, maybe we wait or retry?
                    // Let's just return and hope finding logic works.
                    // Actually, if we consume queue without playing, we lose data.
                    // Let's Retry in 1s.
                    setTimeout(processAudioQueue, 1000);
                    return;
                }

                isProcessingQueue = true;
                const pcmData = audioQueue.shift();

                if (!pcmData) {
                    isProcessingQueue = false;
                    return;
                }

                try {
                    debugLog(`[Bot-TTS] 🗣️ Playing chunk of ${pcmData.length} samples...`);
                    // Create context for EACH playback to ensure clean state
                    const playbackCtx = new AudioContext({ sampleRate: 24000 });

                    const buffer = playbackCtx.createBuffer(1, pcmData.length, 24000);
                    buffer.copyToChannel(pcmData as any, 0);

                    const source = playbackCtx.createBufferSource();
                    source.buffer = buffer;

                    const destination = playbackCtx.createMediaStreamDestination();
                    source.connect(destination);

                    const botTrack = destination.stream.getAudioTracks()[0];

                    await localAudioSender.replaceTrack(botTrack);
                    source.start();

                    await new Promise<void>((resolve) => {
                        source.onended = () => resolve();
                    });

                    // Cleanup
                    source.disconnect();
                    await playbackCtx.close();

                } catch (e) {
                    debugLog(`[Bot-TTS] Playback Error: ${e}`);
                } finally {
                    // Restore original mic
                    if (localAudioSender && originalUserTrack) {
                        await localAudioSender.replaceTrack(originalUserTrack).catch((err) => {
                            debugLog(`[Bot-TTS] Error restoring mic: ${err}`);
                        });
                    }

                    isProcessingQueue = false;
                    // Trigger next item
                    processAudioQueue();
                }
            }

            if (api && typeof api.onBotSpeak === 'function') {
                api.onBotSpeak(async (pcmData: Float32Array) => {
                    debugLog(`[Bot-TTS] Received ${pcmData.length} samples. Added to queue.`);
                    audioQueue.push(pcmData);
                    processAudioQueue();
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